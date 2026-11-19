"""deploy/stack/objects.py moves a bucket's objects into one tar and back
(ss-stack export-objects and import-objects, Slipway's export_files and
import_files). An in-memory S3 client stands in for boto3, so these tests
need neither boto3 nor a bucket: the tar handling is the real code."""
from __future__ import annotations

import importlib.util
import io
import tarfile
import threading
from datetime import datetime, timezone
from pathlib import Path

import pytest

from conftest import STACK_DIR

spec = importlib.util.spec_from_file_location("objects", STACK_DIR / "objects.py")
objects = importlib.util.module_from_spec(spec)
spec.loader.exec_module(objects)

SECRET = "S3-Secret-Value-0123"
ENV = {"SS_OBJECTS_ENDPOINT": "http://seaweedfs:8333", "SS_OBJECTS_KEY_ID": "serversherpa",
       "SS_OBJECTS_SECRET": SECRET, "SS_OBJECTS_BUCKET": "serversherpa"}
WHEN = datetime(2026, 10, 4, 1, 2, 3, tzinfo=timezone.utc)


class FakeS3:
    """The calls objects.py makes, on a dict {key: (bytes, content type)}.
    Uploads read the body twice, rewinding between, as boto3 does when it
    computes a checksum first."""

    def __init__(self, items: dict[str, tuple[bytes, str | None]] | None = None, page: int = 2):
        self.items = dict(items or {})
        self.page = page
        self.lock = threading.Lock()
        self.puts: list[str] = []
        self.multipart: list[str] = []
        self.fail_get: str | None = None

    def list_objects_v2(self, Bucket: str, ContinuationToken: str | None = None) -> dict:
        keys = sorted(self.items)
        start = int(ContinuationToken or 0)
        chunk = keys[start:start + self.page]
        out = {"Contents": [{"Key": k, "Size": len(self.items[k][0])} for k in chunk],
               "IsTruncated": start + self.page < len(keys)}
        if out["IsTruncated"]:
            out["NextContinuationToken"] = str(start + self.page)
        return out

    def get_object(self, Bucket: str, Key: str) -> dict:
        if Key == self.fail_get:
            raise RuntimeError("the connection dropped")
        data, content_type = self.items[Key]
        out = {"Body": io.BytesIO(data), "ContentLength": len(data), "LastModified": WHEN}
        if content_type:
            out["ContentType"] = content_type
        return out

    def _store(self, key: str, body, content_type: str | None) -> None:
        first = body.read()
        body.seek(0)
        assert body.read() == first
        with self.lock:
            self.items[key] = (first, content_type)

    def put_object(self, Bucket: str, Key: str, Body, ContentLength: int,
                   ContentType: str | None = None) -> None:
        self._store(Key, Body, ContentType)
        assert len(self.items[Key][0]) == ContentLength
        with self.lock:
            self.puts.append(Key)

    def upload_fileobj(self, Fileobj, Bucket: str, Key: str, ExtraArgs=None, Config=None) -> None:
        self._store(Key, Fileobj, (ExtraArgs or {}).get("ContentType"))
        with self.lock:
            self.multipart.append(Key)


ITEMS = {
    "uploads/report.pdf": (b"%PDF-1.7 report", "application/pdf"),
    "uploads/": (b"", None),                         # a folder marker: left out
    "photos/café.jpg": (bytes(range(256)) * 40, "image/jpeg"),
    "deep/" + "x" * 150 + ".txt": (b"a long key", "text/plain"),
    "empty.txt": (b"", "text/plain"),
    "untyped.bin": (b"\x00\x01\x02", None),
}


def test_export_then_import_gives_the_same_objects(tmp_path: Path) -> None:
    out = tmp_path / "files"
    count, total = objects.export_objects(FakeS3(ITEMS), "serversherpa", str(out))
    expected = {k: v for k, v in ITEMS.items() if k != "uploads/"}
    assert count == len(expected)
    assert total == sum(len(d) for d, _ in expected.values())
    assert out.stat().st_mode & 0o777 == 0o600
    assert not (tmp_path / "files.partial").exists()
    with tarfile.open(out) as tar:
        members = tar.getmembers()
    assert sorted(m.name for m in members) == sorted(expected)
    pdf = next(m for m in members if m.name == "uploads/report.pdf")
    assert pdf.pax_headers["SLIPWAY.content_type"] == "application/pdf"
    assert pdf.mtime == int(WHEN.timestamp())

    target = FakeS3()
    assert objects.import_objects(target, "serversherpa", str(out)) == (count, total)
    assert target.items == expected


def test_import_replaces_same_keys_and_keeps_the_others(tmp_path: Path) -> None:
    out = tmp_path / "files"
    objects.export_objects(FakeS3({"a.txt": (b"new", "text/plain")}), "serversherpa", str(out))
    target = FakeS3({"a.txt": (b"old", None), "b.txt": (b"kept", None)})
    objects.import_objects(target, "serversherpa", str(out))
    assert target.items == {"a.txt": (b"new", "text/plain"), "b.txt": (b"kept", None)}


def test_big_objects_go_up_in_parts(tmp_path: Path) -> None:
    out = tmp_path / "files"
    objects.export_objects(FakeS3({"big": (b"b" * 5000, None), "small": (b"s", None)}),
                           "serversherpa", str(out))
    target = FakeS3()
    objects.import_objects(target, "serversherpa", str(out), single_put_max=1000)
    assert target.multipart == ["big"] and target.puts == ["small"]
    assert target.items["big"] == (b"b" * 5000, None)


def test_many_objects_with_eight_workers(tmp_path: Path) -> None:
    items = {f"k/{i:04}": (f"value {i}".encode() * (i % 7 + 1), None) for i in range(200)}
    out = tmp_path / "files"
    objects.export_objects(FakeS3(items, page=37), "serversherpa", str(out))
    target = FakeS3()
    assert objects.import_objects(target, "serversherpa", str(out))[0] == 200
    assert target.items == items


def test_a_failed_export_leaves_nothing(tmp_path: Path) -> None:
    source = FakeS3(ITEMS)
    source.fail_get = "photos/café.jpg"
    out = tmp_path / "files"
    with pytest.raises(RuntimeError):
        objects.export_objects(source, "serversherpa", str(out))
    assert list(tmp_path.iterdir()) == []


def test_export_refuses_an_existing_file(tmp_path: Path) -> None:
    out = tmp_path / "files"
    out.write_text("keep me")
    with pytest.raises(objects.ObjectsError, match="already exists"):
        objects.export_objects(FakeS3(ITEMS), "serversherpa", str(out))
    assert out.read_text() == "keep me"


def _tar(path: Path, members: list[tuple[tarfile.TarInfo, bytes | None]]) -> None:
    with tarfile.open(path, "w", format=tarfile.PAX_FORMAT) as tar:
        for info, data in members:
            tar.addfile(info, io.BytesIO(data) if data is not None else None)


def _file(name: str, data: bytes, headers: dict[str, str] | None = None) -> tuple:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    if headers:
        info.pax_headers = headers
    return info, data


def test_import_reads_sirdars_content_type_header(tmp_path: Path) -> None:
    src = tmp_path / "objects.tar"
    _tar(src, [_file("a.png", b"png", {"SIRDAR.content_type": "image/png"})])
    target = FakeS3()
    objects.import_objects(target, "serversherpa", str(src))
    assert target.items == {"a.png": (b"png", "image/png")}


@pytest.mark.parametrize("kind", ["symlink", "dir"])
def test_import_refuses_anything_but_files(tmp_path: Path, kind: str) -> None:
    info = tarfile.TarInfo("odd")
    if kind == "symlink":
        info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
    else:
        info.type = tarfile.DIRTYPE
    src = tmp_path / "objects.tar"
    _tar(src, [_file("a.txt", b"a"), (info, None)])
    with pytest.raises(objects.ObjectsError, match="something other than a file"):
        objects.import_objects(FakeS3(), "serversherpa", str(src))


def test_import_refuses_a_key_twice(tmp_path: Path) -> None:
    src = tmp_path / "objects.tar"
    _tar(src, [_file("a.txt", b"one"), _file("a.txt", b"two")])
    with pytest.raises(objects.ObjectsError, match="twice"):
        objects.import_objects(FakeS3(), "serversherpa", str(src))


def test_import_refuses_a_huge_header(tmp_path: Path) -> None:
    src = tmp_path / "objects.tar"
    _tar(src, [_file("a.txt", b"a", {"SLIPWAY.content_type": "x" * (70 * 1024)})])
    with pytest.raises(objects.ObjectsError, match="64 KiB"):
        objects.import_objects(FakeS3(), "serversherpa", str(src))


def test_import_refuses_a_file_that_isnt_a_tar(tmp_path: Path) -> None:
    src = tmp_path / "objects.tar"
    src.write_bytes(b"PGDMP not a tar at all" * 50)
    with pytest.raises(objects.ObjectsError, match="isn't a tar"):
        objects.import_objects(FakeS3(), "serversherpa", str(src))


def test_import_refuses_a_cut_off_tar(tmp_path: Path) -> None:
    out = tmp_path / "files"
    objects.export_objects(FakeS3({"big": (b"b" * 50_000, None)}), "serversherpa", str(out))
    cut = tmp_path / "cut"
    cut.write_bytes(out.read_bytes()[:20_000])
    target = FakeS3()
    with pytest.raises(objects.ObjectsError):
        objects.import_objects(target, "serversherpa", str(cut))
    assert target.items == {}


def test_slice_reads_and_rewinds_one_member() -> None:
    f = io.BytesIO(b"headerDATA-123trailer")
    part = objects._Slice(f, 6, 8)
    assert part.read(4) == b"DATA" and part.tell() == 4
    assert part.read() == b"-123" and part.read() == b""
    part.seek(0)
    assert part.read(100) == b"DATA-123"
    assert part.seek(-3, 2) == 5 and part.read() == b"123"


def test_main_round_trip_and_messages(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "files"
    assert objects.main(["export", str(out)], ENV, FakeS3(ITEMS)) == 0
    assert "Exported 5 objects" in capsys.readouterr().out
    target = FakeS3()
    assert objects.main(["import", str(out)], ENV, target) == 0
    assert "Imported 5 objects" in capsys.readouterr().out
    assert len(target.items) == 5


@pytest.mark.parametrize("args", [[], ["export"], ["delete", "x"], ["export", "a", "b"]])
def test_main_usage(args: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    assert objects.main(args, ENV, FakeS3()) == 2
    assert "usage" in capsys.readouterr().err


@pytest.mark.parametrize("change, message", [
    ({"SS_OBJECTS_ENDPOINT": ""}, "SS_OBJECTS_ENDPOINT isn't set"),
    ({"SS_OBJECTS_SECRET": ""}, "SS_OBJECTS_SECRET isn't set"),
    ({"SS_OBJECTS_BUCKET": "Bad_Bucket"}, "isn't a bucket name"),
    ({"SS_OBJECTS_PATH_STYLE": "maybe"}, "must be true or false"),
])
def test_main_refuses_bad_settings(tmp_path: Path, capsys: pytest.CaptureFixture[str],
                                   change: dict[str, str], message: str) -> None:
    assert objects.main(["export", str(tmp_path / "f")], {**ENV, **change}, FakeS3()) == 1
    assert message in capsys.readouterr().err
    assert not (tmp_path / "f").exists()


def test_main_never_prints_the_secret(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    class Leaky(FakeS3):
        def list_objects_v2(self, **kwargs):
            raise RuntimeError(f"denied for key with secret {SECRET}")

    assert objects.main(["export", str(tmp_path / "f")], ENV, Leaky()) == 1
    err = capsys.readouterr().err
    assert "the object store failed (RuntimeError)" in err
    assert SECRET not in err and "[secret]" in err


def test_main_import_of_a_missing_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert objects.main(["import", str(tmp_path / "nope")], ENV, FakeS3()) == 1
    assert "no such objects file" in capsys.readouterr().err
