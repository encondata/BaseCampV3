"""System settings › Branding (spec 2026-10-20-badge-templates §4.8, §4.11):
the company name and company logo staff ID badges show. settings:view
reads, settings:change writes; the logo is a PNG, JPEG or WebP up to 5 MiB,
stored as uploaded under a server-chosen key, and the object it replaces
or removes is deleted.

Storage is faked here (the system routes' put/delete/presign)."""

import io
import re
from types import SimpleNamespace

import pytest
from PIL import Image
from sqlalchemy import select

from serversherpa.api.routes import system as system_module
from serversherpa.db.models import AuditLog, Person, PersonRole, SystemConfig
from tests.test_status_values_write import _make

URL = "/system/branding"
KEY = re.compile(r"^branding/company-logo/[0-9a-f-]{36}\.(png|jpg|webp)$")


@pytest.fixture
def store(monkeypatch):
    blobs: dict[str, tuple[bytes, str]] = {}
    deleted: list[str] = []

    async def fake_put(key, data, content_type):
        blobs[key] = (data, content_type)

    async def fake_delete(key):
        deleted.append(key)
        blobs.pop(key, None)

    monkeypatch.setattr(system_module, "put_object", fake_put)
    monkeypatch.setattr(system_module, "delete_object", fake_delete)
    monkeypatch.setattr(system_module, "presign_get",
                        lambda key, **kw: f"https://files.test/{key}" if key else None)
    return SimpleNamespace(blobs=blobs, deleted=deleted)


def _image(fmt="PNG", size=(40, 20), mode="RGBA") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, (0, 0, 0, 0) if mode == "RGBA" else 0).save(buf, fmt)
    return buf.getvalue()


async def _super(db, client):
    return await _make(db, client, "super_admin", "brand-sa@test.example.com")


async def _staff(db, client):
    return await _make(db, client, "staff", "brand-staff@test.example.com")


async def _upload(client, hdrs, data, filename="logo.png", ctype="image/png"):
    return await client.put(f"{URL}/logo", headers=hdrs, files={"file": (filename, data, ctype)})


async def _stored(db) -> dict | None:
    db.expire_all()
    row = await db.get(SystemConfig, "branding")
    return row.data if row is not None else None


async def test_defaults_and_the_read_gate(client, db, seeded_user, store):
    hdrs = await _super(db, client)
    resp = await client.get(URL, headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"company_name": "Cumulus Solutions Group", "has_logo": False,
                           "logo_url": None}
    # settings:view is enough to read (staff); a worker has no settings at all
    assert (await client.get(URL, headers=await _staff(db, client))).status_code == 200
    worker = await _make(db, client, "worker", "brand-worker@test.example.com")
    assert (await client.get(URL, headers=worker)).status_code == 403


async def test_an_admin_uploads_a_png_stored_as_uploaded(client, db, seeded_user, store):
    hdrs = await _make(db, client, "admin", "brand-admin@test.example.com")
    png = _image()
    resp = await _upload(client, hdrs, png)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    key = (await _stored(db))["company_logo_key"]
    assert KEY.match(key) and key.endswith(".png")
    assert store.blobs[key] == (png, "image/png")          # the original, uncropped
    assert body == {"company_name": "Cumulus Solutions Group", "has_logo": True,
                    "logo_url": f"https://files.test/{key}"}
    assert (await client.get(URL, headers=hdrs)).json()["logo_url"] == f"https://files.test/{key}"
    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "branding"))).all()
    assert [a.action for a in audit] == ["branding_update"]
    assert audit[0].changes["company_logo_key"] == {"from": None, "to": key}


async def test_jpeg_and_webp_are_accepted_with_their_extensions(client, db, seeded_user, store):
    hdrs = await _super(db, client)
    resp = await _upload(client, hdrs, _image("JPEG", mode="L"), "logo.jpeg", "image/jpeg")
    assert resp.status_code == 200, resp.text
    jpg = (await _stored(db))["company_logo_key"]
    assert jpg.endswith(".jpg") and store.blobs[jpg][1] == "image/jpeg"
    resp = await _upload(client, hdrs, _image("WEBP"), "logo.webp", "image/webp")
    assert resp.status_code == 200, resp.text
    webp = (await _stored(db))["company_logo_key"]
    assert webp.endswith(".webp") and store.blobs[webp][1] == "image/webp"


async def test_a_multi_picture_jpeg_logo_is_a_jpeg(client, db, seeded_user, store):
    """Phones and cameras save JPEGs as MPO (several pictures in one file):
    stored as the JPEG it is, never a 500."""
    hdrs = await _super(db, client)
    buf = io.BytesIO()
    Image.new("RGB", (30, 20)).save(buf, "MPO", save_all=True,
                                    append_images=[Image.new("RGB", (30, 20), (255, 255, 255))])
    resp = await _upload(client, hdrs, buf.getvalue(), "phone.jpg", "image/jpeg")
    assert resp.status_code == 200, resp.text
    key = (await _stored(db))["company_logo_key"]
    assert KEY.match(key) and key.endswith(".jpg")
    assert store.blobs[key] == (buf.getvalue(), "image/jpeg")


async def test_replacing_the_logo_deletes_the_old_object(client, db, seeded_user, store):
    hdrs = await _super(db, client)
    await _upload(client, hdrs, _image())
    first = (await _stored(db))["company_logo_key"]
    assert (await _upload(client, hdrs, _image(size=(60, 30)))).status_code == 200
    second = (await _stored(db))["company_logo_key"]
    assert second != first and KEY.match(second)
    assert store.deleted == [first]
    assert set(store.blobs) == {second}


async def test_only_a_key_these_routes_chose_is_ever_deleted(client, db, seeded_user, store):
    """A config row holding some other object's key (written by hand, say)
    never makes a replace or a remove delete that object."""
    db.add(SystemConfig(section="branding", data={"company_logo_key": "people/someone.jpg"}))
    await db.commit()
    hdrs = await _super(db, client)
    assert (await _upload(client, hdrs, _image())).status_code == 200      # a replace
    assert store.deleted == []
    row = await db.get(SystemConfig, "branding")
    row.data = {"company_logo_key": "attachments/person/x/avatar/y.png"}
    await db.commit()
    assert (await client.delete(f"{URL}/logo", headers=hdrs)).status_code == 200   # a remove
    assert store.deleted == []


async def test_refused_files(client, db, seeded_user, store):
    hdrs = await _super(db, client)
    gif = _image("GIF", mode="L")
    resp = await _upload(client, hdrs, gif, "logo.gif", "image/gif")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "invalid_file_type")
    resp = await _upload(client, hdrs, b"<svg xmlns='http://www.w3.org/2000/svg'/>",
                         "logo.svg", "image/svg+xml")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "invalid_file_type")
    resp = await _upload(client, hdrs, b"")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "empty_file")
    big = b"\x89PNG\r\n\x1a\n" + b"\0" * (5 * 1024 * 1024)
    resp = await _upload(client, hdrs, big)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (413, "file_too_large")
    resp = await _upload(client, hdrs, b"\x89PNG\r\n\x1a\n" + b"not really a png")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "unreadable_image")
    # nothing was stored, nothing was saved
    assert store.blobs == {} and await _stored(db) is None


async def test_a_picture_past_40_megapixels_is_refused(client, db, seeded_user, store):
    hdrs = await _super(db, client)
    buf = io.BytesIO()
    Image.new("1", (8000, 5001)).save(buf, "PNG")       # tiny file, huge picture
    resp = await _upload(client, hdrs, buf.getvalue())
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "image_too_large")
    assert store.blobs == {}


async def test_writes_need_settings_change(client, db, seeded_user, store):
    staff = await _staff(db, client)                   # settings:view only
    assert (await _upload(client, staff, _image())).status_code == 403
    assert (await client.patch(URL, headers=staff,
                               json={"company_name": "Nope"})).status_code == 403
    assert (await client.delete(f"{URL}/logo", headers=staff)).status_code == 403
    assert store.blobs == {} and await _stored(db) is None


async def test_remove_clears_the_key_and_deletes_the_object(client, db, seeded_user, store):
    hdrs = await _super(db, client)
    await _upload(client, hdrs, _image())
    key = (await _stored(db))["company_logo_key"]
    resp = await client.delete(f"{URL}/logo", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"company_name": "Cumulus Solutions Group", "has_logo": False,
                           "logo_url": None}
    assert (await _stored(db))["company_logo_key"] is None
    assert store.deleted == [key] and store.blobs == {}
    # removing when there is no logo is a no-op, not an error
    resp = await client.delete(f"{URL}/logo", headers=hdrs)
    assert (resp.status_code, resp.json()["has_logo"]) == (200, False)
    assert store.deleted == [key]
    actions = (await db.scalars(select(AuditLog.action).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "branding"))).all()
    assert actions == ["branding_update", "branding_update"]


async def test_the_company_name(client, db, seeded_user, store):
    hdrs = await _super(db, client)
    resp = await client.patch(URL, headers=hdrs, json={"company_name": "  Cumulus East  "})
    assert resp.status_code == 200, resp.text
    assert resp.json()["company_name"] == "Cumulus East"
    assert (await _stored(db))["company_name"] == "Cumulus East"
    assert (await client.get(URL, headers=hdrs)).json()["company_name"] == "Cumulus East"
    resp = await client.patch(URL, headers=hdrs, json={"company_name": "   "})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "company_name_required")
    assert (await client.patch(URL, headers=hdrs, json={"company_name": "x" * 201})).status_code == 422
    assert (await client.patch(URL, headers=hdrs, json={"logo": "k"})).status_code == 422
    # a name change keeps the logo
    await _upload(client, hdrs, _image())
    key = (await _stored(db))["company_logo_key"]
    resp = await client.patch(URL, headers=hdrs, json={"company_name": "Cumulus West"})
    assert resp.json()["has_logo"] is True
    assert (await _stored(db)) == {"company_name": "Cumulus West", "company_logo_key": key}


async def test_staff_badges_use_the_configured_company(client, db, seeded_user, store):
    """person_values for staff: the company name and logo come from Branding."""
    hdrs = await _super(db, client)
    staff = Person(first_name="Sam", last_name="Staffer")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    sample = f"/labels/sample-person?person_id={staff.id}"
    body = (await client.get(sample, headers=hdrs)).json()
    assert (body["values"]["company"], body["has_logo"]) == ("Cumulus Solutions Group", False)
    await client.patch(URL, headers=hdrs, json={"company_name": "Cumulus East"})
    await _upload(client, hdrs, _image())
    body = (await client.get(sample, headers=hdrs)).json()
    assert (body["values"]["company"], body["values"]["person_type"]) == ("Cumulus East", "Staff")
    assert body["has_logo"] is True
