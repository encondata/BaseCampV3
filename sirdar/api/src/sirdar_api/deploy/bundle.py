"""Snapshot bundles. One .tar.gz holds, in this order: manifest.json, the
keys (keys.enc, Fernet-encrypted by Sirdar, or keys.env, plaintext from
scripts/make-seed-snapshot.sh until Sirdar rewrites it), db.dump (pg_dump
custom format) and objects.tar (every object of the bucket: member name =
object key, content type in a PAX header).

Standard library only at import time, and Python 3.8 or newer: Sirdar
imports this module to check and rewrite bundles, the snapshot playbooks
run it on the target (the host's python3 packs and unpacks; the
environment's api image, which has boto3, moves the objects), and the Mac
seed script runs it with the API's virtualenv. Errors are BundleError with
our own copy; nothing here prints a key or a secret."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import zlib
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

FORMAT = 1
MANIFEST = "manifest.json"
KEYS_ENC = "keys.enc"
KEYS_ENV = "keys.env"
KEY_MEMBERS = (KEYS_ENC, KEYS_ENV)
DB_DUMP = "db.dump"
OBJECTS = "objects.tar"
CONTENT_TYPE_HEADER = "SIRDAR.content_type"
REVISION_RE = re.compile(r"[0-9]{1,8}")
SOURCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
BUCKET_RE = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
TIME_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
MANIFEST_KEYS = frozenset({"format", "source", "created_at", "alembic_revision", "bucket",
                           "object_count", "object_bytes", "members"})
# Cap on the decompressed bytes of all members; Sirdar passes a tighter one.
DEFAULT_MAX_BYTES = 64 * 1024 ** 3
STREAM_ALLOWANCE = 1024 * 1024  # tar headers and padding beyond the members' bytes
HEADER_LIMIT = 64 * 1024  # tar extension headers (PAX, GNU long names) never need more
MANIFEST_LIMIT = 64 * 1024
KEYS_LIMIT = 16 * 1024
CHUNK = 1024 * 1024
DEFAULT_ENDPOINT = "http://seaweedfs:8333"
DEFAULT_KEY_ID = "serversherpa"
DEFAULT_BUCKET = "serversherpa"
_LAYOUT = ("The bundle must hold manifest.json, the keys, db.dump and objects.tar, "
           "in that order, and nothing else.")
_DAMAGED = "The file isn't a complete .tar.gz bundle."
_TOO_BIG = "The bundle is larger than the allowed size once unpacked."
_WRITE = "Couldn't write the output files."
UTC = timezone.utc


class BundleError(Exception):
    """`reason` is our own copy, safe to show and log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def sha256_file(path: str | os.PathLike) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def objects_summary(path: str | os.PathLike) -> tuple[int, int]:
    """(object count, total bytes) of an objects.tar."""
    count = total = 0
    try:
        with tarfile.open(path, "r:") as tar:
            for member in tar:
                if not member.isfile():
                    raise BundleError("objects.tar holds something other than files.")
                count += 1
                total += member.size
    except tarfile.TarError:
        raise BundleError("objects.tar isn't a tar archive.") from None
    return count, total


def check_manifest(data: object) -> dict:
    """The manifest, or BundleError naming what's wrong."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise BundleError(f"This bundle's format isn't one Sirdar reads (format {FORMAT}).")
    if set(data) - MANIFEST_KEYS:
        raise BundleError("The manifest has fields this version doesn't know.")
    source = data.get("source")
    if not isinstance(source, str) or not SOURCE_RE.fullmatch(source):
        raise BundleError("The manifest's source is missing or invalid.")
    revision = data.get("alembic_revision")
    if not isinstance(revision, str) or not REVISION_RE.fullmatch(revision):
        raise BundleError("The manifest's Alembic revision is missing or isn't a "
                          "migration number.")
    try:
        parse_time(data.get("created_at"))
    except (TypeError, ValueError):
        raise BundleError("The manifest's creation time is invalid.") from None
    bucket = data.get("bucket")
    if not isinstance(bucket, str) or not BUCKET_RE.fullmatch(bucket):
        raise BundleError("The manifest's bucket name is invalid.")
    for key in ("object_count", "object_bytes"):
        value = data.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise BundleError(f"The manifest's {key} is invalid.")
    members = data.get("members")
    if not isinstance(members, dict):
        raise BundleError("The manifest has no member checksums.")
    keys = [k for k in KEY_MEMBERS if k in members]
    if len(keys) != 1 or set(members) != {keys[0], DB_DUMP, OBJECTS}:
        raise BundleError(_LAYOUT)
    if not all(isinstance(v, str) and SHA256_RE.fullmatch(v) for v in members.values()):
        raise BundleError("The manifest's checksums aren't SHA-256 hex.")
    return data


def parse_time(value) -> datetime:
    """A manifest time: exactly "YYYY-MM-DDTHH:MM:SSZ", on every Python."""
    if not isinstance(value, str) or not TIME_RE.fullmatch(value):
        raise ValueError("not a UTC time")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def _parse_manifest(raw: bytes) -> dict:
    try:
        return check_manifest(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeDecodeError):
        raise BundleError("manifest.json isn't valid JSON.") from None


def _member(name: str, size: int, mtime: float | None = None) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = 0o600
    info.mtime = int(mtime if mtime is not None else datetime.now(UTC).timestamp())
    return info


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class _CappedStream:
    """Reads through a file object and refuses to hand out more than `limit`
    bytes; the limit moves with the members seen (see _scan), so header bytes
    can never run far ahead of the data they describe."""

    def __init__(self, f, limit: int):
        self._f = f
        self.limit = limit
        self._used = 0

    def read(self, n: int = -1) -> bytes:
        data = self._f.read(n)
        self._used += len(data)
        if self._used > self.limit:
            raise BundleError(_TOO_BIG)
        return data


class _SafeInfo(tarfile.TarInfo):
    """tarfile reads an extension header (PAX, GNU long name) whole into
    memory before yielding the member it belongs to; refuse big ones first."""

    _EXTENSIONS = (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                   tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)

    def _proc_member(self, tarfile_):
        if self.type in self._EXTENSIONS and self.size > HEADER_LIMIT:
            raise BundleError(_TOO_BIG)
        return super()._proc_member(tarfile_)


class _HashingReader:
    """Reads through a file object, hashing what passes."""

    def __init__(self, f):
        self._f = f
        self._digest = hashlib.sha256()

    def read(self, n: int = -1) -> bytes:
        data = self._f.read(n)
        self._digest.update(data)
        return data

    def hexdigest(self) -> str:
        return self._digest.hexdigest()


def _scan(path, *, on_manifest=None, on_keys=None, on_data=None,
          head_only: bool = False, max_bytes: int = DEFAULT_MAX_BYTES
          ) -> tuple[dict, str, bytes]:
    """One streaming pass over a bundle: the layout and every checksum are
    checked. on_manifest(manifest), on_keys(name, data) and
    on_data(name, size, reader) see the members as they pass; on_data may
    read its member (it is drained afterwards either way). head_only stops
    after the keys (no checksum of the big members). The members' declared
    sizes may add up to max_bytes at most. Errors raised by the callbacks'
    writes are write errors, not a damaged bundle."""
    manifest: dict | None = None
    keys_name = ""
    keys_data = b""
    seen: list[str] = []
    total = 0

    def call(fn, *args) -> None:
        try:
            fn(*args)
        except OSError:
            raise BundleError(_WRITE) from None

    try:
        with open(path, "rb") as raw, gzip.GzipFile(fileobj=raw) as unzipped:
            stream = _CappedStream(unzipped, STREAM_ALLOWANCE)
            with tarfile.open(fileobj=stream, mode="r|", tarinfo=_SafeInfo) as tar:
                for member in tar:
                    if not member.isfile():
                        raise BundleError(_LAYOUT)
                    total += member.size
                    if total > max_bytes:
                        raise BundleError(_TOO_BIG)
                    stream.limit = total + STREAM_ALLOWANCE
                    if not seen:
                        if member.name != MANIFEST or member.size > MANIFEST_LIMIT:
                            raise BundleError(_LAYOUT)
                        manifest = _parse_manifest(tar.extractfile(member).read())
                        keys_name = next(k for k in KEY_MEMBERS if k in manifest["members"])
                        seen.append(MANIFEST)
                        if manifest["object_bytes"] > max_bytes:
                            raise BundleError(_TOO_BIG)
                        if on_manifest is not None:
                            call(on_manifest, manifest)
                        continue
                    expected = (keys_name, DB_DUMP, OBJECTS)
                    if len(seen) > len(expected) or member.name != expected[len(seen) - 1]:
                        raise BundleError(_LAYOUT)
                    src = tar.extractfile(member)
                    if member.name == keys_name:
                        if member.size > KEYS_LIMIT:
                            raise BundleError("The bundle's keys file is too large.")
                        keys_data = src.read()
                        digest = hashlib.sha256(keys_data).hexdigest()
                    else:
                        reader = _HashingReader(src)
                        if on_data is not None:
                            call(on_data, member.name, member.size, reader)
                        while reader.read(CHUNK):
                            pass
                        digest = reader.hexdigest()
                    if digest != manifest["members"][member.name]:
                        raise BundleError(
                            f"{member.name} doesn't match its checksum in the manifest.")
                    seen.append(member.name)
                    if member.name == keys_name:
                        if on_keys is not None:
                            call(on_keys, keys_name, keys_data)
                        if head_only:
                            return manifest, keys_name, keys_data
    except BundleError:
        raise
    except (tarfile.TarError, EOFError, zlib.error, OSError):
        raise BundleError(_DAMAGED) from None
    if len(seen) != 4:
        raise BundleError(_LAYOUT)
    return manifest, keys_name, keys_data


def read_head(path) -> tuple[dict, str, bytes]:
    """(manifest, keys member name, keys bytes), reading only the first two
    members; the big members' checksums are not checked."""
    return _scan(path, head_only=True)


def verify(path, max_bytes: int = DEFAULT_MAX_BYTES) -> dict:
    """Check the layout and every checksum; the manifest."""
    return _scan(path, max_bytes=max_bytes)[0]


def _open_private(path, extra: int = 0) -> int:
    """A file descriptor for a new file that is mode 600 even if a stale
    file of that name existed, and never through a symlink."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | extra, 0o600)
    os.fchmod(fd, 0o600)
    return fd


def _write_partial(out: Path, write) -> None:
    partial = out.with_name(out.name + ".partial")
    try:
        fd = _open_private(partial)
        with os.fdopen(fd, "wb") as raw, \
                tarfile.open(fileobj=raw, mode="w:gz", compresslevel=1,
                             format=tarfile.PAX_FORMAT) as tar:
            write(tar)
        os.replace(partial, out)
    except OSError:
        partial.unlink(missing_ok=True)
        raise BundleError(_WRITE) from None
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


_LABELS = {KEYS_ENC: "keys", KEYS_ENV: "keys", DB_DUMP: "database dump", OBJECTS: "objects"}


def pack(out, *, source: str, revision: str, bucket: str, db_dump, objects_tar,
         keys_file, keys_member: str = KEYS_ENC, created_at: str | None = None) -> dict:
    """Write a bundle (mode 600) from its parts; the manifest."""
    if keys_member not in KEY_MEMBERS:
        raise BundleError("The keys member must be keys.enc or keys.env.")
    for label, path in (("keys", keys_file), ("database dump", db_dump),
                        ("objects", objects_tar)):
        if not os.path.isfile(path):
            raise BundleError(f"Couldn't read the {label} file.")
    if os.path.getsize(keys_file) > KEYS_LIMIT:
        raise BundleError("The keys file is too large.")
    try:
        count, total = objects_summary(objects_tar)
    except OSError:
        raise BundleError("Couldn't read the objects file.") from None
    sums = {}
    for name, label, path in ((keys_member, "keys", keys_file),
                              (DB_DUMP, "database dump", db_dump),
                              (OBJECTS, "objects", objects_tar)):
        try:
            sums[name] = sha256_file(path)
        except OSError:
            raise BundleError(f"Couldn't read the {label} file.") from None
    manifest = check_manifest({
        "format": FORMAT, "source": source, "created_at": created_at or _now_iso(),
        "alembic_revision": revision, "bucket": bucket,
        "object_count": count, "object_bytes": total, "members": sums,
    })
    raw = json.dumps(manifest, indent=2).encode()

    def write(tar: tarfile.TarFile) -> None:
        tar.addfile(_member(MANIFEST, len(raw)), io.BytesIO(raw))
        for name, path in ((keys_member, keys_file), (DB_DUMP, db_dump),
                           (OBJECTS, objects_tar)):
            try:
                f = open(path, "rb")
            except OSError:
                raise BundleError(f"Couldn't read the {_LABELS[name]} file.") from None
            with f:
                tar.addfile(_member(name, os.path.getsize(path)), f)

    _write_partial(Path(out), write)
    return manifest


def rewrite_keys(src, out, keys_enc: bytes, max_bytes: int = DEFAULT_MAX_BYTES) -> dict:
    """Copy a bundle to `out` with its keys replaced by keys_enc (as
    keys.enc), checking every checksum on the way; the new manifest. `out`
    only appears when the whole source checked out."""
    if len(keys_enc) > KEYS_LIMIT:
        raise BundleError("The keys file is too large.")
    result: dict = {}

    def write(tar: tarfile.TarFile) -> None:
        def on_manifest(manifest: dict) -> None:
            members = {KEYS_ENC: hashlib.sha256(keys_enc).hexdigest(),
                       DB_DUMP: manifest["members"][DB_DUMP],
                       OBJECTS: manifest["members"][OBJECTS]}
            new = check_manifest({**manifest, "members": members})
            raw = json.dumps(new, indent=2).encode()
            tar.addfile(_member(MANIFEST, len(raw)), io.BytesIO(raw))
            tar.addfile(_member(KEYS_ENC, len(keys_enc)), io.BytesIO(keys_enc))
            result.update(new)

        def on_data(name: str, size: int, reader) -> None:
            tar.addfile(_member(name, size), reader)

        _scan(src, on_manifest=on_manifest, on_data=on_data, max_bytes=max_bytes)

    _write_partial(Path(out), write)
    return result


def unpack(path, dest, max_bytes: int = DEFAULT_MAX_BYTES) -> dict:
    """Check a bundle and write its db.dump and objects.tar (mode 600) into
    dest; the keys are never written. Each member is written as
    <name>.partial and only renamed into place once the whole bundle has
    checked out; on any failure nothing is left behind. The manifest."""
    dest = Path(dest)
    partials: list[str] = []
    finals: list[str] = []

    def on_data(name: str, size: int, reader) -> None:
        partials.append(name)
        with os.fdopen(_open_private(dest / (name + ".partial")), "wb") as f:
            while chunk := reader.read(CHUNK):
                f.write(chunk)

    try:
        manifest = _scan(path, on_data=on_data, max_bytes=max_bytes)[0]
        for name in partials:
            os.replace(dest / (name + ".partial"), dest / name)
            finals.append(name)
    except OSError:
        _remove(dest, partials, finals)
        raise BundleError(_WRITE) from None
    except BaseException:
        _remove(dest, partials, finals)
        raise
    return manifest


def _remove(dest: Path, partials: list[str], finals: list[str]) -> None:
    for name in partials:
        (dest / (name + ".partial")).unlink(missing_ok=True)
    for name in finals:
        (dest / name).unlink(missing_ok=True)


# ---- objects (boto3, only where a command needs it) ----------------------------

def s3_client(endpoint: str, key_id: str, secret: str):
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise BundleError("Moving objects needs boto3, which isn't installed here.") from None

    return boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                        aws_access_key_id=key_id, aws_secret_access_key=secret,
                        config=Config(s3={"addressing_style": "path"},
                                      retries={"max_attempts": 5, "mode": "standard"}))


def export_objects(client, bucket: str, out) -> tuple[int, int]:
    """Every object of the bucket into a tar at `out` (written whole or not
    at all); (count, bytes). Zero-byte "folder/" markers are skipped."""
    out = Path(out)
    partial = out.with_name(out.name + ".partial")
    count = total = 0
    try:
        fd = _open_private(partial)
        with os.fdopen(fd, "wb") as raw, tarfile.open(fileobj=raw, mode="w",
                                                      format=tarfile.PAX_FORMAT) as tar:
            token = None
            while True:
                kwargs = {"Bucket": bucket}
                if token:
                    kwargs["ContinuationToken"] = token
                page = client.list_objects_v2(**kwargs)
                for item in page.get("Contents", []):
                    key = item["Key"]
                    if key.endswith("/") and not item.get("Size"):
                        continue
                    obj = client.get_object(Bucket=bucket, Key=key)
                    info = _member(key, int(obj["ContentLength"]),
                                   obj["LastModified"].timestamp())
                    if obj.get("ContentType"):
                        info.pax_headers = {CONTENT_TYPE_HEADER: obj["ContentType"]}
                    tar.addfile(info, obj["Body"])
                    count += 1
                    total += info.size
                if not page.get("IsTruncated"):
                    break
                token = page["NextContinuationToken"]
        os.replace(partial, out)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return count, total


def import_objects(client, bucket: str, src, workers: int = 8) -> tuple[int, int]:
    """Upload every member of an objects.tar into the bucket (content type
    kept); (count, bytes). Existing objects with the same key are replaced."""
    count = total = 0
    try:
        with tarfile.open(src, "r:") as tar, ThreadPoolExecutor(workers) as pool:
            pending: set = set()
            for member in tar:
                if not member.isfile():
                    raise BundleError("objects.tar holds something other than files.")
                kwargs = {"Bucket": bucket, "Key": member.name,
                          "Body": tar.extractfile(member).read()}
                content_type = member.pax_headers.get(CONTENT_TYPE_HEADER)
                if content_type:
                    kwargs["ContentType"] = content_type
                pending.add(pool.submit(client.put_object, **kwargs))
                count += 1
                total += member.size
                if len(pending) >= workers * 2:
                    done, pending = wait(pending, return_when=FIRST_COMPLETED)
                    for future in done:
                        future.result()
            for future in pending:
                future.result()
    except tarfile.TarError:
        raise BundleError("objects.tar isn't a tar archive.") from None
    return count, total


# ---- command line ------------------------------------------------------------

def _s3_from_args(args):
    secret = os.environ.get("SNAP_S3_SECRET") or os.environ.get("SPACES_SECRET_KEY")
    if not secret:
        raise BundleError("Set SNAP_S3_SECRET (or SPACES_SECRET_KEY) to the bucket's secret key.")
    bucket = args.bucket or os.environ.get("SS_SPACES_BUCKET") or DEFAULT_BUCKET
    return s3_client(args.endpoint, args.key_id, secret), bucket


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bundle.py", description="Sirdar snapshot bundles")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pack")
    p.add_argument("--out", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--revision", required=True)
    p.add_argument("--bucket", required=True)
    p.add_argument("--db", required=True)
    p.add_argument("--objects", required=True)
    keys = p.add_mutually_exclusive_group(required=True)
    keys.add_argument("--keys-enc")
    keys.add_argument("--keys-env")
    v = sub.add_parser("verify")
    v.add_argument("bundle")
    v.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    u = sub.add_parser("unpack")
    u.add_argument("bundle")
    u.add_argument("dest")
    u.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    for name in ("export-objects", "import-objects"):
        o = sub.add_parser(name)
        o.add_argument("--out" if name == "export-objects" else "--in", dest="path",
                       required=True)
        o.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
        o.add_argument("--key-id", default=DEFAULT_KEY_ID)
        o.add_argument("--bucket", default="")
    args = parser.parse_args(argv)
    try:
        if args.command == "pack":
            manifest = pack(args.out, source=args.source, revision=args.revision.strip(),
                            bucket=args.bucket, db_dump=args.db, objects_tar=args.objects,
                            keys_file=args.keys_enc or args.keys_env,
                            keys_member=KEYS_ENC if args.keys_enc else KEYS_ENV)
            print(json.dumps({k: v for k, v in manifest.items() if k != "members"}))
        elif args.command == "verify":
            print(json.dumps(verify(args.bundle, args.max_bytes)))
        elif args.command == "unpack":
            print(json.dumps(unpack(args.bundle, args.dest, args.max_bytes)))
        else:
            client, bucket = _s3_from_args(args)
            run = export_objects if args.command == "export-objects" else import_objects
            count, total = run(client, bucket, args.path)
            print(json.dumps({"objects": count, "bytes": total}))
    except BundleError as e:
        print(f"bundle: {e.reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
