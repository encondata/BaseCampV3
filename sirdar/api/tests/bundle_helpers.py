"""Builders for snapshot-bundle tests: the parts of a bundle, a whole
bundle, and a dict-backed stand-in for the S3 client calls bundle.py makes."""

import io
import tarfile
import threading
from datetime import UTC, datetime
from pathlib import Path

from sirdar_api.deploy import bundle

OBJECTS = {"a/hello.txt": (b"hello", "text/plain"), "b/doc.pdf": (b"%PDF-1.7 fake", None)}


def write_objects_tar(path: Path, objects: dict = OBJECTS) -> Path:
    with tarfile.open(path, "w", format=tarfile.PAX_FORMAT) as tar:
        for key, (data, content_type) in objects.items():
            info = tarfile.TarInfo(key)
            info.size = len(data)
            if content_type:
                info.pax_headers = {bundle.CONTENT_TYPE_HEADER: content_type}
            tar.addfile(info, io.BytesIO(data))
    return path


def write_parts(folder: Path, *, keys: bytes = b"KEYS-TOKEN") -> dict[str, Path]:
    parts = {"db": folder / "db.dump", "objects": folder / "objects-part.tar",
             "keys": folder / "keys-part"}
    parts["db"].write_bytes(b"PGDMP-fake-dump")
    write_objects_tar(parts["objects"])
    parts["keys"].write_bytes(keys)
    return parts


def make_bundle(folder: Path, *, name: str = "snap.tar.gz", source: str = "uat",
                revision: str = "0089", keys_member: str = "keys.enc",
                keys: bytes = b"KEYS-TOKEN") -> Path:
    parts_dir = folder / f"parts-{name}"
    parts_dir.mkdir(exist_ok=True)
    parts = write_parts(parts_dir, keys=keys)
    out = folder / name
    bundle.pack(out, source=source, revision=revision, bucket="serversherpa",
                db_dump=parts["db"], objects_tar=parts["objects"], keys_file=parts["keys"],
                keys_member=keys_member)
    return out


class FakeS3:
    """list_objects_v2 (paged), get_object and put_object over a dict of
    key -> (bytes, content type or None)."""

    def __init__(self, objects: dict | None = None, *, page_size: int = 1000,
                 fail_on: str | None = None):
        self.objects = dict(objects or {})
        self.page_size = page_size
        self.fail_on = fail_on
        self.buckets: set[str] = set()
        self._lock = threading.Lock()

    def list_objects_v2(self, Bucket, ContinuationToken=None):  # noqa: N803
        self.buckets.add(Bucket)
        keys = sorted(self.objects)
        start = int(ContinuationToken or 0)
        page = keys[start:start + self.page_size]
        out = {"Contents": [{"Key": k, "Size": len(self.objects[k][0])} for k in page],
               "IsTruncated": start + self.page_size < len(keys)}
        if out["IsTruncated"]:
            out["NextContinuationToken"] = str(start + self.page_size)
        return out

    def get_object(self, Bucket, Key):  # noqa: N803
        if Key == self.fail_on:
            raise RuntimeError("S3 went away")
        data, content_type = self.objects[Key]
        out = {"Body": io.BytesIO(data), "ContentLength": len(data),
               "LastModified": datetime(2026, 10, 1, tzinfo=UTC)}
        if content_type:
            out["ContentType"] = content_type
        return out

    def put_object(self, Bucket, Key, Body, ContentType=None):  # noqa: N803
        with self._lock:
            self.buckets.add(Bucket)
            self.objects[Key] = (Body, ContentType)
