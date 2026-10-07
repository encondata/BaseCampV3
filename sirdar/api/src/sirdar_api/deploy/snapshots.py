"""Snapshots: bundles on Sirdar's volume (SIRDAR_SNAPSHOTS_DIR) and their
`snapshots` rows (spec Section 3).

A bundle's keys (the source's SS_PASSWORD_PEPPER and SS_TOTP_ENCRYPTION_KEY)
are kept only as keys.enc, Fernet-encrypted with SIRDAR_SECRETS_KEY. An
upload whose keys arrive as plaintext keys.env (scripts/make-seed-snapshot.sh)
is rewritten on arrival and the plaintext copy deleted. Bundles are never
served to browsers. Callers audit and commit; errors carry our own copy,
never a key. File work runs in threads (bundles are hundreds of MB)."""

import asyncio
import json
import os
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

from cryptography.fernet import Fernet
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment, Snapshot, User
from sirdar_api.deploy import bundle, envfile, vault

KEY_NAMES = ("SS_PASSWORD_PEPPER", "SS_TOTP_ENCRYPTION_KEY")
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
NOTES_LIMIT = 2000
WRITE_CHUNK = 1024 * 1024
# The bundle tool the playbooks copy to the target.
BUNDLE_TOOL = str(Path(bundle.__file__).resolve())
_KEYS_INVALID = "The bundle's keys aren't a password pepper and a TOTP key."


class SnapshotError(Exception):
    """`code` is the API error code; `extra` holds non-secret details."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra

    @property
    def reason(self) -> str:
        return self.extra.get("reason") or _REASONS.get(self.code, "The snapshot can't be used.")


_REASONS = {
    "snapshot_keys_unreadable": "This snapshot's keys don't open with the current "
                                "SIRDAR_SECRETS_KEY.",
    "snapshot_file_missing": "This snapshot's bundle is missing from SIRDAR_SNAPSHOTS_DIR.",
    "snapshots_dir_unwritable": "Sirdar can't write its snapshots folder (SIRDAR_SNAPSHOTS_DIR). "
                                "It must be owned by uid 10001 with mode 700.",
}


# ---- paths -------------------------------------------------------------------

def root(settings: Settings) -> Path:
    return Path(settings.snapshots_dir)


def incoming_dir(settings: Settings) -> Path:
    return root(settings) / "incoming"


def bundle_path(settings: Settings, snap: Snapshot) -> Path:
    if not snap.bundle_file:
        raise SnapshotError("snapshot_file_missing")
    return root(settings) / snap.bundle_file


def fetched_path(settings: Settings, snapshot_id: uuid.UUID) -> Path:
    """Where the Take snapshot step's fetch writes the bundle."""
    return incoming_dir(settings) / f"{snapshot_id}.tar.gz"


def ensure_dirs(settings: Settings) -> None:
    try:
        for folder in (root(settings), incoming_dir(settings)):
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(folder, 0o700)
    except PermissionError:
        raise SnapshotError("snapshots_dir_unwritable") from None


def discard_fetched(settings: Settings, snapshot_id: uuid.UUID | None) -> None:
    if snapshot_id is not None:
        fetched_path(settings, snapshot_id).unlink(missing_ok=True)


# ---- names, notes and keys ---------------------------------------------------

def check_name(name: str) -> str:
    if not NAME_RE.fullmatch(name or ""):
        raise SnapshotError("snapshot_name_invalid")
    return name


def check_notes(notes: str | None) -> str:
    notes = (notes or "").strip()
    if len(notes) > NOTES_LIMIT:
        raise SnapshotError("notes_too_long")
    return notes


def _valid_keys(keys: object) -> dict[str, str]:
    if not isinstance(keys, dict):
        raise SnapshotError("bundle_invalid", reason=_KEYS_INVALID)
    out: dict[str, str] = {}
    for name in KEY_NAMES:
        value = keys.get(name)
        if not isinstance(value, str) or not value or envfile.unsafe_value(value) \
                or value == envfile.PLACEHOLDER:
            raise SnapshotError("bundle_invalid", reason=_KEYS_INVALID)
        out[name] = value
    try:
        Fernet(out["SS_TOTP_ENCRYPTION_KEY"].encode())
    except ValueError:
        raise SnapshotError("bundle_invalid", reason=_KEYS_INVALID) from None
    return out


def encrypt_keys(settings: Settings, keys: dict[str, str]) -> bytes:
    """keys.enc for a bundle: the two keys as JSON, Fernet-encrypted."""
    return vault.encrypt(settings, json.dumps({k: keys[k] for k in KEY_NAMES}))


def decrypt_keys(settings: Settings, token: bytes) -> dict[str, str]:
    try:
        raw = vault.decrypt(settings, token)
    except (vault.SecretUnreadable, vault.SecretsKeyMissing):
        raise SnapshotError("snapshot_keys_unreadable") from None
    try:
        return _valid_keys(json.loads(raw))
    except ValueError:
        raise SnapshotError("bundle_invalid", reason=_KEYS_INVALID) from None


def read_keys(settings: Settings, snap: Snapshot) -> dict[str, str]:
    """The snapshot's pepper and TOTP key (sync: run it in a thread)."""
    path = bundle_path(settings, snap)
    if not path.is_file():
        raise SnapshotError("snapshot_file_missing")
    try:
        _, name, data = bundle.read_head(path)
    except bundle.BundleError as e:
        raise SnapshotError("bundle_invalid", reason=e.reason) from None
    if name != bundle.KEYS_ENC:
        raise SnapshotError("bundle_invalid", reason=_KEYS_INVALID)
    return decrypt_keys(settings, data)


# ---- bundles -------------------------------------------------------------------

@dataclass(frozen=True)
class Stored:
    """A checked bundle in SIRDAR_SNAPSHOTS_DIR."""
    manifest: dict
    bundle_file: str
    size_bytes: int
    checksum: str


def _stored(path: Path, manifest: dict) -> Stored:
    return Stored(manifest=manifest, bundle_file=path.name, size_bytes=path.stat().st_size,
                  checksum=bundle.sha256_file(path))


def _unpacked_cap(settings: Settings) -> int:
    """How large a bundle may grow once decompressed: 4x the upload cap."""
    return 4 * settings.snapshot_max_bytes


def store_bundle(settings: Settings, src: Path, snapshot_id: uuid.UUID) -> Stored:
    """Check `src` (every checksum) and keep it as <id>.tar.gz with
    encrypted keys; `src` is gone afterwards either way. Sync."""
    dest = root(settings) / f"{snapshot_id}.tar.gz"
    try:
        _, name, data = bundle.read_head(src)
        if name == bundle.KEYS_ENV:
            text = data.decode("utf-8", errors="replace")
            token = encrypt_keys(settings, _valid_keys(envfile.parse_env(text)))
            manifest = bundle.rewrite_keys(src, dest, token, max_bytes=_unpacked_cap(settings))
        else:
            decrypt_keys(settings, data)
            manifest = bundle.verify(src, max_bytes=_unpacked_cap(settings))
            os.replace(src, dest)
            os.chmod(dest, 0o600)
        return _stored(dest, manifest)
    except bundle.BundleError as e:
        raise SnapshotError("bundle_invalid", reason=e.reason) from None
    finally:
        src.unlink(missing_ok=True)


def _apply(snap: Snapshot, stored: Stored) -> None:
    m = stored.manifest
    snap.status = "ready"
    snap.alembic_revision = m["alembic_revision"]
    snap.object_count, snap.object_bytes = m["object_count"], m["object_bytes"]
    snap.source_created_at = bundle.parse_time(m["created_at"])
    snap.bundle_file, snap.size_bytes, snap.checksum = (stored.bundle_file, stored.size_bytes,
                                                        stored.checksum)


# ---- rows ----------------------------------------------------------------------

async def list_all(db: AsyncSession) -> list[Snapshot]:
    return list(await db.scalars(select(Snapshot).order_by(Snapshot.created_at.desc(),
                                                           Snapshot.name)))


async def _name_taken(db: AsyncSession, name: str) -> bool:
    return await db.scalar(select(Snapshot.id).where(Snapshot.name == name)) is not None


async def _insert(db: AsyncSession, snap: Snapshot) -> None:
    try:
        async with db.begin_nested():
            db.add(snap)
            await db.flush()
    except IntegrityError as e:
        if "snapshots_name_key" in str(e.orig):
            raise SnapshotError("snapshot_exists") from None
        raise


async def receive_upload(db: AsyncSession, settings: Settings, *, name: str, notes: str | None,
                         chunks: AsyncIterator[bytes], content_length: int | None,
                         actor_id) -> Snapshot:
    """Stream an uploaded bundle to incoming/, check it, keep it, add its
    row. Nothing is left on disk when it fails."""
    name, notes = check_name(name), check_notes(notes)
    if not vault.is_configured(settings):
        raise SnapshotError("secrets_key_missing")
    limit = settings.snapshot_max_bytes
    if content_length is not None and content_length > limit:
        raise SnapshotError("snapshot_too_large", max_bytes=limit)
    if await _name_taken(db, name):
        raise SnapshotError("snapshot_exists")
    await asyncio.to_thread(ensure_dirs, settings)
    snap_id = uuid.uuid4()
    upload = incoming_dir(settings) / f"{snap_id}.upload"
    stored: Stored | None = None
    try:
        size = 0
        try:
            fd = os.open(upload, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except PermissionError:
            raise SnapshotError("snapshots_dir_unwritable") from None
        with os.fdopen(fd, "wb") as f:
            buffer = bytearray()
            async for chunk in chunks:
                size += len(chunk)
                if size > limit:
                    raise SnapshotError("snapshot_too_large", max_bytes=limit)
                buffer += chunk
                if len(buffer) >= WRITE_CHUNK:
                    await asyncio.to_thread(f.write, bytes(buffer))
                    buffer.clear()
            await asyncio.to_thread(f.write, bytes(buffer))
        if size == 0:
            raise SnapshotError("bundle_invalid", reason="The upload was empty.")
        stored = await asyncio.to_thread(store_bundle, settings, upload, snap_id)
        snap = Snapshot(id=snap_id, name=name, origin="upload",
                        source=stored.manifest["source"], notes=notes, created_by=actor_id)
        _apply(snap, stored)
        await _insert(db, snap)
        return snap
    except BaseException:
        if stored is not None:
            (root(settings) / stored.bundle_file).unlink(missing_ok=True)
        raise
    finally:
        upload.unlink(missing_ok=True)


async def begin_take(db: AsyncSession, settings: Settings, env: Environment, *, name: str,
                     notes: str | None, actor_id, deployed: bool | None = None) -> Snapshot:
    """The pending row a Take snapshot job fills in. `deployed`: the caller's
    own answer to "is there data to take" (a Blue/Green Delete: a slot that
    ran, live or not); by default, whether the environment runs a commit."""
    name, notes = check_name(name), check_notes(notes)
    if not vault.is_configured(settings):
        raise SnapshotError("secrets_key_missing")
    if deployed is None:
        deployed = env.current_sha is not None and env.image_tag is not None
    if not deployed:
        raise SnapshotError("not_deployed")
    if await _name_taken(db, name):
        raise SnapshotError("snapshot_exists")
    await asyncio.to_thread(ensure_dirs, settings)
    snap = Snapshot(name=name, origin="environment", source=env.name, status="pending",
                    notes=notes, created_by=actor_id)
    await _insert(db, snap)
    return snap


def ingest_fetched(settings: Settings, snapshot_id: uuid.UUID) -> Stored:
    """The bundle the Take snapshot step fetched, checked and kept. Sync."""
    src = fetched_path(settings, snapshot_id)
    if not src.is_file():
        raise SnapshotError("bundle_invalid", reason="The snapshot bundle never arrived.")
    try:
        _, name, _ = bundle.read_head(src)
    except bundle.BundleError as e:
        src.unlink(missing_ok=True)
        raise SnapshotError("bundle_invalid", reason=e.reason) from None
    if name != bundle.KEYS_ENC:
        src.unlink(missing_ok=True)
        raise SnapshotError("bundle_invalid", reason=_KEYS_INVALID)
    return store_bundle(settings, src, snapshot_id)


def mark_ready(snap: Snapshot, stored: Stored) -> None:
    _apply(snap, stored)


async def in_use(db: AsyncSession, snap: Snapshot) -> bool:
    """A pending snapshot, one a running deployment uses, or the seed of an
    environment that hasn't deployed yet."""
    if snap.status == "pending":
        return True
    running = await db.scalar(select(Deployment.id).where(
        Deployment.snapshot_id == snap.id, Deployment.status == "running").limit(1))
    seeding = await db.scalar(select(Environment.id).where(
        Environment.seed_snapshot_id == snap.id, Environment.current_sha.is_(None)).limit(1))
    return running is not None or seeding is not None


async def delete(db: AsyncSession, settings: Settings, snap: Snapshot) -> Path:
    """Delete the row; the bundle file to remove once the caller has
    committed (it may not exist). The row is locked and re-read first, so a
    concurrent create_deployment (which locks it too) either finishes first
    (in use) or sees it gone. The path is returned whatever the status: a
    failed snapshot can still have a stored bundle when a cancel landed
    during ingest."""
    locked = await db.scalar(select(Snapshot).where(Snapshot.id == snap.id)
                             .with_for_update()
                             .execution_options(populate_existing=True))
    if locked is None:
        raise SnapshotError("snapshot_not_found")
    if await in_use(db, locked):
        raise SnapshotError("snapshot_in_use")
    path = root(settings) / (locked.bundle_file or f"{locked.id}.tar.gz")
    await db.delete(locked)
    await db.flush()
    return path


def sweep_incoming(settings: Settings) -> int:
    """Remove every *.upload and *.partial a crash left: in incoming/ and
    beside the bundles. Only for startup, when no upload is in flight.
    Sync; a missing folder is fine."""
    removed = 0
    for folder, patterns in ((incoming_dir(settings), ("*.upload", "*.partial")),
                             (root(settings), ("*.partial",))):
        if not folder.is_dir():
            continue
        for pattern in patterns:
            for path in folder.glob(pattern):
                if path.is_symlink() or path.is_file():
                    path.unlink(missing_ok=True)
                    removed += 1
    return removed


async def ready_snapshot(db: AsyncSession, snapshot_id: uuid.UUID) -> Snapshot:
    """A snapshot a deployment may restore."""
    snap = await db.get(Snapshot, snapshot_id)
    if snap is None:
        raise SnapshotError("snapshot_not_found")
    if snap.status != "ready":
        raise SnapshotError("snapshot_not_ready")
    return snap


# ---- JSON ----------------------------------------------------------------------

async def snapshot_out(db: AsyncSession, snap: Snapshot) -> dict:
    user = await db.get(User, snap.created_by) if snap.created_by else None
    job = None
    if snap.origin == "environment":
        job = await db.scalar(select(Deployment.id).where(
            Deployment.snapshot_id == snap.id, Deployment.mode == "snapshot")
            .order_by(Deployment.created_at.desc()).limit(1))
    return {
        "id": str(snap.id), "name": snap.name, "origin": snap.origin, "source": snap.source,
        "status": snap.status, "alembic_revision": snap.alembic_revision,
        "size_bytes": snap.size_bytes, "checksum": snap.checksum,
        "object_count": snap.object_count, "object_bytes": snap.object_bytes,
        "notes": snap.notes, "source_created_at": snap.source_created_at,
        "created_at": snap.created_at, "created_by_name": user.display_name if user else None,
        "deployment_id": str(job) if job else None,
    }


async def snapshot_ref(db: AsyncSession, snapshot_id) -> dict | None:
    """{id, name} for a deployment or environment that points at a snapshot."""
    if snapshot_id is None:
        return None
    snap = await db.get(Snapshot, snapshot_id)
    return {"id": str(snap.id), "name": snap.name} if snap else None
