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
from botocore.exceptions import ClientError
from PIL import Image
from sqlalchemy import select

from serversherpa.api.routes import labels as labels_module
from serversherpa.db.models import (
    AuditLog,
    LabelImage,
    Partner,
    Person,
    PersonRole,
    SystemConfig,
    WorkerProfile,
)
from serversherpa.labels import dither, image_prep
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


async def test_below_rank_80_photo_and_logo_print_empty(client, db, seeded_user, store):
    sa = await _super(db, client)
    jo = await _worker(db, store)
    image_id = await _library_image(client, sa)
    design = _design(_image("photo", "photo"), _image("logo", "logo", x=0.7),
                     _image("static", "static", x=1.4, imageId=image_id))
    admin = await _admin(db, client)
    r = await _compile(client, admin, design, samples={"person:id": str(jo.id)})
    assert r.status_code == 200, r.text
    assert [(x, y) for x, y, _d, _b in _graphics(r.json()["code"])] == [(420, 30)]   # static only
    # nothing about the sample person is checked below rank 80 either
    r = await _compile(client, admin, design, samples={"person:id": "nope"})
    assert r.status_code == 200 and len(_graphics(r.json()["code"])) == 1
    # staff (labels:view) the same
    r = await _compile(client, await login(client), design, samples={"person:id": str(jo.id)})
    assert r.status_code == 200 and len(_graphics(r.json()["code"])) == 1


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
