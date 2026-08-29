"""Photo stage of the V2 workers importer: avatar choice, byte
resolution (local dir, injected S3 getter), storage + Attachment writes.
Object storage is monkeypatched — no MinIO round-trips."""

from sqlalchemy import select

from serversherpa.db.models import Attachment, Person
import serversherpa.people.v2_import as v2i
from serversherpa.people.v2_import import attach_photos, choose_avatars

_IMG_COLS = ("id, s3_bucket, s3_key, original_filename, file_size, "
             "mime_type, width, height, alt_text, created_at, uploaded_by, "
             "storage_type, local_path, filename, storage_url, description, "
             "updated_at")
_ASSOC_COLS = ("id, image_id, entity_type, entity_id, association_type, "
               "display_order, created_at, is_primary, metadata, updated_at")


def _dump(tmp_path, images: list[str], assocs: list[str]) -> str:
    text = "".join(
        f"INSERT INTO images ({_IMG_COLS}) VALUES ({v});\n" for v in images
    ) + "".join(
        f"INSERT INTO image_associations ({_ASSOC_COLS}) VALUES ({v});\n"
        for v in assocs)
    p = tmp_path / "d.sql"
    p.write_text(text)
    return str(p)


def _img(id_, *, storage="local", filename="'a.jpg'", s3_key="NULL",
         mime="'image/jpeg'") -> str:
    return (f"{id_}, NULL, {s3_key}, 'orig.jpg', 100, {mime}, NULL, NULL, "
            f"NULL, NULL, NULL, '{storage}', NULL, {filename}, NULL, NULL, "
            "NULL")


def _assoc(id_, image_id, person_id, *, primary="FALSE", order=0) -> str:
    return (f"{id_}, {image_id}, 'people', {person_id}, 'default', {order}, "
            f"NULL, {primary}, NULL, NULL")


def test_choose_avatars_prefers_primary_then_order(tmp_path):
    dump = _dump(
        tmp_path,
        images=[_img(1), _img(2), _img(3)],
        assocs=[_assoc(10, 1, 5, order=1),
                _assoc(11, 2, 5, primary="TRUE", order=9),
                _assoc(12, 3, 6, order=0)],
    )
    chosen = choose_avatars(dump)
    assert chosen[5]["id"] == 2      # primary wins over order
    assert chosen[6]["id"] == 3


async def test_attach_photos_local_dir_and_missing(tmp_path, db, monkeypatch):
    person = Person(first_name="Ada", last_name="L")
    db.add(person)
    await db.flush()
    (tmp_path / "imgs").mkdir()
    (tmp_path / "imgs" / "a.jpg").write_bytes(b"\xff\xd8\xffjpegbytes")
    dump = _dump(
        tmp_path,
        images=[_img(1, filename="'a.jpg'"),
                _img(2, filename="'missing.jpg'")],
        assocs=[_assoc(10, 1, 5), _assoc(11, 2, 6)],
    )
    stored: dict[str, bytes] = {}

    async def fake_put(key, data, content_type):
        stored[key] = data

    monkeypatch.setattr(v2i, "put_object", fake_put)
    stats = await attach_photos(
        db, dump, {5: str(person.id), 6: str(person.id)},
        local_dirs=[str(tmp_path / "imgs")], s3_get=None)
    assert stats == {"photos_attached": 1, "photos_unresolved": 1}
    await db.flush()
    att = await db.scalar(select(Attachment).where(
        Attachment.entity_id == person.id))
    assert att.kind == "avatar"
    assert att.content_type == "image/jpeg"
    refreshed = await db.get(Person, person.id)
    assert refreshed.avatar_key == att.storage_key
    assert stored[att.storage_key] == b"\xff\xd8\xffjpegbytes"


async def test_attach_photos_s3_getter_and_failure(tmp_path, db, monkeypatch):
    person = Person(first_name="Bo", last_name="B")
    db.add(person)
    await db.flush()
    dump = _dump(
        tmp_path,
        images=[_img(1, storage="s3", s3_key="'images/x.jpg'",
                     filename="'x.jpg'"),
                _img(2, storage="s3", s3_key="'images/broken.jpg'",
                     filename="'broken.jpg'")],
        assocs=[_assoc(10, 1, 5), _assoc(11, 2, 6)],
    )

    async def fake_put(key, data, content_type):
        pass

    monkeypatch.setattr(v2i, "put_object", fake_put)

    def s3_get(key):
        return b"bytes" if key == "images/x.jpg" else None

    stats = await attach_photos(
        db, dump, {5: str(person.id), 6: str(person.id)},
        local_dirs=[], s3_get=s3_get)
    assert stats == {"photos_attached": 1, "photos_unresolved": 1}


async def test_attach_photos_skips_people_not_in_id_map(tmp_path, db):
    dump = _dump(tmp_path, images=[_img(1)], assocs=[_assoc(10, 1, 5)])
    stats = await attach_photos(db, dump, {}, local_dirs=[], s3_get=None)
    assert stats == {"photos_attached": 0, "photos_unresolved": 0}
