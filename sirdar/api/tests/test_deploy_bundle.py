import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from datetime import UTC, datetime

import pytest

from sirdar_api.deploy import bundle
from sirdar_api.deploy.bundle import BundleError

from .bundle_helpers import FakeS3, make_bundle, write_parts


def test_pack_writes_the_members_in_order(tmp_path):
    parts = write_parts(tmp_path)
    out = tmp_path / "snap.tar.gz"
    manifest = bundle.pack(out, source="uat", revision="0089", bucket="serversherpa",
                           db_dump=parts["db"], objects_tar=parts["objects"],
                           keys_file=parts["keys"], created_at="2026-10-04T12:00:00Z")
    with tarfile.open(out, "r:gz") as tar:
        assert tar.getnames() == ["manifest.json", "keys.enc", "db.dump", "objects.tar"]
        stored = json.loads(tar.extractfile("manifest.json").read())
        assert all(m.mode == 0o600 and m.uid == 0 for m in tar.getmembers())
    assert stored == manifest
    assert manifest == {
        "format": 1, "source": "uat", "created_at": "2026-10-04T12:00:00Z",
        "alembic_revision": "0089", "bucket": "serversherpa", "object_count": 2,
        "object_bytes": len(b"hello") + len(b"%PDF-1.7 fake"),
        "members": {"keys.enc": hashlib.sha256(b"KEYS-TOKEN").hexdigest(),
                    "db.dump": hashlib.sha256(b"PGDMP-fake-dump").hexdigest(),
                    "objects.tar": bundle.sha256_file(parts["objects"])}}
    assert out.stat().st_mode & 0o777 == 0o600
    assert not (tmp_path / "snap.tar.gz.partial").exists()


def test_verify_and_read_head(tmp_path):
    out = make_bundle(tmp_path)
    assert bundle.verify(out)["source"] == "uat"
    manifest, name, data = bundle.read_head(out)
    assert (manifest["alembic_revision"], name, data) == ("0089", "keys.enc", b"KEYS-TOKEN")


def _retar(src, dest, mutate):
    """Copy a bundle member by member through mutate(name, data) -> (name, data) | None."""
    with tarfile.open(src, "r:gz") as tin, tarfile.open(dest, "w:gz") as tout:
        for m in tin.getmembers():
            got = mutate(m.name, tin.extractfile(m).read())
            if got is None:
                continue
            name, data = got
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tout.addfile(info, io.BytesIO(data))


@pytest.mark.parametrize("mutate, reason", [
    (lambda n, d: (n, b"PGDMP-tampered") if n == "db.dump" else (n, d),
     "db.dump doesn't match its checksum in the manifest."),
    (lambda n, d: None if n == "objects.tar" else (n, d), bundle._LAYOUT),
    (lambda n, d: ("extra.txt", d) if n == "keys.enc" else (n, d), bundle._LAYOUT),
    (lambda n, d: (n, json.dumps({**json.loads(d), "format": 2}).encode())
     if n == "manifest.json" else (n, d),
     "This bundle's format isn't one Sirdar reads (format 1)."),
    (lambda n, d: (n, json.dumps({**json.loads(d), "alembic_revision": "abc"}).encode())
     if n == "manifest.json" else (n, d),
     "The manifest's Alembic revision is missing or isn't a migration number."),
    (lambda n, d: (n, b"{not json") if n == "manifest.json" else (n, d),
     "manifest.json isn't valid JSON."),
])
def test_verify_refuses_a_bad_bundle(tmp_path, mutate, reason):
    good = make_bundle(tmp_path)
    bad = tmp_path / "bad.tar.gz"
    _retar(good, bad, mutate)
    with pytest.raises(BundleError) as exc:
        bundle.verify(bad)
    assert exc.value.reason == reason


def test_verify_refuses_files_that_arent_bundles(tmp_path):
    plain = tmp_path / "plain.txt"
    plain.write_text("hello")
    cut = tmp_path / "cut.tar.gz"
    cut.write_bytes(make_bundle(tmp_path).read_bytes()[:200])
    gz_not_tar = tmp_path / "x.gz"
    gz_not_tar.write_bytes(gzip.compress(b"just text, not a tar"))
    for path in (plain, cut, gz_not_tar):
        with pytest.raises(BundleError) as exc:
            bundle.verify(path)
        assert exc.value.reason in (bundle._DAMAGED, bundle._LAYOUT)


def test_rewrite_keys_swaps_plain_keys_for_the_token(tmp_path):
    src = make_bundle(tmp_path, keys_member="keys.env", keys=b"SS_PASSWORD_PEPPER=p\n")
    out = tmp_path / "out.tar.gz"
    manifest = bundle.rewrite_keys(src, out, b"ENCRYPTED")
    assert set(manifest["members"]) == {"keys.enc", "db.dump", "objects.tar"}
    assert bundle.verify(out) == manifest
    assert bundle.read_head(out)[1:] == ("keys.enc", b"ENCRYPTED")
    with tarfile.open(out, "r:gz") as tar:
        assert b"SS_PASSWORD_PEPPER" not in b"".join(
            tar.extractfile(m).read() for m in tar.getmembers())
    assert out.stat().st_mode & 0o777 == 0o600


def test_rewrite_keys_leaves_nothing_when_the_source_is_bad(tmp_path):
    good = make_bundle(tmp_path, keys_member="keys.env", keys=b"K=v\n")
    bad = tmp_path / "bad.tar.gz"
    _retar(good, bad, lambda n, d: (n, b"x" * len(d)) if n == "objects.tar" else (n, d))
    out = tmp_path / "out.tar.gz"
    with pytest.raises(BundleError):
        bundle.rewrite_keys(bad, out, b"ENCRYPTED")
    assert not out.exists()
    assert not (tmp_path / "out.tar.gz.partial").exists()


def test_unpack_writes_the_data_but_never_the_keys(tmp_path):
    src = make_bundle(tmp_path)
    dest = tmp_path / "dest"
    dest.mkdir()
    assert bundle.unpack(src, dest)["source"] == "uat"
    assert sorted(p.name for p in dest.iterdir()) == ["db.dump", "objects.tar"]
    assert (dest / "db.dump").read_bytes() == b"PGDMP-fake-dump"
    assert (dest / "db.dump").stat().st_mode & 0o777 == 0o600


def test_objects_round_trip_keeps_content_types(tmp_path):
    source = FakeS3({"a/hello.txt": (b"hello", "text/plain"),
                     "b/doc.pdf": (b"%PDF", "application/pdf"),
                     "folder/": (b"", None),
                     "c/raw": (b"\x00\x01", None)}, page_size=2)
    out = tmp_path / "objects.tar"
    assert bundle.export_objects(source, "src-bucket", out) == (3, 5 + 4 + 2)
    assert out.stat().st_mode & 0o777 == 0o600
    target = FakeS3({"a/hello.txt": (b"old", "text/plain")})
    assert bundle.import_objects(target, "dest-bucket", out, workers=2) == (3, 11)
    assert target.objects == {"a/hello.txt": (b"hello", "text/plain"),
                              "b/doc.pdf": (b"%PDF", "application/pdf"),
                              "c/raw": (b"\x00\x01", None)}
    assert target.buckets == {"dest-bucket"}
    assert source.buckets == {"src-bucket"}


def test_a_failed_export_leaves_no_partial(tmp_path):
    source = FakeS3({"a": (b"1", None)}, fail_on="a")
    with pytest.raises(RuntimeError):
        bundle.export_objects(source, "b", tmp_path / "objects.tar")
    assert list(tmp_path.iterdir()) == []


def test_cli_pack_verify_unpack(tmp_path):
    parts = write_parts(tmp_path)
    tool = bundle.__file__
    out = tmp_path / "b.tar.gz"
    run = lambda *a: subprocess.run([sys.executable, tool, *a], capture_output=True,  # noqa: E731
                                    text=True, check=False)
    packed = run("pack", "--out", str(out), "--source", "mac-dev", "--revision", "0089\n",
                 "--bucket", "serversherpa-dev", "--db", str(parts["db"]),
                 "--objects", str(parts["objects"]), "--keys-env", str(parts["keys"]))
    assert packed.returncode == 0, packed.stderr
    assert json.loads(packed.stdout)["source"] == "mac-dev"
    checked = run("verify", str(out))
    assert json.loads(checked.stdout)["members"]["keys.env"]
    dest = tmp_path / "d"
    dest.mkdir()
    assert run("unpack", str(out), str(dest)).returncode == 0
    bad = run("verify", str(parts["db"]))
    assert (bad.returncode, bad.stderr.strip()) == (1, f"bundle: {bundle._DAMAGED}")
    missing = subprocess.run([sys.executable, tool, "export-objects", "--out", "x"],
                             capture_output=True, text=True,
                             env={"PATH": "/usr/bin:/bin"}, check=False)
    assert missing.returncode == 1
    assert "SNAP_S3_SECRET" in missing.stderr


def test_the_module_needs_only_the_standard_library():
    """The target's host python3 runs pack and unpack: no third-party import
    may happen at import time."""
    code = ("import sys, runpy; runpy.run_path(sys.argv[1]); "
            "bad = [m for m in ('boto3', 'botocore', 'sirdar_api', 'sqlalchemy') "
            "if m in sys.modules]; print(bad)")
    out = subprocess.run([sys.executable, "-c", code, bundle.__file__],
                         capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "[]"


def test_created_at_defaults_to_now(tmp_path):
    parts = write_parts(tmp_path)
    manifest = bundle.pack(tmp_path / "b.tar.gz", source="uat", revision="1",
                           bucket="serversherpa", db_dump=parts["db"],
                           objects_tar=parts["objects"], keys_file=parts["keys"])
    created = datetime.fromisoformat(manifest["created_at"])
    assert abs((datetime.now(UTC) - created).total_seconds()) < 60
