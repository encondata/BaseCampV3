"""Badge images through the API (spec 2026-10-20-badge-templates §4.3,
§4.5, §4.6, §4.10, §4.11): the static image library, the builder's gray
raster, compile resolving photo/logo/static images into `^GFA` (photo and
logo only at rank 80), images only on ID Badge ZPL templates, schema 3
stored as the template's schema_version, and the preview's larger cap.

Storage is faked here: a key the fake doesn't hold raises NoSuchKey, as a
deleted object does."""

import base64
import binascii
import io
import re
import uuid
import zlib
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from PIL import Image
from sqlalchemy import select

from serversherpa.api.routes import labels as labels_module
from serversherpa.db.models import (
    AuditLog,
    LabelImage,
    LabelTemplate,
    Partner,
    Person,
    PersonRole,
    SystemConfig,
    WorkerProfile,
)
from serversherpa.labels import dither, image_prep
from serversherpa.services import storage
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from tests.test_sites_api import login
from tests.test_status_values_write import _make

URL = "/labels/templates"
SWISS = {"family": "swiss721-cond-bold", "weight": "regular"}
GFA = re.compile(r"\^FO(\d+),(\d+)\^GFA,(\d+),(\d+),(\d+),:Z64:([A-Za-z0-9+/=]*):([0-9A-F]{4})\^FS")
NOW = datetime.now(UTC)


@pytest.fixture
def store(monkeypatch):
    """Fake object storage for the labels routes, and an empty raster cache."""
    blobs: dict[str, bytes] = {}
    gets: list[str] = []

    async def fake_get(key):
        gets.append(key)
        if key not in blobs:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "gone"}}, "GetObject")
        return blobs[key]

    async def fake_put(key, data, content_type):
        blobs[key] = data

    async def fake_delete(key):
        blobs.pop(key, None)

    monkeypatch.setattr(labels_module, "get_object", fake_get)
    monkeypatch.setattr(labels_module, "put_object", fake_put)
    monkeypatch.setattr(labels_module, "delete_object", fake_delete)
    labels_module._RASTER_CACHE.clear()
    yield SimpleNamespace(blobs=blobs, gets=gets)
    labels_module._RASTER_CACHE.clear()


def _png(width=20, height=10, color=0, mode="L") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, (width, height), color).save(buf, "PNG")
    return buf.getvalue()


def _photo_png() -> bytes:
    """A gradient, so dithering it gives a real pattern."""
    im = Image.new("L", (64, 48))
    im.putdata([(x * 4 + y * 2) % 256 for y in range(48) for x in range(64)])
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _image(eid, source, **over) -> dict:
    el = {"id": eid, "type": "image", "source": source, "x": 0.1, "y": 0.1, "w": 0.5,
          "h": 0.4, "rotation": 0}
    el.update(over)
    return el


def _name_field() -> dict:
    return {"id": "name", "type": "field", "field": "person_name", "x": 1.2, "y": 0.2,
            "w": 2, "h": 0.3, "rotation": 0, "display": "text", "font": SWISS, "sizePt": 14,
            "baselineIn": 0.2, "align": "left"}


def _design(*images) -> dict:
    return {"schema": 3 if images else 2, "size": {"w": 3.375, "h": 2.125},
            "elements": [*images, _name_field()]}


def _compile_body(design, *, label_type="id_badge", language_key="zpl", samples=None,
                  dpi_key="300") -> dict:
    body = {"kind": "design", "design": design, "size_key": "id-badge", "dpi_key": dpi_key,
            "language_key": language_key, "label_type": label_type}
    if samples is not None:
        body["samples"] = samples
    return body


async def _compile(client, hdrs, design, **kw):
    return await client.post(f"{URL}/compile", headers=hdrs, json=_compile_body(design, **kw))


def _graphics(code: str) -> list[tuple[int, int, int, bytes]]:
    """Each ^GFA as (x, y, bytes per row, decoded bits), its CRC checked."""
    out = []
    for m in GFA.finditer(code):
        x, y, _b, c, d, b64, crc = m.groups()
        assert crc == f"{binascii.crc_hqx(b64.encode('ascii'), 0):04X}"
        raw = zlib.decompress(base64.b64decode(b64))
        assert len(raw) == int(c)
        out.append((int(x), int(y), int(d), raw))
    return out


async def _super(db, client, email="sa-img@test.example.com"):
    return await _make(db, client, "super_admin", email)


async def _admin(db, client, email="adm-img@test.example.com"):
    return await _make(db, client, "admin", email)


async def _upload(client, hdrs, data=None, filename="logo.png", name=None):
    files = {"file": (filename, _png() if data is None else data, "image/png")}
    return await client.post("/labels/images", headers=hdrs, files=files,
                             data={"name": name} if name else {})


async def _library_image(client, hdrs, data=None) -> str:
    r = await _upload(client, hdrs, data)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _worker(db, store, *, photo=True, logo=True, source="manual") -> Person:
    """A worker whose partner has a logo, with a photo."""
    partner = Partner(name=f"Acme {uuid.uuid4().hex[:4]}",
                      logo_key="partners/acme.png" if logo else None)
    db.add(partner)
    await db.flush()
    person = Person(first_name="Jo", last_name="Rivera", source=source,
                    avatar_key="people/jo.png" if photo else None)
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="worker"))
    db.add(WorkerProfile(person_id=person.id, partner_id=partner.id))
    await db.commit()
    store.blobs["people/jo.png"] = _photo_png()
    store.blobs["partners/acme.png"] = _png(30, 30, 0)
    return person


# ── the image library ────────────────────────────────────────────────

async def test_upload_list_and_soft_delete(client, db, seeded_user, store):
    sa = await _super(db, client)
    png = _png(40, 20)
    r = await _upload(client, sa, png, filename="acme-logo.png", name="Acme logo")
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["name"], body["width"], body["height"], body["mime"], body["size_bytes"]) \
        == ("Acme logo", 40, 20, "image/png", len(png))
    assert body["created_by_name"]
    row = await db.get(LabelImage, uuid.UUID(body["id"]))
    assert store.blobs[row.storage_key] == png             # the original, uncropped
    assert row.storage_key.startswith("label-images/") and row.storage_key.endswith(".png")

    # the name defaults to the file's
    other = await _upload(client, sa, _png(), filename="crest.png")
    assert other.json()["name"] == "crest.png"

    listed = await client.get("/labels/images", headers=sa)
    assert listed.status_code == 200
    assert [i["name"] for i in listed.json()] == ["Acme logo", "crest.png"]

    assert (await client.delete(f"/labels/images/{body['id']}", headers=sa)).status_code == 204
    assert [i["name"] for i in (await client.get("/labels/images", headers=sa)).json()] \
        == ["crest.png"]
    await db.refresh(row)
    assert row.deleted_at is not None
    assert row.storage_key in store.blobs                  # soft: the object stays
    gone = await client.delete(f"/labels/images/{body['id']}", headers=sa)
    assert gone.status_code == 404 and gone.json()["detail"]["code"] == "image_not_found"
    actions = (await db.execute(select(AuditLog.action).where(
        AuditLog.entity_type == "label_image", AuditLog.entity_id == body["id"]))).scalars().all()
    assert sorted(actions) == ["create", "delete"]


def _mpo() -> bytes:
    """A multi-picture JPEG (phones and cameras): Pillow calls it MPO."""
    buf = io.BytesIO()
    Image.new("RGB", (30, 20), (0, 0, 0)).save(
        buf, "MPO", save_all=True, append_images=[Image.new("RGB", (30, 20), (255, 255, 255))])
    return buf.getvalue()


async def test_a_multi_picture_jpeg_uploads_as_a_jpeg(client, db, seeded_user, store):
    sa = await _super(db, client)
    r = await _upload(client, sa, _mpo(), filename="phone.jpg")
    assert r.status_code == 201, r.text
    assert (r.json()["mime"], r.json()["width"], r.json()["height"]) == ("image/jpeg", 30, 20)
    row = await db.get(LabelImage, uuid.UUID(r.json()["id"]))
    assert row.storage_key.endswith(".jpg")
    raster = await client.post("/labels/images/raster", headers=sa, json={
        "source": "static", "image_id": r.json()["id"], "w_in": 0.1, "h_in": 0.1, "dpi": 100,
        "fit": "cover", "rotation": 0})
    assert raster.status_code == 200 and max(raster.content) < 20     # its first picture


async def test_a_storage_outage_is_a_502(client, db, seeded_user, store, monkeypatch, caplog):
    """Not a missing object (that prints nothing): storage itself is down.
    The raster and the compile both say so, and the log never carries the
    endpoint (botocore's message does)."""
    sa = await _super(db, client)
    jo = await _worker(db, store)
    image_id = await _library_image(client, sa)

    async def down(key):
        raise EndpointConnectionError(endpoint_url="http://storage.internal:9000")

    monkeypatch.setattr(labels_module, "get_object", down)
    r = await client.post("/labels/images/raster", headers=sa, json={
        "source": "static", "image_id": image_id, "w_in": 0.1, "h_in": 0.1, "dpi": 300,
        "fit": "contain", "rotation": 0})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "storage_unavailable"
    r = await client.post("/labels/images/raster", headers=sa, json={
        "source": "photo", "person_id": str(jo.id), "w_in": 0.1, "h_in": 0.1, "dpi": 300,
        "fit": "cover", "rotation": 0})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "storage_unavailable"
    for design in (_design(_image("s", "static", imageId=image_id)), _design(_image("p", "photo"))):
        r = await _compile(client, sa, design, samples={"person:id": str(jo.id)})
        assert r.status_code == 502, r.text
        assert r.json()["detail"]["code"] == "storage_unavailable"
    assert "storage.internal" not in caplog.text


BAD_ENDPOINT = "not a url secret-endpoint"


@pytest.fixture
def malformed_endpoint(monkeypatch):
    """Storage settings whose endpoint boto3 refuses to build a client for
    (ValueError "Invalid endpoint: <url>"): the real read path, no mock."""
    from serversherpa.config import get_settings

    monkeypatch.setenv("SS_SPACES_ENDPOINT", BAD_ENDPOINT)
    get_settings.cache_clear()
    storage._client.cache_clear()
    yield
    get_settings.cache_clear()
    storage._client.cache_clear()


async def test_get_object_wraps_a_client_that_cannot_be_built(malformed_endpoint):
    with pytest.raises(storage.StorageConfigError) as caught:
        await storage.get_object("label-images/any.png")
    assert caught.value.cause == "ValueError"
    assert "secret" not in str(caught.value).lower()
    assert caught.value.__cause__ is None and caught.value.__suppress_context__


async def test_put_and_delete_wrap_a_client_that_cannot_be_built(malformed_endpoint):
    """M9: writes and deletes as well as reads: StorageConfigError with the
    class name only, never boto3's "Invalid endpoint: <url>"."""
    for call in (lambda: storage.put_object("label-images/x.png", b"x", "image/png"),
                 lambda: storage.delete_object("label-images/x.png")):
        with pytest.raises(storage.StorageConfigError) as caught:
            await call()
        assert caught.value.cause == "ValueError"
        assert "secret" not in str(caught.value).lower()
        assert caught.value.__cause__ is None and caught.value.__suppress_context__


async def test_a_failed_upload_deletes_its_object_and_logs_no_endpoint(
        client, db, seeded_user, store, monkeypatch, caplog):
    """The picture is stored before its row: when the row can't be written
    the object is deleted again. When that delete fails too, the log names
    the error's class and S3 code, never its message (botocore's carries
    the endpoint)."""
    sa = await _super(db, client)

    def broken_audit(*args, **kwargs):
        raise RuntimeError("the database write failed")

    monkeypatch.setattr(labels_module, "audit", broken_audit)
    with pytest.raises(RuntimeError):
        await _upload(client, sa)
    assert store.blobs == {}

    async def refused(key):
        raise ClientError({"Error": {"Code": "AccessDenied",
                                     "Message": "at http://storage.internal:9000"}},
                          "DeleteObject")

    monkeypatch.setattr(labels_module, "delete_object", refused)
    with pytest.raises(RuntimeError):
        await _upload(client, sa)
    assert "ClientError" in caplog.text and "AccessDenied" in caplog.text
    assert "storage.internal" not in caplog.text
    assert await db.scalar(select(LabelImage.id)) is None


async def test_unconfigured_storage_is_a_502(client, db, seeded_user, store, malformed_endpoint,
                                             monkeypatch, caplog):
    """A storage client that can't even be built (a malformed endpoint) is
    the same 502 from the raster and the compile, and the endpoint shows
    up nowhere."""
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    monkeypatch.setattr(labels_module, "get_object", storage.get_object)    # the real read
    r = await client.post("/labels/images/raster", headers=sa, json={
        "source": "static", "image_id": image_id, "w_in": 0.1, "h_in": 0.1, "dpi": 300,
        "fit": "contain", "rotation": 0})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "storage_unavailable"
    r2 = await _compile(client, sa, _design(_image("s", "static", imageId=image_id)))
    assert r2.status_code == 502 and r2.json()["detail"]["code"] == "storage_unavailable"
    assert "StorageConfigError" in caplog.text
    for text in (r.text, r2.text, caplog.text):
        assert "secret" not in text


async def test_upload_validation(client, db, seeded_user, store):
    sa = await _super(db, client)

    async def code(data, filename="x.png"):
        r = await _upload(client, sa, data, filename=filename)
        return r.status_code, r.json()["detail"]["code"]

    assert await code(b"") == (422, "empty_file")
    assert await code(b"\x89PNG" + b"\0" * (5 * 1024 * 1024)) == (413, "file_too_large")
    assert await code(b"just some text") == (422, "invalid_file_type")
    bmp = io.BytesIO()
    Image.new("L", (8, 8)).save(bmp, "BMP")
    assert await code(bmp.getvalue(), "x.bmp") == (422, "invalid_file_type")
    assert await code(_png(8, 8)[:40]) == (422, "unreadable_image")
    big = io.BytesIO()
    Image.new("1", (10_000, 5_000)).save(big, "PNG")          # 50 MP
    assert await code(big.getvalue()) == (422, "image_too_large")
    for fmt, mime in (("JPEG", "image/jpeg"), ("WEBP", "image/webp"), ("GIF", "image/gif")):
        buf = io.BytesIO()
        Image.new("RGB", (6, 4)).save(buf, fmt)
        r = await _upload(client, sa, buf.getvalue(), filename=f"x.{fmt.lower()}")
        assert r.status_code == 201 and r.json()["mime"] == mime, fmt
    assert len((await client.get("/labels/images", headers=sa)).json()) == 3


async def test_a_name_with_control_characters_is_refused(client, db, seeded_user, store):
    """M3: a NUL in a name was a 500 (Postgres refuses it in text); any
    control character in the name, or in the file name it defaults to, is
    422 bad_field, and nothing is stored."""
    sa = await _super(db, client)
    for name, filename in (("Acme\x00 logo", "logo.png"), ("Acme\nlogo", "logo.png"),
                           (None, "lo\x7fgo.png"), (None, "lo\x1bgo.png")):
        r = await _upload(client, sa, filename=filename, name=name)
        assert r.status_code == 422, (name, filename, r.text)
        assert r.json()["detail"]["code"] == "bad_field"
        assert r.json()["detail"]["field"] == "name"
    assert store.blobs == {}
    assert (await client.get("/labels/images", headers=sa)).json() == []
    # surrounding white space is trimmed, not refused
    r = await _upload(client, sa, name="  Acme logo \t")
    assert (r.status_code, r.json()["name"]) == (201, "Acme logo")


async def test_the_library_and_raster_need_rank_80(client, db, seeded_user, store):
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    raster = {"source": "static", "image_id": image_id, "w_in": 0.1, "h_in": 0.1,
              "dpi": 300, "fit": "contain", "rotation": 0}
    for hdrs in (await _admin(db, client), await login(client)):     # rank 60, rank 40
        assert (await _upload(client, hdrs)).status_code == 403
        assert (await client.get("/labels/images", headers=hdrs)).status_code == 403
        assert (await client.delete(f"/labels/images/{image_id}", headers=hdrs)).status_code \
            == 403
        assert (await client.post("/labels/images/raster", headers=hdrs,
                                  json=raster)).status_code == 403


# ── the builder's raster ─────────────────────────────────────────────

async def test_raster_is_the_prepped_gray_bytes(client, db, seeded_user, store):
    sa = await _super(db, client)
    image_id = await _library_image(client, sa, _png(40, 20, 0))
    body = {"source": "static", "image_id": image_id, "w_in": 0.5, "h_in": 0.4, "dpi": 300,
            "fit": "contain", "rotation": 0}
    r = await client.post("/labels/images/raster", headers=sa, json=body)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/octet-stream"
    assert (r.headers["x-raster-width"], r.headers["x-raster-height"]) == ("150", "120")
    assert len(r.content) == 150 * 120
    # the same bytes the prep makes
    expected = image_prep.gray_raster(_png(40, 20, 0), 150, 120, "contain", 0)
    assert r.content == expected.gray
    # 90 turns the box: 120 wide, 150 tall
    r = await client.post("/labels/images/raster", headers=sa, json={**body, "rotation": 90})
    assert (r.headers["x-raster-width"], r.headers["x-raster-height"]) == ("120", "150")
    assert len(r.content) == 120 * 150


async def test_raster_photo_and_logo_of_a_person(client, db, seeded_user, store):
    sa = await _super(db, client)
    jo = await _worker(db, store)
    body = {"source": "photo", "person_id": str(jo.id), "w_in": 0.2, "h_in": 0.1, "dpi": 203,
            "fit": "cover", "rotation": 0}
    r = await client.post("/labels/images/raster", headers=sa, json=body)
    assert r.status_code == 200, r.text
    assert len(r.content) == 41 * 20
    r = await client.post("/labels/images/raster", headers=sa, json={**body, "source": "logo"})
    assert r.status_code == 200 and len(r.content) == 41 * 20

    async def code(**over):
        resp = await client.post("/labels/images/raster", headers=sa, json={**body, **over})
        return resp.status_code, resp.json()["detail"]["code"]

    assert await code(person_id=None) == (422, "bad_field")
    assert await code(person_id="nope") == (422, "person_not_found")
    assert await code(person_id=str(uuid.uuid4())) == (422, "person_not_found")
    hidden = await _worker(db, store, source=KIOSK_MOVE_SOURCE)
    assert await code(person_id=str(hidden.id)) == (422, "person_not_found")
    no_photo = await _worker(db, store, photo=False, logo=False)
    assert await code(person_id=str(no_photo.id)) == (404, "no_image")
    assert await code(person_id=str(no_photo.id), source="logo") == (404, "no_image")


async def test_raster_without_a_picture_is_404(client, db, seeded_user, store):
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    body = {"source": "static", "image_id": image_id, "w_in": 0.1, "h_in": 0.1, "dpi": 300,
            "fit": "contain", "rotation": 0}

    async def code(**over):
        resp = await client.post("/labels/images/raster", headers=sa, json={**body, **over})
        return resp.status_code, resp.json()["detail"]["code"]

    assert await code(image_id=None) == (422, "bad_field")
    assert await code(image_id="not-a-uuid") == (404, "no_image")
    assert await code(image_id=str(uuid.uuid4())) == (404, "no_image")
    row = await db.get(LabelImage, uuid.UUID(image_id))
    del store.blobs[row.storage_key]                       # the object is gone
    assert await code() == (404, "no_image")
    other = await _library_image(client, sa)
    await client.delete(f"/labels/images/{other}", headers=sa)
    assert await code(image_id=other) == (404, "no_image")   # soft-deleted
    broken = await _library_image(client, sa)
    store.blobs[(await db.get(LabelImage, uuid.UUID(broken))).storage_key] = b"\x89PNG broken"
    assert await code(image_id=broken) == (422, "unreadable_image")
    # a box past the raster cap
    fresh = await _library_image(client, sa)
    assert await code(image_id=fresh, w_in=12, h_in=12, dpi=600) == (422, "image_too_large")
    assert (await client.post("/labels/images/raster", headers=sa, json={
        **body, "image_id": fresh, "fit": "stretch"})).status_code == 422


async def test_a_corrupt_stored_picture(client, db, seeded_user, store):
    """A stored picture whose image stream is broken (the upload check
    would refuse it; a V2 avatar might not have had one): 422 from the
    raster, nothing printed by the compile, never a black slab."""
    from tests.test_label_image_prep import corrupt_png

    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    row = await db.get(LabelImage, uuid.UUID(image_id))
    store.blobs[row.storage_key] = corrupt_png()
    r = await client.post("/labels/images/raster", headers=sa, json={
        "source": "static", "image_id": image_id, "w_in": 0.2, "h_in": 0.1, "dpi": 100,
        "fit": "cover", "rotation": 0})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unreadable_image"
    jo = await _worker(db, store)
    store.blobs["people/jo.png"] = corrupt_png()
    r = await _compile(client, sa, _design(_image("photo", "photo"),
                                           _image("s", "static", x=1.4, imageId=image_id)),
                       samples={"person:id": str(jo.id)})
    assert r.status_code == 200 and _graphics(r.json()["code"]) == []
    # the upload refuses one outright
    up = await _upload(client, sa, corrupt_png())
    assert up.status_code == 422 and up.json()["detail"]["code"] == "unreadable_image"


async def test_cover_boxes_that_used_to_fall_off_the_picture(client, db, seeded_user, store):
    """Sizes where the centered crop came out a hair below zero: 200, not a
    Pillow ValueError (500), from the raster and the compile."""
    from tests.test_label_image_prep import COVER_EDGES

    sa = await _super(db, client)
    for (sw, sh), (bw, bh) in COVER_EDGES:
        image_id = await _library_image(client, sa, _png(sw, sh, 90))
        body = {"source": "static", "image_id": image_id, "w_in": bw / 100, "h_in": bh / 100,
                "dpi": 100, "fit": "cover", "rotation": 0}
        r = await client.post("/labels/images/raster", headers=sa, json=body)
        assert r.status_code == 200, (sw, sh, bw, bh, r.text)
        assert (int(r.headers["x-raster-width"]), int(r.headers["x-raster-height"])) == (bw, bh)


async def test_raster_preps_in_a_thread_and_caches(client, db, seeded_user, store, monkeypatch):
    sa = await _super(db, client)
    image_id = await _library_image(client, sa, _photo_png())
    threaded = []
    real_to_thread = labels_module.asyncio.to_thread

    async def recording_to_thread(func, *args, **kwargs):
        threaded.append(getattr(func, "__name__", func))
        return await real_to_thread(func, *args, **kwargs)

    monkeypatch.setattr(labels_module.asyncio, "to_thread", recording_to_thread)
    body = {"source": "static", "image_id": image_id, "w_in": 0.3, "h_in": 0.2, "dpi": 300,
            "fit": "cover", "rotation": 0}
    first = await client.post("/labels/images/raster", headers=sa, json=body)
    assert first.status_code == 200
    assert threaded == ["gray_raster"]
    reads = len(store.gets)
    again = await client.post("/labels/images/raster", headers=sa, json=body)
    assert again.content == first.content
    assert len(store.gets) == reads and threaded == ["gray_raster"]     # cached
    # another box is another raster
    await client.post("/labels/images/raster", headers=sa, json={**body, "rotation": 90})
    assert threaded == ["gray_raster", "gray_raster"]


async def test_a_freeze_still_serves_the_raster(client, db, seeded_user, store, monkeypatch):
    """M5: the raster is a read made through POST (like /wiki/assets/urls):
    a read-only freeze mustn't blank every badge picture on the canvas.
    Real writes stay frozen."""
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)

    async def frozen(_db):
        return {"read_only": True, "read_only_message": "Down for maintenance."}

    monkeypatch.setattr("serversherpa.system.admin_config.read_admin_config", frozen)
    r = await client.post("/labels/images/raster", headers=sa, json={
        "source": "static", "image_id": image_id, "w_in": 0.1, "h_in": 0.1, "dpi": 300,
        "fit": "contain", "rotation": 0})
    assert r.status_code == 200, r.text
    r = await _upload(client, sa)
    assert (r.status_code, r.json()["detail"]["code"]) == (423, "read_only_mode")


async def test_a_password_change_owed_blocks_the_raster(client, db, seeded_user, store):
    """Exempt from the freeze is not exempt from signing in: a session that
    owes a password change gets nothing but the change."""
    from sqlalchemy import update

    from serversherpa.db.models import UserAccount

    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    await db.execute(update(UserAccount).where(UserAccount.email == "sa-img@test.example.com")
                     .values(must_change_password=True))
    await db.commit()
    owes = await login(client, email="sa-img@test.example.com")
    r = await client.post("/labels/images/raster", headers=owes, json={
        "source": "static", "image_id": image_id, "w_in": 0.1, "h_in": 0.1, "dpi": 300,
        "fit": "contain", "rotation": 0})
    assert (r.status_code, r.json()["detail"]["code"]) == (403, "password_change_required")


async def test_the_browser_can_read_the_raster_size(client, db, seeded_user, store):
    """The portal calls the API cross-origin: the size headers are exposed."""
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    r = await client.post("/labels/images/raster", headers={**sa, "Origin": "http://portal.test"},
                          json={"source": "static", "image_id": image_id, "w_in": 0.1,
                                "h_in": 0.1, "dpi": 300, "fit": "contain", "rotation": 0})
    exposed = {h.strip().lower() for h in r.headers["access-control-expose-headers"].split(",")}
    assert {"x-raster-width", "x-raster-height"} <= exposed


# ── compile resolves images ──────────────────────────────────────────

async def test_compile_prints_photo_logo_and_static_at_rank_80(client, db, seeded_user, store):
    """And the printed bits are exactly the dithered raster the canvas gets
    (spec §4.5: one gray raster, one integer dither)."""
    sa = await _super(db, client)
    jo = await _worker(db, store)
    image_id = await _library_image(client, sa, _photo_png())
    design = _design(_image("photo", "photo", rotation=90),
                     _image("logo", "logo", x=0.7),
                     _image("static", "static", x=1.4, imageId=image_id, brightness=-20,
                            contrast=150, mode="dither"))
    r = await _compile(client, sa, design, samples={"person:id": str(jo.id),
                                                    "person_name": "Jo Rivera"})
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    graphics = _graphics(code)
    assert [(x, y) for x, y, _d, _bits in graphics] == [(30, 30), (210, 30), (420, 30)]
    assert "^FDJo Rivera^FS" in code
    params = {
        "photo": ({"source": "photo", "person_id": str(jo.id), "fit": "cover", "rotation": 90},
                  dither.Params(0, 100, 128, "dither", False)),
        "logo": ({"source": "logo", "person_id": str(jo.id), "fit": "contain", "rotation": 0},
                 dither.Params(0, 100, 128, "threshold", False)),
        "static": ({"source": "static", "image_id": image_id, "fit": "contain", "rotation": 0},
                   dither.Params(-20, 150, 128, "dither", False)),
    }
    for (_x, _y, d, bits), (req, p) in zip(graphics, params.values(), strict=True):
        raster = await client.post("/labels/images/raster", headers=sa, json={
            **req, "w_in": 0.5, "h_in": 0.4, "dpi": 300})
        assert raster.status_code == 200, raster.text
        w, h = int(raster.headers["x-raster-width"]), int(raster.headers["x-raster-height"])
        assert d == dither.bytes_per_row(w)
        assert bits == dither.bitmap(raster.content, w, h, p)
    # the photo turned 90: 120 dots wide, 150 tall
    assert graphics[0][2] == dither.bytes_per_row(120) and len(graphics[0][3]) == 15 * 150


def _crossed(x: int, y: int, w: int, h: int) -> list[str]:
    return [f"^FO{x},{y}^GB{w},{h},2^FS", f"^FO{x},{y}^GD{w},{h},2,B,R^FS",
            f"^FO{x},{y}^GD{w},{h},2,B,L^FS"]


async def test_a_preview_compile_draws_placeholders_and_reads_nothing(
        client, db, seeded_user, store, monkeypatch):
    """The builder's Render goes to Labelary, so its compile asks for
    image_mode placeholder: every image is a crossed box at its footprint,
    no picture is read (not even at rank 80 with a sample person), and the
    sample person isn't looked up at all."""
    sa = await _super(db, client)
    jo = await _worker(db, store)
    image_id = await _library_image(client, sa, _photo_png())
    design = _design(_image("photo", "photo", rotation=90),
                     _image("logo", "logo", x=0.7),
                     _image("static", "static", x=1.4, imageId=image_id, hideWhenEmpty=False))
    labels_module._RASTER_CACHE.clear()
    store.gets.clear()
    lookups = []
    real_find = labels_module.people_badge.find_person

    async def counting_find(*args):
        lookups.append(args[1])
        return await real_find(*args)

    monkeypatch.setattr(labels_module.people_badge, "find_person", counting_find)
    for samples in ({"person:id": str(jo.id)}, {"person:id": "nope"}):
        r = await client.post(f"{URL}/compile", headers=sa, json={
            **_compile_body(design, samples=samples), "image_mode": "placeholder"})
        assert r.status_code == 200, r.text
        code = r.json()["code"]
        assert "^GF" not in code
        lines = code.split("\n")
        assert lines[4:13] == [*_crossed(30, 30, 120, 150), *_crossed(210, 30, 150, 120),
                               *_crossed(420, 30, 150, 120)]
    assert store.gets == [] and lookups == []
    # the default (Test print, generation) still prints the pictures
    r = await _compile(client, sa, design, samples={"person:id": str(jo.id)})
    assert len(_graphics(r.json()["code"])) == 3
    r = await client.post(f"{URL}/compile", headers=sa, json={
        **_compile_body(design), "image_mode": "pictures"})
    assert r.status_code == 422


async def test_below_rank_80_every_image_prints_a_placeholder(client, db, seeded_user, store,
                                                              monkeypatch):
    """Below rank 80 a compile reads no picture at all: every image is the
    preview's crossed box, whatever the image_mode. Only the builder (rank
    80) needs real pictures, and resolving library images for any
    labels:view caller let one keep the API dithering up to 8 million dots
    per request."""
    sa = await _super(db, client)
    jo = await _worker(db, store)
    image_id = await _library_image(client, sa)
    design = _design(_image("photo", "photo"), _image("logo", "logo", x=0.7),
                     _image("static", "static", x=1.4, imageId=image_id))
    labels_module._RASTER_CACHE.clear()
    store.gets.clear()
    prepped = []
    real_prep = labels_module._prep

    async def counting_prep(*args):
        prepped.append(args[0])
        return await real_prep(*args)

    monkeypatch.setattr(labels_module, "_prep", counting_prep)
    boxes = [*_crossed(30, 30, 150, 120), *_crossed(210, 30, 150, 120),
             *_crossed(420, 30, 150, 120)]
    for hdrs in (await _admin(db, client), await login(client)):     # rank 60, rank 40
        # nothing about the sample person is checked below rank 80 either
        for samples in ({"person:id": str(jo.id)}, {"person:id": "nope"}):
            r = await _compile(client, hdrs, design, samples=samples)
            assert r.status_code == 200, r.text
            code = r.json()["code"]
            assert "^GF" not in code
            assert code.split("\n")[4:13] == boxes
    assert store.gets == [] and prepped == []
    # rank 80 still prints the pictures
    r = await _compile(client, sa, design, samples={"person:id": str(jo.id)})
    assert r.status_code == 200 and len(_graphics(r.json()["code"])) == 3


async def test_the_sample_person_must_be_a_person(client, db, seeded_user, store):
    sa = await _super(db, client)
    hidden = await _worker(db, store, source=KIOSK_MOVE_SOURCE)
    design = _design(_image("photo", "photo"))
    for bad in ("nope", str(uuid.uuid4()), str(hidden.id)):
        r = await _compile(client, sa, design, samples={"person:id": bad})
        assert r.status_code == 422, bad
        assert r.json()["detail"]["code"] == "person_not_found"
    # no sample person (or a cleared one): photo and logo print nothing
    for samples in (None, {}, {"person:id": ""}):
        r = await _compile(client, sa, design, samples=samples)
        assert r.status_code == 200 and _graphics(r.json()["code"]) == []


async def test_a_missing_picture_prints_nothing(client, db, seeded_user, store):
    sa = await _super(db, client)
    jo = await _worker(db, store)
    del store.blobs["people/jo.png"]                        # the avatar object is gone
    store.blobs["partners/acme.png"] = b"\x89PNG not really"  # unreadable
    image_id = await _library_image(client, sa)
    deleted = await _library_image(client, sa)
    await client.delete(f"/labels/images/{deleted}", headers=sa)
    lost = await _library_image(client, sa)
    del store.blobs[(await db.get(LabelImage, uuid.UUID(lost))).storage_key]
    design = _design(_image("photo", "photo"), _image("logo", "logo", x=0.7),
                     _image("s1", "static", x=1.4, imageId="not-a-uuid"),
                     _image("s2", "static", x=1.4, y=0.6, imageId=str(uuid.uuid4())),
                     _image("s3", "static", x=1.4, y=1.1, imageId=deleted),
                     _image("s4", "static", x=1.4, y=1.6, imageId=lost),
                     _image("s5", "static", x=2.0, y=0.1),               # none picked yet
                     _image("ok", "static", x=2.6, y=1.0, imageId=image_id))
    r = await _compile(client, sa, design, samples={"person:id": str(jo.id)})
    assert r.status_code == 200, r.text
    assert [(x, y) for x, y, _d, _b in _graphics(r.json()["code"])] == [(780, 300)]
    # hideWhenEmpty off: the gap shows as an outline
    shown = _design(_image("photo", "photo", hideWhenEmpty=False))
    r = await _compile(client, sa, shown, samples={"person:id": str(jo.id)})
    assert "^FO30,30^GB150,120,2^FS" in r.json()["code"]


async def test_compile_caps_the_image_size(client, db, seeded_user, store):
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    huge = _design(_image("big", "static", imageId=image_id, w=12, h=12))
    r = await _compile(client, sa, huge, dpi_key="600")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "image_too_large"
    # many images together pass the per-compile budget
    many = _design(*[_image(f"i{n}", "static", imageId=image_id, w=3, h=2) for n in range(4)])
    r = await _compile(client, sa, many, dpi_key="600")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "image_too_large"


def _loads(monkeypatch) -> dict:
    """The distinct pictures image_prep decodes, held so no id is reused."""
    loaded: dict = {}
    real = image_prep._load

    def counting(im):
        loaded[id(im)] = im
        real(im)

    monkeypatch.setattr(image_prep, "_load", counting)
    return loaded


async def test_compile_reads_and_decodes_each_picture_once(
        client, db, seeded_user, store, monkeypatch):
    """F2: eight image elements over two pictures are two storage reads and
    two decodes, not eight; each element still prints exactly the raster the
    canvas gets for it."""
    sa = await _super(db, client)
    photo = await _library_image(client, sa, _photo_png())
    crest = await _library_image(client, sa, _png(40, 30, 90))
    shapes = [(0.3, 0.2, 0), (0.25, 0.4, 90), (0.5, 0.3, 180), (0.2, 0.2, 270)]
    elements = []
    for n, (w, h, rotation) in enumerate(shapes):
        elements.append(_image(f"p{n}", "static", imageId=photo, x=0.1 + n * 0.8, y=0.1,
                               w=w, h=h, rotation=rotation, mode="dither"))
        elements.append(_image(f"c{n}", "static", imageId=crest, x=0.1 + n * 0.8, y=1.0,
                               w=w, h=h, rotation=rotation, fit="cover"))
    keys = {(await db.get(LabelImage, uuid.UUID(i))).storage_key for i in (photo, crest)}
    labels_module._RASTER_CACHE.clear()
    store.gets.clear()
    loaded = _loads(monkeypatch)
    r = await _compile(client, sa, _design(*elements))
    assert r.status_code == 200, r.text
    assert sorted(store.gets) == sorted(keys)
    assert len(loaded) == 2
    graphics = _graphics(r.json()["code"])
    assert len(graphics) == 8
    labels_module._RASTER_CACHE.clear()          # the canvas preps each box on its own
    for el, (_x, _y, d, bits) in zip(elements, graphics, strict=True):
        raster = await client.post("/labels/images/raster", headers=sa, json={
            "source": "static", "image_id": el["imageId"], "w_in": el["w"], "h_in": el["h"],
            "dpi": 300, "fit": el.get("fit", "contain"), "rotation": el["rotation"]})
        assert raster.status_code == 200, raster.text
        w, h = int(raster.headers["x-raster-width"]), int(raster.headers["x-raster-height"])
        params = dither.Params(0, 100, 128, el.get("mode", "threshold"), False)
        assert d == dither.bytes_per_row(w)
        assert bits == dither.bitmap(raster.content, w, h, params), el["id"]
    # a second compile of the same design is served from the raster cache
    store.gets.clear()
    assert (await _compile(client, sa, _design(*elements))).status_code == 200
    assert store.gets == []


async def test_prep_and_dither_run_inside_the_gate(client, db, seeded_user, store, monkeypatch):
    """F2: prep and dither share asyncio's default executor with every other
    to_thread (storage calls included), so at most four run at once, the
    compile's and the canvas's alike."""
    sa = await _super(db, client)
    image_id = await _library_image(client, sa, _photo_png())
    assert labels_module._PREP_GATE._value == 4
    seen = []
    real_to_thread = labels_module.asyncio.to_thread

    async def recording_to_thread(func, *args, **kwargs):
        seen.append((getattr(func, "__name__", func), labels_module._PREP_GATE._value))
        return await real_to_thread(func, *args, **kwargs)

    monkeypatch.setattr(labels_module.asyncio, "to_thread", recording_to_thread)
    r = await _compile(client, sa, _design(_image("s", "static", imageId=image_id)))
    assert r.status_code == 200, r.text
    r = await client.post("/labels/images/raster", headers=sa, json={
        "source": "static", "image_id": image_id, "w_in": 0.2, "h_in": 0.2, "dpi": 300,
        "fit": "cover", "rotation": 0})
    assert r.status_code == 200, r.text
    # each ran holding one of the four slots
    assert seen == [("gray_rasters", 3), ("bitmap", 3), ("gray_raster", 3)]
    assert labels_module._PREP_GATE._value == 4


async def test_a_design_holds_at_most_eight_images(client, db, seeded_user, store):
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    nine = [_image(f"i{n}", "static", imageId=image_id, x=0.1 + (n % 5) * 0.6,
                   y=0.1 + (n // 5) * 0.6, w=0.2, h=0.2) for n in range(9)]
    store.gets.clear()
    r = await _compile(client, sa, _design(*nine))
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "bad_design"
    assert r.json()["detail"]["problems"] == ["a design holds at most 8 images"]
    assert store.gets == []                      # refused before any picture is read
    assert (await _compile(client, sa, _design(*nine[:8]))).status_code == 200
    r = await client.post(URL, headers=sa, json=_badge(_design(*nine), name="Too many"))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_design"


async def test_duplicate_element_ids_are_a_bad_design(client, db, seeded_user, store):
    """M1: two image elements sharing an id would share one picture (or 500
    the compile when their sizes differ)."""
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    twins = _design(_image("img", "static", imageId=image_id),
                    _image("img", "static", imageId=image_id, x=1.4, w=0.3))
    r = await _compile(client, sa, twins)
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "bad_design"
    assert "img: id is used by another element" in r.json()["detail"]["problems"]
    r = await client.post(URL, headers=sa, json=_badge(twins, name="Twins"))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_design"


async def test_a_row_wider_than_one_graphic_holds_is_too_large(
        client, db, seeded_user, store, monkeypatch):
    """M1: a box under the dot cap can still be wider than one ^GF row holds
    (99,999 bytes): 422 image_too_large, never a compile 500. The row is the
    footprint's, so a box turned 90 counts its height."""
    sa = await _super(db, client)
    image_id = await _library_image(client, sa)
    for w, h, rotation in ((2700, 1 / 300, 0), (1 / 300, 2700, 90)):   # 810,000 x 1 dots
        r = await _compile(client, sa, _design(_image("wide", "static", imageId=image_id,
                                                      w=w, h=h, rotation=rotation)))
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == {"code": "image_too_large", "element": "wide"}
    # the raster route's own bounds (100 in, 1200 DPI) keep it far below one
    # row; the same rule applies there all the same
    monkeypatch.setattr(labels_module, "GF_MAX_BYTES", 10)
    body = {"source": "static", "image_id": image_id, "w_in": 0.3, "h_in": 0.1, "dpi": 300,
            "fit": "contain", "rotation": 0}
    r = await client.post("/labels/images/raster", headers=sa, json=body)
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "image_too_large")
    r = await client.post("/labels/images/raster", headers=sa, json={**body, "rotation": 90})
    assert r.status_code == 200, r.text       # turned: 30 dots wide, 4 bytes a row


async def test_a_compile_value_error_is_a_bad_design(client, db, seeded_user, store, monkeypatch):
    """M1: whatever else the compiler refuses is the design's fault (422),
    not a 500."""
    sa = await _super(db, client)

    def refuse(*args, **kwargs):
        raise ValueError("a 3 x 3 bitmap for a 4 x 4 footprint")

    monkeypatch.setattr(labels_module, "compile_parsed_design", refuse)
    r = await _compile(client, sa, _design(_image("photo", "photo")))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"code": "bad_design",
                                  "problems": ["a 3 x 3 bitmap for a 4 x 4 footprint"]}


# ── images only on ID Badge ZPL templates ────────────────────────────

async def test_compile_refuses_an_image_off_a_zpl_badge(client, db, seeded_user, store):
    sa = await _super(db, client)
    design = _design(_image("photo", "photo"))
    for kw in ({"label_type": "top"}, {"label_type": None},
               {"language_key": "escp"}, {"language_key": "ptouch"}):
        r = await _compile(client, sa, design, **kw)
        assert r.status_code == 422, kw
        assert r.json()["detail"]["code"] == "images_badge_only", kw
    assert (await _compile(client, sa, design)).status_code == 200


def _badge(design, name="Crew Badge", **over) -> dict:
    body = {"name": name, "label_type": "id_badge", "size_key": "id-badge",
            "language_key": "zpl", "kind": "design", "design": design}
    body.update(over)
    return body


async def _node(client, hdrs, name):
    tree = (await client.get(f"{URL}/tree", headers=hdrs)).json()
    return next(p for p in tree if p["name"] == name)


async def test_schema_3_is_stored_on_the_parent_and_its_children(client, db, seeded_user, store):
    sa = await _super(db, client)
    r = await client.post(URL, headers=sa, json=_badge(_design(_image("photo", "photo"))))
    assert r.status_code == 201, r.text
    assert r.json()["schema_version"] == 3
    node = await _node(client, sa, "Crew Badge")
    assert node["schema_version"] == 3
    assert sorted(c["dpi_key"] for c in node["children"]) == ["203", "300", "600"]
    assert {c["schema_version"] for c in node["children"]} == {3}
    pid = node["id"]
    # a save without images is schema 2 again, children and all
    r = await client.patch(f"{URL}/{pid}", headers=sa, json={"design": _design()})
    assert r.status_code == 200, r.text
    node = await _node(client, sa, "Crew Badge")
    assert {node["schema_version"], *(c["schema_version"] for c in node["children"])} == {2}
    # a child's own edit sets its own
    child = node["children"][0]
    r = await client.patch(f"{URL}/{child['id']}", headers=sa,
                           json={"design": _design(_image("logo", "logo"))})
    assert r.status_code == 200 and r.json()["schema_version"] == 3
    # a clone copies them
    r = await client.post(f"{URL}/{pid}/clone", headers=sa, json={"name": "Crew Badge 2"})
    assert r.status_code == 201, r.text
    clone = await _node(client, sa, "Crew Badge 2")
    assert sorted(c["schema_version"] for c in clone["children"]) == [2, 2, 3]


async def test_create_and_save_keep_images_on_zpl_badges(client, db, seeded_user, store):
    sa = await _super(db, client)
    with_image = _design(_image("photo", "photo"))

    async def refused(resp):
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "images_badge_only"

    await refused(await client.post(URL, headers=sa, json=_badge(
        with_image, label_type="top", size_key="4x2")))
    await refused(await client.post(URL, headers=sa, json=_badge(with_image,
                                                                 language_key="escp")))
    # a Top template can't take an image on its parent or its children
    r = await client.post(URL, headers=sa, json=_badge(_design(), name="Rack Top",
                                                       label_type="top", size_key="4x2"))
    assert r.status_code == 201, r.text
    top = await _node(client, sa, "Rack Top")
    await refused(await client.patch(f"{URL}/{top['id']}", headers=sa,
                                     json={"design": with_image}))
    await refused(await client.patch(f"{URL}/{top['children'][0]['id']}", headers=sa,
                                     json={"design": with_image}))
    # a badge with an image can't become another type or language
    r = await client.post(URL, headers=sa, json=_badge(with_image))
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    await refused(await client.patch(f"{URL}/{pid}", headers=sa, json={"label_type": "top"}))
    await refused(await client.patch(f"{URL}/{pid}", headers=sa,
                                     json={"language_key": "ptouch"}))
    # …until the image goes in the same save
    r = await client.patch(f"{URL}/{pid}", headers=sa,
                           json={"design": _design(), "label_type": "top"})
    assert r.status_code == 200, r.text
    # and an older version with an image can't come back on a Top template
    await refused(await client.post(f"{URL}/{pid}/versions/1/0/restore", headers=sa))
    # an older single row never takes a builder design
    r = await client.post(URL, headers=sa, json={
        "name": "Old Row", "label_type": "top", "size_key": "4x2", "dpi_key": "203",
        "language_key": "zpl", "kind": "code", "code": "^XA^XZ"})
    assert r.status_code == 201, r.text
    r = await client.patch(f"{URL}/{r.json()['id']}", headers=sa, json={"design": with_image})
    assert r.status_code == 422


async def test_a_customized_childs_image_blocks_a_type_change(client, db, seeded_user, store):
    """A child with its own design keeps it when the parent's type changes,
    so its image counts; children that follow the parent's design don't."""
    sa = await _super(db, client)
    r = await client.post(URL, headers=sa, json=_badge(_design(), name="Plain Badge"))
    assert r.status_code == 201, r.text
    node = await _node(client, sa, "Plain Badge")
    child = next(c for c in node["children"] if c["dpi_key"] == "203")
    r = await client.patch(f"{URL}/{child['id']}", headers=sa,
                           json={"design": _design(_image("logo", "logo"))})
    assert r.status_code == 200, r.text
    r = await client.patch(f"{URL}/{node['id']}", headers=sa, json={"label_type": "top"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "images_badge_only"
    assert r.json()["detail"]["template_id"] == child["id"]


async def _actor(db, email="sa-img@test.example.com"):
    """What the PATCH helpers use of the AuthContext: the person."""
    return SimpleNamespace(person=await db.scalar(select(Person).where(Person.email == email)))


async def _plain_badge(client, sa, name):
    r = await client.post(URL, headers=sa, json=_badge(_design(), name=name))
    assert r.status_code == 201, r.text
    node = await _node(client, sa, name)
    return uuid.UUID(node["id"]), uuid.UUID(node["children"][0]["id"])


async def test_an_image_save_checks_the_type_as_locked(client, db, seeded_user, store):
    """M2: an image save decides from the template as locked, not as the
    request first read it: a type change to Top committed in between
    refuses it, on a child and on the parent."""
    from fastapi import HTTPException

    from serversherpa.db.engine import get_sessionmaker

    sa = await _super(db, client)
    actor = await _actor(db)
    with_image = {"design": _design(_image("logo", "logo"))}
    for target in ("child", "parent"):
        parent_id, child_id = await _plain_badge(client, sa, f"Race Badge {target}")
        async with get_sessionmaker()() as s:
            row = await s.get(LabelTemplate, child_id if target == "child" else parent_id)
            # another request turns the whole tree into a Top template meanwhile
            r = await client.patch(f"{URL}/{parent_id}", headers=sa, json={"label_type": "top"})
            assert r.status_code == 200, r.text
            patch = labels_module._patch_child if target == "child" else labels_module._patch_parent
            with pytest.raises(HTTPException) as caught:
                await patch(s, row, dict(with_image), None, actor)
            assert caught.value.detail["code"] == "images_badge_only", target
            await s.rollback()


async def _tree_rows(db, parent_id) -> list[LabelTemplate]:
    """The parent and its children as committed."""
    db.expire_all()
    return list((await db.execute(select(LabelTemplate).where(
        (LabelTemplate.id == parent_id) | (LabelTemplate.parent_id == parent_id)))).scalars())


async def test_a_samples_only_save_writes_the_design_as_locked(client, db, seeded_user, store):
    """R1: a parent PATCH with only sample values saves the design as
    locked, not as the request first read it. A stale read of a badge with
    an image, then a type change to Top without the image committed in
    between, then the samples save: the tree stays Top with no image."""
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    sa = await _super(db, client)
    actor = await _actor(db)
    r = await client.post(URL, headers=sa, json=_badge(_design(_image("logo", "logo")),
                                                       name="Stale Badge"))
    assert r.status_code == 201, r.text
    pid = uuid.UUID(r.json()["id"])
    async with get_sessionmaker()() as s:
        stale = await s.get(LabelTemplate, pid)              # an ID badge with an image
        assert stale.label_type == "id_badge" and stale.schema_version == 3
        r = await client.patch(f"{URL}/{pid}", headers=sa,
                               json={"design": _design(), "label_type": "top"})
        assert r.status_code == 200, r.text
        await labels_module._patch_parent(s, stale, {"samples": {"asset_id": "7"}}, None, actor)
        await s.commit()
    rows = await _tree_rows(db, pid)
    assert len(rows) == 4
    for row in rows:
        assert row.label_type == "top", row.name
        assert not templates_tree.has_image(row.design), row.name
        assert row.schema_version == templates_tree.design_schema(row.design) == 2, row.name
    parent = next(row for row in rows if row.id == pid)
    assert parent.samples == {"asset_id": "7"}


async def test_a_stale_design_save_stores_its_own_schema(client, db, seeded_user, store):
    """R1: `schema_version` never disagrees with the stored design. A
    stale read (schema 3), a save without the image committed in between
    (schema 2), then an image save from the stale read: every row of the
    tree stores schema 3 with the image."""
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    sa = await _super(db, client)
    actor = await _actor(db)
    with_image = _design(_image("logo", "logo"))
    r = await client.post(URL, headers=sa, json=_badge(with_image, name="Schema Badge"))
    assert r.status_code == 201, r.text
    pid = uuid.UUID(r.json()["id"])
    async with get_sessionmaker()() as s:
        stale = await s.get(LabelTemplate, pid)
        assert stale.schema_version == 3
        r = await client.patch(f"{URL}/{pid}", headers=sa, json={"design": _design()})
        assert r.status_code == 200, r.text
        await labels_module._patch_parent(s, stale, {"design": with_image}, None, actor)
        await s.commit()
    rows = await _tree_rows(db, pid)
    assert len(rows) == 4
    for row in rows:
        assert templates_tree.has_image(row.design), row.name
        assert row.schema_version == templates_tree.design_schema(row.design) == 3, row.name


async def test_the_tree_saves_refuse_an_image_off_a_badge(client, db, seeded_user, store):
    """R1, defense in depth: save_parent and save_child check images
    against the type and language as locked, whatever the route checked."""
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    sa = await _super(db, client)
    r = await client.post(URL, headers=sa, json=_badge(_design(), name="Top Plain",
                                                       label_type="top", size_key="4x2"))
    assert r.status_code == 201, r.text
    node = await _node(client, sa, "Top Plain")
    parent_id, child_id = uuid.UUID(node["id"]), uuid.UUID(node["children"][0]["id"])
    with_image = _design(_image("logo", "logo"))
    async with get_sessionmaker()() as s:
        parent = await s.get(LabelTemplate, parent_id)
        with pytest.raises(templates_tree.TreeError) as caught:
            await templates_tree.save_parent(s, parent, design=with_image, samples={},
                                             summary=None, actor_id=None)
        assert (caught.value.status, caught.value.code) == (422, "images_badge_only")
        assert caught.value.extra["message"] == "Images print on ID Badge templates in ZPL only"
        await s.rollback()
    async with get_sessionmaker()() as s:
        child = await s.get(LabelTemplate, child_id)
        with pytest.raises(templates_tree.TreeError) as caught:
            await templates_tree.save_child(s, child, design=with_image, summary=None,
                                            actor_id=None)
        assert (caught.value.status, caught.value.code) == (422, "images_badge_only")
        await s.rollback()
    rows = await _tree_rows(db, parent_id)
    assert not any(templates_tree.has_image(row.design) for row in rows)


async def test_a_samples_only_patch_still_saves_the_samples(client, db, seeded_user, store):
    """R1: the samples-only save takes the tree lock now, and still saves
    the samples (a badge with an image keeps it, schema 3)."""
    from serversherpa.labels import templates_tree

    sa = await _super(db, client)
    with_image = _design(_image("logo", "logo"))
    r = await client.post(URL, headers=sa, json=_badge(with_image, name="Sample Badge"))
    assert r.status_code == 201, r.text
    pid = uuid.UUID(r.json()["id"])
    r = await client.patch(f"{URL}/{pid}", headers=sa,
                           json={"samples": {"asset_id": "7"}, "description": "crew"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["samples"] == {"asset_id": "7"} and body["version"] == 2
    assert body["description"] == "crew" and body["schema_version"] == 3
    rows = await _tree_rows(db, pid)
    for row in rows:
        assert row.design == with_image, row.name
        assert row.schema_version == templates_tree.design_schema(row.design) == 3, row.name


async def test_a_samples_only_patch_locks_the_parent_alone(client, db, seeded_user, store):
    """R5: a samples-only save writes no child, so it locks the parent
    alone. Locking every child too could deadlock against a Deactivate,
    which flushes the rows in id order: here a child stays locked by
    another transaction, and the save completes inside a short
    lock_timeout instead of waiting on it."""
    from sqlalchemy import text

    from serversherpa.db.engine import get_sessionmaker

    sa = await _super(db, client)
    actor = await _actor(db)
    parent_id, child_id = await _plain_badge(client, sa, "Busy Child Badge")
    async with get_sessionmaker()() as s, get_sessionmaker()() as other:
        await other.execute(select(LabelTemplate.id).where(LabelTemplate.id == child_id)
                            .with_for_update())
        await s.execute(text("SET LOCAL lock_timeout = '300ms'"))
        parent = await s.get(LabelTemplate, parent_id)
        await labels_module._patch_parent(s, parent, {"samples": {"asset_id": "7"}}, None,
                                          actor)
        await s.commit()
        await other.rollback()
    db.expire_all()
    assert (await db.get(LabelTemplate, parent_id)).samples == {"asset_id": "7"}


async def test_a_restore_checks_the_type_as_locked(client, db, seeded_user, store):
    """M2 on the other write that brings a design back: restoring a version
    with an image checks the type as locked too."""
    from fastapi import HTTPException

    from serversherpa.db.engine import get_sessionmaker

    sa = await _super(db, client)
    actor = await _actor(db)
    r = await client.post(URL, headers=sa, json=_badge(_design(_image("logo", "logo")),
                                                       name="Restore Badge"))
    assert r.status_code == 201, r.text
    pid = uuid.UUID(r.json()["id"])
    r = await client.patch(f"{URL}/{pid}", headers=sa, json={"design": _design()})   # v2: none
    assert r.status_code == 200, r.text
    async with get_sessionmaker()() as s:
        stale = await s.get(LabelTemplate, pid)             # read as an ID badge
        assert stale.label_type == "id_badge"
        r = await client.patch(f"{URL}/{pid}", headers=sa, json={"label_type": "top"})
        assert r.status_code == 200, r.text
        with pytest.raises(HTTPException) as caught:
            await labels_module.restore_template_version(pid, 1, 0, s, actor=actor, _rank=actor)
        assert caught.value.detail["code"] == "images_badge_only"
        assert stale.label_type == "top"                    # the row as locked
        await s.rollback()


async def test_a_type_change_waits_for_an_image_save_in_flight(client, db, seeded_user, store):
    """M2, the other way round: a child's image save in flight when the
    parent's type change starts lands first, and the type change then sees
    the customized child's image and is refused (both used to commit,
    leaving a picture on a Top template)."""
    import asyncio

    from fastapi import HTTPException

    from serversherpa.db.engine import get_sessionmaker

    sa = await _super(db, client)
    actor = await _actor(db)
    parent_id, child_id = await _plain_badge(client, sa, "Busy Badge")
    saved = asyncio.Event()

    async def child_save():
        async with get_sessionmaker()() as s:
            child = await s.get(LabelTemplate, child_id)
            await labels_module._patch_child(s, child, {"design": _design(_image("logo", "logo"))},
                                             None, actor)
            await s.flush()
            saved.set()
            await asyncio.sleep(0.3)      # the type change starts meanwhile
            await s.commit()

    async def type_change():
        async with get_sessionmaker()() as s:
            parent = await s.get(LabelTemplate, parent_id)   # read before the child save
            await saved.wait()
            try:
                await labels_module._patch_parent(s, parent, {"label_type": "top"}, None, actor)
            except HTTPException as e:
                await s.rollback()
                return e.detail["code"]
            await s.commit()
            return None

    _, refused = await asyncio.gather(child_save(), type_change())
    assert refused == "images_badge_only"
    db.expire_all()
    assert (await db.get(LabelTemplate, parent_id)).label_type == "id_badge"


async def test_set_parent_fields_locks_the_tree(client, db, seeded_user, store):
    """A type, size or language change locks the parent and its children
    (the order every save takes them in) before it writes them."""
    from sqlalchemy.exc import DBAPIError

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    sa = await _super(db, client)
    parent_id, child_id = await _plain_badge(client, sa, "Locked Badge")
    async with get_sessionmaker()() as s, get_sessionmaker()() as other:
        parent = await s.get(LabelTemplate, parent_id)
        await templates_tree.set_parent_fields(s, parent, {"size_key": "4x2"})
        for row_id in (parent_id, child_id):
            with pytest.raises(DBAPIError):
                await other.execute(select(LabelTemplate.id).where(LabelTemplate.id == row_id)
                                    .with_for_update(nowait=True))
            await other.rollback()
        await s.rollback()


# ── the preview's cap ────────────────────────────────────────────────

async def test_preview_takes_a_badge_sized_zpl(client, db, seeded_user, monkeypatch):
    async def fake_render(zpl, width_in, height_in, dpmm):
        return b"\x89PNG-fake"

    monkeypatch.setattr(labels_module.labelary, "render_png", fake_render)
    hdrs = await login(client)
    zpl = "^XA" + "A" * (200_000 - 6) + "^XZ"
    r = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": zpl, "size_key": "id-badge", "dpi_key": "300"})
    assert r.status_code == 200, r.text
    r = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "A" * 250_001, "size_key": "id-badge", "dpi_key": "300"})
    assert r.status_code == 422


# ── the cleanup sweep sees the keys ──────────────────────────────────

async def test_cleanup_keeps_library_and_branding_keys(db, seeded_user):
    from serversherpa.devtools.cleanup import keys_in_use

    db.add_all([
        LabelImage(name="a", storage_key="label-images/live.png", width=1, height=1,
                   mime="image/png", size_bytes=1),
        LabelImage(name="b", storage_key="label-images/deleted.png", width=1, height=1,
                   mime="image/png", size_bytes=1, deleted_at=NOW),
        SystemConfig(section="branding", data={"company_name": "Cumulus",
                                               "company_logo_key": "branding/logo.png"}),
        SystemConfig(section="other", data={"company_logo_key": "branding/not-this.png"}),
    ])
    await db.commit()
    keys = {"label-images/live.png", "label-images/deleted.png", "branding/logo.png",
            "branding/not-this.png", "free"}
    assert await keys_in_use(db, keys) == {"label-images/live.png", "branding/logo.png"}
