"""Apple settings: GET/PUT/DELETE /api/apple, with App Store Connect faked."""

import base64
import datetime as dt
import json

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from sqlalchemy import select, update

from serversherpa_devices.api.routes.apple import get_asc_http
from serversherpa_devices.apple.settings import load_credentials
from serversherpa_devices.db.models import App, AppleSettings, IosProfile, Job
from serversherpa_devices.services.secrets import unseal

from .catalog_support import audits
from .fake_asc import ISSUER_ID, KEY_ID, OTHER_P8, TEAM_ID, TEST_P8, FakeAsc
from .fake_main_api import PERSON_ID

DIST_CN = f"Apple Distribution: Test ({TEAM_ID})"
PASSWORD = "correct horse"
SERIAL = 0x07D2A0F1C3
EXPIRES = dt.datetime(2027, 6, 1, 12, 0, tzinfo=dt.UTC)
_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def make_p12(*, common_name: str = DIST_CN, password: str = PASSWORD,
             serial: int = SERIAL) -> bytes:
    subject = x509.Name([
        x509.NameAttribute(NameOID.USER_ID, TEAM_ID),
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEAM_ID),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Test"),
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
    ])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(_KEY.public_key()).serial_number(serial)
            .not_valid_before(EXPIRES - dt.timedelta(days=365)).not_valid_after(EXPIRES)
            .sign(_KEY, hashes.SHA256()))
    return pkcs12.serialize_key_and_certificates(
        b"Test", _KEY, cert, None,
        serialization.BestAvailableEncryption(password.encode()))


P12 = make_p12()


@pytest.fixture
def asc(devices_app):
    fake = FakeAsc()

    async def http():
        async with fake.http() as client:
            yield client

    devices_app.dependency_overrides[get_asc_http] = http
    return fake


async def put_apple(api, *, p8: bytes | None = TEST_P8, p12: bytes | None = P12,
                    password: str | None = PASSWORD, **fields):
    data = {"team_id": TEAM_ID, "issuer_id": ISSUER_ID, "key_id": KEY_ID, **fields}
    if password is not None:
        data["p12_password"] = password
    files = {}
    if p8 is not None:
        files["p8"] = (f"AuthKey_{KEY_ID}.p8", p8, "application/octet-stream")
    if p12 is not None:
        files["p12"] = ("distribution.p12", p12, "application/x-pkcs12")
    return await api.put("/api/apple", data=data, files=files or None)


def _message(response) -> str:
    return response.json()["detail"]["message"]


async def _row(db) -> AppleSettings | None:
    return await db.scalar(select(AppleSettings).execution_options(populate_existing=True))


def _sealed(row: AppleSettings) -> tuple[bytes, bytes, bytes]:
    return row.p8_enc, row.p12_enc, row.p12_password_enc


async def test_put_apple_rejects_wrong_password(api, asc, db):
    asc.add_certificate("07D2A0F1C3")
    r = await put_apple(api, password="wrong")
    assert r.status_code == 422
    assert _message(r) == "The certificate password is wrong."
    assert await _row(db) is None
    assert asc.calls == []


async def test_put_apple_rejects_development_cert(api, asc, db):
    asc.add_certificate("07D2A0F1C3")
    r = await put_apple(api, p12=make_p12(common_name=f"Apple Development: Test ({TEAM_ID})"))
    assert r.status_code == 422
    assert "Apple Distribution" in _message(r)
    assert await _row(db) is None
    assert asc.calls == []

    # The older name for the same kind of certificate is accepted.
    r = await put_apple(api, p12=make_p12(common_name=f"iPhone Distribution: Test ({TEAM_ID})"))
    assert r.status_code == 200, r.text


async def test_put_apple_saves_sealed_and_never_returns_secrets(api, asc, main_fake, db):
    cert_id = asc.add_certificate("07D2A0F1C3")   # Apple's copy has a leading zero
    r = await put_apple(api)
    assert r.status_code == 200, r.text
    saved = r.json()

    r = await api.get("/api/apple")
    assert r.status_code == 200
    body = r.json()
    assert body == saved
    assert set(body) == {"configured", "team_id", "key_id", "issuer_id", "cert_name",
                         "cert_expires_at", "profiles", "ios_owner_url"}
    assert body["configured"] is True
    assert (body["team_id"], body["key_id"], body["issuer_id"]) == (TEAM_ID, KEY_ID, ISSUER_ID)
    assert body["cert_name"] == DIST_CN
    assert dt.datetime.fromisoformat(body["cert_expires_at"]) == EXPIRES
    assert body["profiles"] == []
    assert body["ios_owner_url"] is None
    assert PASSWORD not in r.text and "PRIVATE KEY" not in r.text

    row = await _row(db)
    assert row.p8_enc != TEST_P8 and TEST_P8 not in row.p8_enc
    assert row.p12_enc != P12 and P12 not in row.p12_enc
    assert PASSWORD.encode() not in row.p12_password_enc
    assert unseal(row.p8_enc) == TEST_P8
    assert unseal(row.p12_enc) == P12
    assert unseal(row.p12_password_enc) == PASSWORD.encode()
    assert (row.cert_serial, row.asc_certificate_id) == ("7D2A0F1C3", cert_id)
    assert (row.updated_by, row.updated_by_name) == (PERSON_ID, "Pat Example")
    creds = await load_credentials(db)
    assert (creds.team_id, creds.key_id, creds.issuer_id) == (TEAM_ID, KEY_ID, ISSUER_ID)
    assert (creds.p8, creds.p12, creds.p12_password) == (TEST_P8, P12, PASSWORD)
    assert creds.asc_certificate_id == cert_id

    entries = audits(main_fake)
    assert [(e["entity_type"], e["entity_id"], e["action"]) for e in entries] == [
        ("appdist_apple", "apple", "update")]
    logged = json.dumps(entries[0]["changes"])
    assert PASSWORD not in logged and "PRIVATE KEY" not in logged
    assert base64.b64encode(P12).decode()[:40] not in logged
    assert entries[0]["changes"]["key_id"] == {"from": None, "to": KEY_ID}


async def test_later_save_keeps_stored_files(api, asc, main_fake, db):
    asc.add_certificate("7D2A0F1C3")
    assert (await put_apple(api)).status_code == 200
    before = _sealed(await _row(db))
    main_fake.audit_route.reset()
    checks = len(asc.calls)

    r = await put_apple(api, p8=None, p12=None, password=None)
    assert r.status_code == 200, r.text
    assert _sealed(await _row(db)) == before
    assert len(asc.calls) > checks   # checked with Apple again
    assert audits(main_fake) == []   # nothing changed, nothing audited

    # A new certificate alone: the key stays, the change is audited.
    new_cert = asc.add_certificate("BEEF01")
    r = await put_apple(api, p8=None, p12=make_p12(serial=0xBEEF01))
    assert r.status_code == 200, r.text
    after = await _row(db)
    p8_enc, p12_enc, password_enc = before
    assert (after.p8_enc, after.p12_password_enc) == (p8_enc, password_enc)
    assert after.p12_enc != p12_enc
    assert after.asc_certificate_id == new_cert
    changes = audits(main_fake)[0]["changes"]
    assert changes["cert_serial"] == {"from": "7D2A0F1C3", "to": "BEEF01"}
    assert changes["replaced"] == ["p12"]   # same password, so only the file

    # A new certificate needs its password.
    r = await put_apple(api, password=None)
    assert r.status_code == 422
    assert _message(r) == "Add the missing parts: Certificate password."


async def _rebuilds(db) -> list[Job]:
    return list((await db.scalars(
        select(Job).where(Job.kind == "rebuild_profiles")
        .execution_options(populate_existing=True))).all())


async def test_saving_changed_settings_rebuilds_profiles(api, asc, db):
    """A replaced certificate (it lasts a year) must reach every profile and
    every signed build: a save that changes anything queues a rebuild, whose
    new profiles re-sign each app (final review, I2)."""
    asc.add_certificate("7D2A0F1C3")
    assert (await put_apple(api)).status_code == 200
    assert len(await _rebuilds(db)) == 1   # the first save: there may be apps to sign

    # Saved again unchanged: nothing to redo.
    await db.execute(update(Job).values(status="done"))
    await db.commit()
    assert (await put_apple(api, p8=None, p12=None, password=None)).status_code == 200
    assert [j.status for j in await _rebuilds(db)] == ["done"]

    # A new certificate: profiles are made again against it.
    new_cert = asc.add_certificate("BEEF01")
    r = await put_apple(api, p8=None, p12=make_p12(serial=0xBEEF01))
    assert r.status_code == 200, r.text
    rebuilds = await _rebuilds(db)
    assert [j.status for j in rebuilds] == ["done", "queued"]
    assert (await _row(db)).asc_certificate_id == new_cert

    # A new team ID, too.
    await db.execute(update(Job).values(status="done"))
    await db.commit()
    r = await put_apple(api, p8=None, p12=None, password=None, team_id="TEAM999999")
    assert r.status_code == 200, r.text
    assert [j.status for j in await _rebuilds(db)] == ["done", "done", "queued"]


async def test_first_save_requires_every_part(api, asc, db):
    r = await put_apple(api, p8=None, password=None, key_id="")
    assert r.status_code == 422
    assert _message(r) == ("Add the missing parts: Key ID, API key (.p8), "
                           "Certificate password.")
    assert await _row(db) is None
    assert asc.calls == []


async def test_put_apple_reports_refused_key(api, asc, db):
    asc.add_certificate("7D2A0F1C3")
    r = await put_apple(api, p8=OTHER_P8)
    assert r.status_code == 422
    assert _message(r).startswith("Apple refused the API key: Provide a properly configured")

    asc.refuse("This API key can't use the provisioning APIs.")
    r = await put_apple(api)
    assert r.status_code == 422
    assert _message(r) == ("Apple refused the API key: "
                           "This API key can't use the provisioning APIs.")
    assert await _row(db) is None

    r = await put_apple(api, p8=b"not a key")
    assert r.status_code == 422
    assert _message(r) == "The API key (.p8) can't be read."


async def test_put_apple_rejects_certificate_apple_does_not_list(api, asc, db):
    asc.add_certificate("7D2A0F1C3", certificate_type="DEVELOPMENT")
    asc.add_certificate("ABCDEF")
    r = await put_apple(api)
    assert r.status_code == 422
    assert _message(r) == f"Apple doesn't list this certificate on team {TEAM_ID}."
    assert await _row(db) is None


async def test_delete_apple_needs_confirm_and_clears(api, asc, main_fake, db):
    asc.add_certificate("7D2A0F1C3")
    assert (await put_apple(api)).status_code == 200
    main_fake.audit_route.reset()

    r = await api.request("DELETE", "/api/apple", json={"confirm": "yes"})
    assert r.status_code == 422
    assert await _row(db) is not None

    r = await api.request("DELETE", "/api/apple", json={"confirm": "clear"})
    assert r.status_code == 204
    assert await _row(db) is None
    body = (await api.get("/api/apple")).json()
    assert body["configured"] is False
    assert body["team_id"] is None and body["cert_name"] is None
    entries = audits(main_fake)
    assert [(e["entity_type"], e["entity_id"], e["action"]) for e in entries] == [
        ("appdist_apple", "apple", "clear")]
    assert entries[0]["changes"]["key_id"] == {"from": KEY_ID, "to": None}


async def test_get_apple_lists_profiles(api, db):
    app = App(platform="ios", identifier="com.example.hello", name="Hello Display")
    db.add(app)
    await db.flush()
    db.add(IosProfile(app_id=app.id, asc_profile_id="PROF1", uuid="u-1", content=b"x",
                      expires_at=EXPIRES))
    await db.commit()

    body = (await api.get("/api/apple")).json()
    assert body["configured"] is False
    assert [(p["app_name"], dt.datetime.fromisoformat(p["expires_at"]))
            for p in body["profiles"]] == [("Hello Display", EXPIRES)]


async def test_staff_cannot_read_apple_settings(api, asc, main_fake, db):
    main_fake.as_staff()
    assert (await api.get("/api/apple")).status_code == 403
    assert (await put_apple(api)).status_code == 403
    r = await api.request("DELETE", "/api/apple", json={"confirm": "clear"})
    assert r.status_code == 403
    assert asc.calls == []
