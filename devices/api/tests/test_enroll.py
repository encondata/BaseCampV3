"""Add this iPhone: POST /api/enroll, the Profile Service .mobileconfig, and
iOS's signed callback. Callback bodies are a self-signed CMS SignedData
around a plist, as iOS sends them."""

import asyncio
import datetime as dt
import hashlib
import logging
import plistlib
import uuid
from urllib.parse import urlsplit

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import pkcs7
from cryptography.x509.oid import NameOID
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update

from serversherpa_devices import catalog
from serversherpa_devices.db.models import EnrollToken, IosDevice

from .catalog_support import audits
from .fake_main_api import PERSON_ID

OTHER_ID = uuid.UUID("5d0c8a3e-2b71-4f6a-8e09-3c4b5a6d7e8f")

UDID = "00008110-000A1B2C3D4E5F60"
EXPIRED_COPY = "This link has expired. Go back to Devices and tap Add this iPhone again."
_KEY = ec.generate_private_key(ec.SECP256R1())
_SUBJECT = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Device Identity")])
_NOW = dt.datetime.now(dt.UTC)
_CERT = (x509.CertificateBuilder().subject_name(_SUBJECT).issuer_name(_SUBJECT)
         .public_key(_KEY.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(_NOW - dt.timedelta(days=1))
         .not_valid_after(_NOW + dt.timedelta(days=365))
         .sign(_KEY, hashes.SHA256()))


def signed(data: bytes) -> bytes:
    """`data` wrapped the way iOS wraps its answer: CMS SignedData, DER."""
    return (pkcs7.PKCS7SignatureBuilder().set_data(data)
            .add_signer(_CERT, _KEY, hashes.SHA256())
            .sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.Binary]))


def attributes(token: str | None, **fields) -> dict:
    found = {"UDID": UDID, "PRODUCT": "iPhone14,5", "VERSION": "22B83",
             "SERIAL": "F2LXK0Q1N7", "DEVICE_NAME": "iPhone"}
    if token is not None:
        found["CHALLENGE"] = token
    found.update(fields)
    return {k: v for k, v in found.items() if v is not None}


def callback_body(token: str | None, **fields) -> bytes:
    return signed(plistlib.dumps(attributes(token, **fields)))


@pytest.fixture
async def anonymous(devices_app):
    """No Authorization header: what Safari and iOS send."""
    async with AsyncClient(transport=ASGITransport(app=devices_app),
                           base_url="http://testserver") as client:
        yield client


@pytest.fixture
def queued(monkeypatch):
    jobs: list[tuple[str, dict]] = []
    monkeypatch.setattr(catalog, "enqueue",
                        lambda session, kind, payload: jobs.append((kind, payload)))
    return jobs


async def new_link(api, name: str = "Pat's iPhone") -> str:
    """POST /api/enroll; the token in the returned URL."""
    r = await api.post("/api/enroll", json={"device_name": name})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert url.startswith("/enroll/") and url.endswith(".mobileconfig"), url
    return url.removeprefix("/enroll/").removesuffix(".mobileconfig")


async def call_back(anonymous, token: str, body: bytes):
    return await anonymous.post(f"/enroll/{token}/callback", content=body,
                                headers={"Content-Type": "application/pkcs7-signature"})


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def devices(db) -> list[IosDevice]:
    db.expire_all()
    return (await db.scalars(select(IosDevice))).all()


# POST /api/enroll and the .mobileconfig


async def test_mobileconfig_contents_and_headers(api, anonymous, db):
    token = await new_link(api)
    assert len(token) >= 43   # 32 random bytes, URL-safe base64

    row = await db.get(EnrollToken, token_hash(token))
    assert row is not None
    assert row.person_id == PERSON_ID
    assert row.person_name == "Pat Example"
    assert row.device_name == "Pat's iPhone"
    assert row.used_at is None
    assert row.can_reenable and row.can_update_existing   # an admin: delete and change
    left = row.expires_at - dt.datetime.now(dt.UTC)
    assert dt.timedelta(minutes=14) < left <= dt.timedelta(minutes=15)
    # Only the hash is stored.
    assert (await db.scalar(select(func.count()).select_from(EnrollToken)
                            .where(EnrollToken.token_hash == token))) == 0

    r = await anonymous.get(f"/enroll/{token}.mobileconfig")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/x-apple-aspen-config"
    assert r.headers["content-disposition"] == 'attachment; filename="add-this-iphone.mobileconfig"'
    assert r.headers["cache-control"] == "no-store"
    profile = plistlib.loads(r.content)
    assert profile["PayloadType"] == "Profile Service"
    assert profile["PayloadVersion"] == 1
    assert profile["PayloadDisplayName"] == "ServerSherpa Devices — add this iPhone"
    assert profile["PayloadOrganization"] == "ServerSherpa"
    assert profile["PayloadIdentifier"] == "com.serversherpa.devices.enroll"
    assert profile["PayloadDescription"]
    uuid.UUID(profile["PayloadUUID"])
    assert profile["PayloadContent"] == {
        "URL": f"https://devices.test/enroll/{token}/callback",
        "DeviceAttributes": ["UDID", "PRODUCT", "VERSION", "SERIAL", "DEVICE_NAME"],
        "Challenge": token,
    }

    again = plistlib.loads((await anonymous.get(f"/enroll/{token}.mobileconfig")).content)
    assert again["PayloadUUID"] != profile["PayloadUUID"]   # a fresh one each time


async def test_enroll_needs_view_and_a_name(api, main_fake, db):
    for name in ("", "   ", "x" * 61, "Pat\x00s", "Pat\ns"):
        r = await api.post("/api/enroll", json={"device_name": name})
        assert r.status_code == 422, name
    assert (await api.post("/api/enroll", json={})).status_code == 422
    assert (await api.post("/api/enroll", json={"device_name": "x" * 60})).status_code == 200

    main_fake.as_staff(actions=[])
    assert (await api.post("/api/enroll", json={"device_name": "Phone"})).status_code == 403
    main_fake.as_kiosk()
    assert (await api.post("/api/enroll", json={"device_name": "Phone"})).status_code == 403
    main_fake.as_staff(read_only=True, read_only_message="Back at 18:00.")
    r = await api.post("/api/enroll", json={"device_name": "Phone"})
    assert r.status_code == 423
    assert (await db.scalar(select(func.count()).select_from(EnrollToken))) == 1


async def test_mobileconfig_expired_token_410(api, anonymous, db, queued):
    expired = await new_link(api)
    await db.execute(update(EnrollToken).where(EnrollToken.token_hash == token_hash(expired))
                     .values(expires_at=dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)))
    await db.commit()
    used = await new_link(api)
    assert (await call_back(anonymous, used, callback_body(used))).status_code == 301

    for token in (expired, used, "not-a-real-token"):
        r = await anonymous.get(f"/enroll/{token}.mobileconfig")
        assert r.status_code == 410, token
        assert r.headers["content-type"].startswith("text/html")
        assert EXPIRED_COPY in r.text

    # The expired link's callback is refused too.
    r = await call_back(anonymous, expired,
                        callback_body(expired, UDID="00008110-0000000000000001"))
    assert r.status_code == 410
    assert EXPIRED_COPY in r.text
    assert len(await devices(db)) == 1


# The callback


async def test_callback_creates_pending_device_and_job(api, anonymous, db, queued, main_fake):
    token = await new_link(api)
    r = await call_back(anonymous, token, callback_body(token))
    assert r.status_code == 301, r.text

    [device] = await devices(db)
    assert r.headers["location"] == f"https://devices.test/?added={device.id}"
    assert device.udid == UDID
    assert device.name == "Pat's iPhone"
    assert device.product == "iPhone14,5"
    assert device.os_version == "22B83"
    assert device.serial == "F2LXK0Q1N7"
    assert device.added_by == PERSON_ID
    assert device.added_by_name == "Pat Example"
    assert device.status == "pending"
    assert device.error is None

    row = await db.get(EnrollToken, token_hash(token))
    await db.refresh(row)
    assert row.used_at is not None
    assert queued == [("register_device", {"device_id": str(device.id)})]

    [audit] = [a for a in audits(main_fake) if a["entity_type"] == "appdist_device"]
    assert audit["actor_person_id"] == str(PERSON_ID)
    assert audit["entity_id"] == str(device.id)
    assert audit["action"] == "add"
    assert audit["changes"]["name"] == {"from": None, "to": "Pat's iPhone"}
    assert audit["changes"]["product"] == {"from": None, "to": "iPhone14,5"}
    assert audit["changes"]["os_version"] == {"from": None, "to": "22B83"}
    assert UDID not in str(audit) and "F2LXK0Q1N7" not in str(audit)


async def test_callback_same_udid_reuses_device(api, anonymous, db, queued):
    first = await new_link(api)
    assert (await call_back(anonymous, first, callback_body(first))).status_code == 301
    [device] = await devices(db)
    await db.execute(update(IosDevice).where(IosDevice.id == device.id)
                     .values(status="registered", asc_device_id="ASC123"))
    await db.commit()

    second = await new_link(api, "Pat's work iPhone")
    r = await call_back(anonymous, second, callback_body(second, VERSION="22C152",
                                                         PRODUCT="iPhone14,6", SERIAL=None))
    assert r.status_code == 301
    assert r.headers["location"] == f"https://devices.test/?added={device.id}"
    [again] = await devices(db)
    assert again.id == device.id
    assert again.status == "registered"
    assert again.asc_device_id == "ASC123"
    assert again.name == "Pat's work iPhone"
    assert again.product == "iPhone14,6"
    assert again.os_version == "22C152"
    assert again.serial == "F2LXK0Q1N7"   # an answer without SERIAL keeps the known one
    assert queued == [("register_device", {"device_id": str(device.id)})] * 2


async def disable(db, device: IosDevice) -> None:
    await db.execute(update(IosDevice).where(IosDevice.id == device.id)
                     .values(status="disabled", asc_device_id="ASC123"))
    await db.commit()


async def test_admin_token_reenables_disabled_device(api, anonymous, db, queued):
    first = await new_link(api)
    assert (await call_back(anonymous, first, callback_body(first))).status_code == 301
    [device] = await devices(db)
    await disable(db, device)

    second = await new_link(api)
    assert (await call_back(anonymous, second, callback_body(second))).status_code == 301
    [again] = await devices(db)
    assert again.id == device.id
    assert again.status == "pending"
    assert queued[-1] == ("register_device", {"device_id": str(device.id)})


async def test_staff_cannot_reenable_disabled_device(api, anonymous, db, queued, main_fake):
    first = await new_link(api)
    assert (await call_back(anonymous, first, callback_body(first))).status_code == 301
    [device] = await devices(db)
    await disable(db, device)
    audited_before = len(audits(main_fake))

    main_fake.as_staff()   # the same person, now holding only view
    second = await new_link(api, "Renamed")
    row = await db.get(EnrollToken, token_hash(second))
    assert not row.can_reenable and not row.can_update_existing
    r = await call_back(anonymous, second, callback_body(second, VERSION="22C152"))
    assert r.status_code == 301
    assert r.headers["location"] == f"https://devices.test/?added={device.id}"

    [again] = await devices(db)
    assert (again.status, again.name, again.os_version, again.asc_device_id) == (
        "disabled", "Pat's iPhone", "22B83", "ASC123")
    await db.refresh(row)
    assert row.used_at is not None
    assert len(queued) == 1   # only the first enrollment's
    [audit] = audits(main_fake)[audited_before:]
    assert audit["action"] == "add_refused_disabled"
    assert audit["entity_id"] == str(device.id)
    assert audit["changes"] == {}


async def test_other_staff_cannot_rename_existing_device(api, anonymous, db, queued, main_fake):
    first = await new_link(api)
    assert (await call_back(anonymous, first, callback_body(first))).status_code == 301
    [device] = await devices(db)

    main_fake.as_staff(person_id=str(OTHER_ID), display_name="Sam Other")
    second = await new_link(api, "Sam's iPhone")
    r = await call_back(anonymous, second, callback_body(second, VERSION="22C152",
                                                         PRODUCT="iPhone14,6"))
    assert r.status_code == 301
    [again] = await devices(db)
    assert (again.name, again.product, again.os_version, again.added_by) == (
        "Pat's iPhone", "iPhone14,5", "22B83", PERSON_ID)
    assert again.status == "pending"
    assert len(queued) == 2

    # A failed device still goes back to pending for them (a retry), unrenamed.
    await db.execute(update(IosDevice).where(IosDevice.id == device.id)
                     .values(status="failed", error="Apple said no"))
    await db.commit()
    third = await new_link(api, "Sam's iPhone")
    assert (await call_back(anonymous, third, callback_body(third))).status_code == 301
    [again] = await devices(db)
    assert (again.status, again.error, again.name) == ("pending", None, "Pat's iPhone")

    # The person who added it may update it with only view.
    main_fake.as_staff()
    fourth = await new_link(api, "Pat's new name")
    assert (await call_back(anonymous, fourth, callback_body(fourth, VERSION="22C152"))
            ).status_code == 301
    [again] = await devices(db)
    assert (again.name, again.os_version) == ("Pat's new name", "22C152")


async def test_callback_rejects_used_token(api, anonymous, db, queued):
    token = await new_link(api)
    assert (await call_back(anonymous, token, callback_body(token))).status_code == 301
    r = await call_back(anonymous, token, callback_body(token, UDID="00008110-0000000000000002"))
    assert r.status_code == 410
    assert EXPIRED_COPY in r.text
    assert [d.udid for d in await devices(db)] == [UDID]
    assert len(queued) == 1


async def test_callback_one_token_two_racing_callbacks(api, anonymous, db, queued):
    token = await new_link(api)
    results = await asyncio.gather(
        call_back(anonymous, token, callback_body(token)),
        call_back(anonymous, token, callback_body(token, UDID="00008110-0000000000000003")))
    assert sorted(r.status_code for r in results) == [301, 410]
    assert len(await devices(db)) == 1
    assert len(queued) == 1


async def test_callback_two_tokens_same_udid_race(api, anonymous, db, queued):
    first, second = await new_link(api), await new_link(api)
    results = await asyncio.gather(call_back(anonymous, first, callback_body(first)),
                                   call_back(anonymous, second, callback_body(second)))
    assert [r.status_code for r in results] == [301, 301]
    [device] = await devices(db)
    assert {r.headers["location"] for r in results} == {f"https://devices.test/?added={device.id}"}


async def test_callback_rejects_wrong_challenge(api, anonymous, db, queued):
    token = await new_link(api)
    other = await new_link(api)
    r = await call_back(anonymous, token, callback_body(other))
    assert r.status_code == 400
    assert await devices(db) == []
    assert queued == []
    row = await db.get(EnrollToken, token_hash(token))
    assert row.used_at is None


async def test_callback_without_challenge_is_accepted(api, anonymous, db, queued):
    token = await new_link(api)
    assert (await call_back(anonymous, token, callback_body(None))).status_code == 301
    assert len(await devices(db)) == 1


async def test_callback_unreadable_bodies_are_400(api, anonymous, db, queued):
    token = await new_link(api)
    bodies = [
        b"",
        b"not cms at all",
        plistlib.dumps(attributes(token)),                 # a plist, not signed
        signed(b"not a plist"),
        signed(plistlib.dumps(["UDID", UDID])),            # not a dict
        callback_body(token, UDID=None),                   # no UDID
        callback_body(token, UDID=""),
        callback_body(token, UDID=12345),
        callback_body(token, UDID="x" * 500),
        callback_body(token, PRODUCT=["iPhone"]),
    ]
    for body in bodies:
        r = await call_back(anonymous, token, body)
        assert r.status_code == 400, body[:40]
    assert await devices(db) == []
    assert queued == []


async def test_redirect_has_no_udid(api, anonymous, db, queued, caplog):
    caplog.set_level(logging.DEBUG)
    token = await new_link(api)
    r = await call_back(anonymous, token, callback_body(token))
    assert r.status_code == 301
    location = r.headers["location"]
    assert UDID not in location
    [device] = await devices(db)
    assert urlsplit(location).query == f"added={device.id}"
    assert UDID not in r.text
    assert UDID not in caplog.text
    # A refused callback doesn't echo it either.
    r = await call_back(anonymous, token, callback_body(token))
    assert UDID not in r.text and UDID not in str(r.headers)
    assert UDID not in caplog.text


async def test_callback_control_characters_400_and_no_udid_in_logs(api, anonymous, db, queued,
                                                                   caplog):
    caplog.set_level(logging.DEBUG)
    token = await new_link(api)
    for field, value in (("PRODUCT", "iPhone\x00"), ("VERSION", "22B83\x7f"),
                         ("SERIAL", "F2LX\x1bK0Q1N7")):
        # A binary plist can carry NUL; Postgres text can't.
        body = signed(plistlib.dumps(attributes(token, **{field: value}),
                                     fmt=plistlib.FMT_BINARY))
        r = await call_back(anonymous, token, body)
        assert r.status_code == 400, field
        assert r.headers["cache-control"] == "no-store"
    assert await devices(db) == []
    assert queued == []
    row = await db.get(EnrollToken, token_hash(token))
    assert row.used_at is None
    assert UDID not in caplog.text


async def test_challenge_with_non_ascii_is_400(api, anonymous, db, queued):
    token = await new_link(api)
    assert (await call_back(anonymous, token, callback_body("é" + token))).status_code == 400
    assert await devices(db) == []
