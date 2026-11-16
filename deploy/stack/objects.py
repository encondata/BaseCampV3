"""Every object of ServerSherpa's bucket in one tar, and back again.

    python objects.py export <out.tar>   write <out.tar>.partial, rename it once complete
    python objects.py import <in.tar>    put every member into the bucket

This is Slipway's commands.export_files and commands.import_files for
ServerSherpa (through ss-stack export-objects and import-objects; the format
label in slipway.yml is serversherpa-objects-v1). ss-stack runs it in a
one-off container of the release's api image, which has boto3;
scripts/make-seed-snapshot.sh runs it with the API's virtualenv.

The tar is an uncompressed PAX tar with one regular-file member per object:
the member's name is the object's key, its mtime the object's LastModified,
and its content type sits in the PAX header SLIPWAY.content_type. Import also
reads SIRDAR.content_type (Sirdar's objects.tar has the same layout).
Zero-byte "folder/" markers are left out. An import replaces objects with the
same key and keeps the bucket's other objects. It streams each member from
the tar to the bucket and never writes one to disk.

The S3 settings come from the environment, never argv:
SS_OBJECTS_ENDPOINT, SS_OBJECTS_KEY_ID, SS_OBJECTS_SECRET, SS_OBJECTS_BUCKET,
SS_OBJECTS_REGION (default us-east-1) and SS_OBJECTS_PATH_STYLE (true or
false, default true). Nothing here prints the secret.

Exit 0 when done, 1 when it failed (the reason on stderr), 2 on bad usage.
Standard library only at import time (boto3 is imported when it is needed),
Python 3.10 or newer.
"""

from __future__ import annotations

import os
import re
import sys
import tarfile
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone

CONTENT_TYPE = "SLIPWAY.content_type"
SIRDAR_CONTENT_TYPE = "SIRDAR.content_type"
# tarfile reads a PAX or GNU extension header whole into memory before the
# member it describes; no object needs more than this.
HEADER_LIMIT = 64 * 1024
WORKERS = 8
# Objects up to this size go up in one PUT; bigger ones in parts (S3 refuses
# a single PUT over 5 GiB).
SINGLE_PUT_MAX = 64 * 1024 * 1024
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
USAGE = "usage: python objects.py export <out.tar> | import <in.tar>"


class ObjectsError(Exception):
    """A failure with a reason fit to show (never a secret)."""


# ---- settings and the S3 client ----------------------------------------------

def settings_from(env: dict[str, str]) -> dict[str, str]:
    """The S3 settings from SS_OBJECTS_*; ObjectsError names a missing or bad one."""
    out: dict[str, str] = {}
    for name in ("ENDPOINT", "KEY_ID", "SECRET", "BUCKET"):
        value = env.get(f"SS_OBJECTS_{name}", "")
        if not value:
            raise ObjectsError(f"SS_OBJECTS_{name} isn't set")
        out[name.lower()] = value
    if not BUCKET_RE.match(out["bucket"]):
        raise ObjectsError(f"SS_OBJECTS_BUCKET isn't a bucket name: {out['bucket']!r}")
    out["region"] = env.get("SS_OBJECTS_REGION") or "us-east-1"
    style = (env.get("SS_OBJECTS_PATH_STYLE") or "true").lower()
    if style not in ("true", "false"):
        raise ObjectsError("SS_OBJECTS_PATH_STYLE must be true or false")
    out["path_style"] = style
    return out


def s3_client(settings: dict[str, str]):
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise ObjectsError("moving objects needs boto3, which isn't installed here") from None
    style = "path" if settings["path_style"] == "true" else "virtual"
    return boto3.client("s3", endpoint_url=settings["endpoint"], region_name=settings["region"],
                        aws_access_key_id=settings["key_id"],
                        aws_secret_access_key=settings["secret"],
                        config=Config(s3={"addressing_style": style},
                                      retries={"max_attempts": 5, "mode": "standard"}))


def _list_keys(client, bucket: str):
    """(key, size) of every object of the bucket, page by page."""
    token = None
    while True:
        kwargs = {"Bucket": bucket}
        if token:
            kwargs["ContinuationToken"] = token
        page = client.list_objects_v2(**kwargs)
        for item in page.get("Contents", []):
            yield item["Key"], item.get("Size")
        if not page.get("IsTruncated"):
            return
        token = page["NextContinuationToken"]


# ---- export --------------------------------------------------------------------

def _open_private(path: str) -> int:
    """A descriptor for a new owner-only file, never through a symlink (a stale
    file of that name is truncated)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    os.fchmod(fd, 0o600)
    return fd


def export_objects(client, bucket: str, out: str) -> tuple[int, int]:
    """Every object of the bucket into a tar at `out`, written whole or not at
    all; (count, bytes)."""
    if os.path.lexists(out):
        raise ObjectsError(f"{out} already exists")
    partial = out + ".partial"
    count = total = 0
    try:
        with os.fdopen(_open_private(partial), "wb") as raw, \
                tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for key, size in _list_keys(client, bucket):
                if key.endswith("/") and not size:
                    continue  # a "folder/" marker, not a file
                obj = client.get_object(Bucket=bucket, Key=key)
                body = obj["Body"]
                try:
                    info = tarfile.TarInfo(key)
                    info.size = int(obj["ContentLength"])
                    info.mode = 0o600
                    modified = obj.get("LastModified")
                    info.mtime = int(modified.timestamp() if modified
                                     else datetime.now(timezone.utc).timestamp())
                    if obj.get("ContentType"):
                        info.pax_headers = {CONTENT_TYPE: obj["ContentType"]}
                    # addfile copies exactly info.size bytes and fails on a short body
                    tar.addfile(info, body)
                finally:
                    close = getattr(body, "close", None)
                    if close:
                        close()
                count += 1
                total += info.size
            # the tar's end blocks are written as the with-block closes
        os.replace(partial, out)
    except BaseException:
        try:
            os.unlink(partial)
        except FileNotFoundError:
            pass
        raise
    return count, total


# ---- import --------------------------------------------------------------------

class _SafeInfo(tarfile.TarInfo):
    """Refuse a big extension header before tarfile reads it into memory."""

    _EXTENSIONS = (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                   tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)

    def _proc_member(self, tarfile_):
        if self.type in self._EXTENSIONS and self.size > HEADER_LIMIT:
            raise ObjectsError("the objects tar has a header larger than 64 KiB")
        return super()._proc_member(tarfile_)


class _Slice:
    """`size` bytes of an open file from `offset`: what one member's data is.
    Readable and seekable, so the S3 client can rewind it (checksums, retries)."""

    def __init__(self, f, offset: int, size: int):
        self._f = f
        self._start = offset
        self._size = size
        self._pos = 0

    def read(self, n: int = -1) -> bytes:
        left = self._size - self._pos
        if n is None or n < 0 or n > left:
            n = left
        if n <= 0:
            return b""
        self._f.seek(self._start + self._pos)
        data = self._f.read(n)
        if len(data) != n:
            raise ObjectsError("the objects tar ends inside a member")
        self._pos += n
        return data

    def seek(self, offset: int, whence: int = 0) -> int:
        base = {0: 0, 1: self._pos, 2: self._size}[whence]
        self._pos = min(max(base + offset, 0), self._size)
        return self._pos

    def tell(self) -> int:
        return self._pos

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True


def _put(client, bucket: str, src: str, key: str, offset: int, size: int,
         content_type: str | None, single_put_max: int) -> None:
    """One member into the bucket, read from its own file handle so the
    workers never share a file position."""
    extra = {"ContentType": content_type} if content_type else {}
    with open(src, "rb") as f:
        body = _Slice(f, offset, size)
        if size <= single_put_max:
            client.put_object(Bucket=bucket, Key=key, Body=body, ContentLength=size, **extra)
        else:
            client.upload_fileobj(body, bucket, key, ExtraArgs=extra or None,
                                  Config=_one_part_at_a_time())


def _one_part_at_a_time():
    """boto3's transfer settings for a big object: its parts go up one at a
    time in the worker that has it (the pool already runs eight workers).
    None (boto3's defaults) when boto3 isn't here, as with a stand-in client."""
    try:
        from boto3.s3.transfer import TransferConfig
    except ImportError:
        return None
    return TransferConfig(use_threads=False)


def import_objects(client, bucket: str, src: str, workers: int = WORKERS,
                   single_put_max: int = SINGLE_PUT_MAX) -> tuple[int, int]:
    """Every member of the tar at `src` into the bucket, content types kept;
    (count, bytes). The tar is checked as it is read: regular files only, each
    key once."""
    count = total = 0
    seen: set[str] = set()
    try:
        with open(src, "rb") as raw, \
                tarfile.open(fileobj=raw, mode="r:", tarinfo=_SafeInfo) as tar, \
                ThreadPoolExecutor(workers) as pool:
            pending: set = set()
            try:
                for member in tar:
                    if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or member.issparse():
                        raise ObjectsError(f"the objects tar holds something other than a file: "
                                           f"{member.name!r}")
                    if member.name in seen:
                        raise ObjectsError(f"the objects tar has {member.name!r} twice")
                    seen.add(member.name)
                    content_type = (member.pax_headers.get(CONTENT_TYPE)
                                    or member.pax_headers.get(SIRDAR_CONTENT_TYPE))
                    pending.add(pool.submit(_put, client, bucket, src, member.name,
                                            member.offset_data, member.size, content_type,
                                            single_put_max))
                    count += 1
                    total += member.size
                    if len(pending) >= workers * 2:
                        done, pending = wait(pending, return_when=FIRST_COMPLETED)
                        for future in done:
                            future.result()
                for future in pending:
                    future.result()
            finally:
                for future in pending:
                    future.cancel()
    except tarfile.TarError:
        raise ObjectsError("the objects file isn't a tar archive, or it is damaged") from None
    return count, total


# ---- command line ------------------------------------------------------------

def _safe(text: str, secret: str) -> str:
    return text.replace(secret, "[secret]") if secret else text


def main(argv: list[str] | None = None, env: dict[str, str] | None = None, client=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    env = dict(os.environ) if env is None else env
    if len(args) != 2 or args[0] not in ("export", "import"):
        print(USAGE, file=sys.stderr)
        return 2
    action, path = args
    secret = env.get("SS_OBJECTS_SECRET", "")
    try:
        settings = settings_from(env)
        if client is None:
            client = s3_client(settings)
        if action == "export":
            count, total = export_objects(client, settings["bucket"], path)
            print(f"Exported {count:,} objects ({total:,} bytes) from bucket {settings['bucket']}.")
        else:
            if not os.path.isfile(path):
                raise ObjectsError(f"no such objects file: {path}")
            count, total = import_objects(client, settings["bucket"], path)
            print(f"Imported {count:,} objects ({total:,} bytes) into bucket {settings['bucket']}.")
    except ObjectsError as e:
        print(f"objects.py: {_safe(str(e), secret)}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"objects.py: {_safe(f'{e.strerror or e}: {e.filename or path}', secret)}",
              file=sys.stderr)
        return 1
    except Exception as e:  # the S3 client's errors (botocore), whatever their class
        print(f"objects.py: the object store failed ({type(e).__name__}): {_safe(str(e), secret)}",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
