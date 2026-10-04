import gzip
import json
import uuid

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, Snapshot
from sirdar_api.deploy import bundle, snapshots, vault
from sirdar_api.deploy.snapshots import SnapshotError

from .bundle_helpers import make_bundle
from .deploy_factories import (  # noqa: F401
    ENV_SECRETS,
    make_environment,
    secrets_key,
    snapshots_dir,
)

PEPPER = "dev-pepper-SECRET-0123456789abcdefABCDEF"
TOTP = Fernet.generate_key().decode()
KEYS_ENV = f"SS_PASSWORD_PEPPER={PEPPER}\nSS_TOTP_ENCRYPTION_KEY={TOTP}\n".encode()


async def _chunks(data: bytes, size: int = 300):
    for i in range(0, len(data), size):
        yield data[i:i + size]


async def _upload(db, data: bytes, *, name="dev-2026-10-04", notes=" seeded from dev ",
                  length: int | None | str = "auto") -> Snapshot:
    """length: the Content-Length the client announced ("auto" = the real one)."""
    snap = await snapshots.receive_upload(
        db, get_settings(), name=name, notes=notes, chunks=_chunks(data),
        content_length=len(data) if length == "auto" else length, actor_id=None)
    await db.commit()
    return snap


def _keys_env_bundle(tmp_path, **kw) -> bytes:
    return make_bundle(tmp_path, keys_member="keys.env", keys=KEYS_ENV, **kw).read_bytes()


async def test_upload_encrypts_plain_keys_and_keeps_the_bundle(db, tmp_path, snapshots_dir):
    snap = await _upload(db, _keys_env_bundle(tmp_path, source="mac-dev"))
    assert (snap.name, snap.origin, snap.source, snap.status, snap.notes) == (
        "dev-2026-10-04", "upload", "mac-dev", "ready", "seeded from dev")
    assert (snap.alembic_revision, snap.object_count) == ("0089", 2)
    path = snapshots_dir / f"{snap.id}.tar.gz"
    assert snap.bundle_file == path.name
    assert (snap.size_bytes, snap.checksum) == (path.stat().st_size, bundle.sha256_file(path))
    assert path.stat().st_mode & 0o777 == 0o600
    assert snapshots_dir.stat().st_mode & 0o777 == 0o700
    assert list((snapshots_dir / "incoming").iterdir()) == []
    assert PEPPER.encode() not in gzip.decompress(path.read_bytes())
    assert snapshots.read_keys(get_settings(), snap) == {
        "SS_PASSWORD_PEPPER": PEPPER, "SS_TOTP_ENCRYPTION_KEY": TOTP}


async def test_upload_of_a_bundle_with_keys_enc(db, tmp_path, snapshots_dir):
    token = snapshots.encrypt_keys(get_settings(), {"SS_PASSWORD_PEPPER": PEPPER,
                                                    "SS_TOTP_ENCRYPTION_KEY": TOTP})
    snap = await _upload(db, make_bundle(tmp_path, keys=token).read_bytes())
    assert snapshots.read_keys(get_settings(), snap)["SS_PASSWORD_PEPPER"] == PEPPER


async def test_keys_from_another_sirdar_are_refused(db, tmp_path, snapshots_dir):
    other = Fernet(Fernet.generate_key()).encrypt(json.dumps(
        {"SS_PASSWORD_PEPPER": PEPPER, "SS_TOTP_ENCRYPTION_KEY": TOTP}).encode())
    with pytest.raises(SnapshotError) as exc:
        await _upload(db, make_bundle(tmp_path, keys=other).read_bytes())
    assert exc.value.code == "snapshot_keys_unreadable"
    assert sorted(p.name for p in snapshots_dir.iterdir()) == ["incoming"]


@pytest.mark.parametrize("keys", [
    b"SS_PASSWORD_PEPPER=only-the-pepper\n",
    b"SS_PASSWORD_PEPPER=p\nSS_TOTP_ENCRYPTION_KEY=not-a-fernet-key\n",
    f"SS_PASSWORD_PEPPER=CHANGEME\nSS_TOTP_ENCRYPTION_KEY={TOTP}\n".encode(),
])
async def test_bad_plain_keys_are_refused(db, tmp_path, snapshots_dir, keys):
    data = make_bundle(tmp_path, keys_member="keys.env", keys=keys).read_bytes()
    with pytest.raises(SnapshotError) as exc:
        await _upload(db, data)
    assert (exc.value.code, exc.value.reason) == ("bundle_invalid", snapshots._KEYS_INVALID)
    assert await db.scalar(select(Snapshot.id)) is None


async def test_a_damaged_upload_leaves_nothing(db, tmp_path, snapshots_dir):
    data = _keys_env_bundle(tmp_path)
    with pytest.raises(SnapshotError) as exc:
        await _upload(db, data[: len(data) // 2])
    assert exc.value.code == "bundle_invalid"
    assert exc.value.reason == bundle._DAMAGED
    assert sorted(p.name for p in snapshots_dir.iterdir()) == ["incoming"]
    assert list((snapshots_dir / "incoming").iterdir()) == []


async def test_size_cap(db, tmp_path, snapshots_dir, monkeypatch):
    data = _keys_env_bundle(tmp_path)
    monkeypatch.setenv("SIRDAR_SNAPSHOT_MAX_BYTES", str(len(data) - 1))
    get_settings.cache_clear()
    with pytest.raises(SnapshotError) as exc:            # announced too large
        await _upload(db, data)
    assert exc.value.extra == {"max_bytes": len(data) - 1}
    with pytest.raises(SnapshotError) as exc:            # no length: counted while streaming
        await _upload(db, data, length=None)
    assert exc.value.code == "snapshot_too_large"
    assert list((snapshots_dir / "incoming").iterdir()) == []


async def test_names_notes_and_duplicates(db, tmp_path, snapshots_dir):
    data = _keys_env_bundle(tmp_path)
    for bad in ("", "-x", "a b", "x" * 65, "ünï"):
        with pytest.raises(SnapshotError) as exc:
            await _upload(db, data, name=bad)
        assert exc.value.code == "snapshot_name_invalid"
    with pytest.raises(SnapshotError) as exc:
        await _upload(db, data, notes="n" * 2001)
    assert exc.value.code == "notes_too_long"
    await _upload(db, data)
    with pytest.raises(SnapshotError) as exc:
        await _upload(db, data)
    assert exc.value.code == "snapshot_exists"


async def test_upload_needs_the_secrets_key(db, tmp_path, snapshots_dir, monkeypatch):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(SnapshotError) as exc:
        await _upload(db, b"anything")
    assert exc.value.code == "secrets_key_missing"


async def test_take_flow_and_in_use(db, tmp_path, snapshots_dir):
    settings = get_settings()
    env = await make_environment(db, current_sha="a" * 40)
    snap = await snapshots.begin_take(db, settings, env, name="uat-2026-10-04", notes="",
                                      actor_id=None)
    await db.commit()
    assert (snap.status, snap.origin, snap.source, snap.bundle_file) == (
        "pending", "environment", "uat", None)
    assert await snapshots.in_use(db, snap)
    token = snapshots.encrypt_keys(settings, ENV_SECRETS)
    fetched = snapshots.fetched_path(settings, snap.id)
    fetched.write_bytes(make_bundle(tmp_path, keys=token).read_bytes())
    stored = snapshots.ingest_fetched(settings, snap.id)
    snapshots.mark_ready(snap, stored)
    await db.commit()
    assert not fetched.exists()
    assert (snap.status, snap.alembic_revision) == ("ready", "0089")
    assert snapshots.read_keys(settings, snap) == {
        k: ENV_SECRETS[k] for k in snapshots.KEY_NAMES}
    assert not await snapshots.in_use(db, snap)

    env.seed_snapshot_id = snap.id
    other = await make_environment(db, name="uat2")
    other.seed_snapshot_id = snap.id
    await db.commit()
    assert await snapshots.in_use(db, snap)            # uat2 hasn't deployed yet
    with pytest.raises(SnapshotError) as exc:
        await snapshots.delete(db, settings, snap)
    assert exc.value.code == "snapshot_in_use"
    other.current_sha = "b" * 40
    db.add(Deployment(environment_id=env.id, mode="reset", git_ref="main", sha="c" * 40,
                      status="running", snapshot_id=snap.id))
    await db.commit()
    assert await snapshots.in_use(db, snap)            # a running reset restores it
    await db.execute(Deployment.__table__.update().values(status="succeeded"))
    await db.commit()
    path = snapshots.bundle_path(settings, snap)
    assert await snapshots.delete(db, settings, snap) == path
    await db.commit()
    assert path.exists()                         # the caller removes it after the commit
    assert await db.get(Snapshot, snap.id) is None


async def test_take_needs_a_deployed_environment(db, snapshots_dir):
    env = await make_environment(db)
    with pytest.raises(SnapshotError) as exc:
        await snapshots.begin_take(db, get_settings(), env, name="x1", notes=None, actor_id=None)
    assert exc.value.code == "not_deployed"


async def test_ingest_refuses_a_missing_or_plain_bundle(db, tmp_path, snapshots_dir):
    settings = get_settings()
    snapshots.ensure_dirs(settings)
    sid = uuid.uuid4()
    with pytest.raises(SnapshotError) as exc:
        snapshots.ingest_fetched(settings, sid)
    assert exc.value.reason == "The snapshot bundle never arrived."
    snapshots.fetched_path(settings, sid).write_bytes(_keys_env_bundle(tmp_path))
    with pytest.raises(SnapshotError) as exc:
        snapshots.ingest_fetched(settings, sid)
    assert exc.value.reason == snapshots._KEYS_INVALID
    assert not snapshots.fetched_path(settings, sid).exists()


async def test_read_keys_reports_a_missing_file(db, snapshots_dir):
    snap = Snapshot(name="gone", origin="upload", source="x", status="ready",
                    bundle_file="nope.tar.gz")
    with pytest.raises(SnapshotError) as exc:
        snapshots.read_keys(get_settings(), snap)
    assert exc.value.code == "snapshot_file_missing"
    assert "SIRDAR_SNAPSHOTS_DIR" in exc.value.reason


async def test_snapshot_out_has_no_keys(db, tmp_path, snapshots_dir):
    snap = await _upload(db, _keys_env_bundle(tmp_path))
    out = await snapshots.snapshot_out(db, snap)
    assert set(out) == {"id", "name", "origin", "source", "status", "alembic_revision",
                        "size_bytes", "checksum", "object_count", "object_bytes", "notes",
                        "source_created_at", "created_at", "created_by_name", "deployment_id"}
    assert PEPPER not in repr(out) and TOTP not in repr(out)
    assert vault.is_configured(get_settings())


async def test_bundle_checks_cap_decompression_at_four_times_the_upload_cap(
        db, tmp_path, snapshots_dir, monkeypatch):
    monkeypatch.setenv("SIRDAR_SNAPSHOT_MAX_BYTES", "1000000")
    get_settings.cache_clear()
    seen: list[tuple[str, int | None]] = []
    real_verify, real_rewrite = bundle.verify, bundle.rewrite_keys

    def verify(path, **kw):
        seen.append(("verify", kw.get("max_bytes")))
        return real_verify(path, **kw)

    def rewrite_keys(src, out, keys_enc, **kw):
        seen.append(("rewrite_keys", kw.get("max_bytes")))
        return real_rewrite(src, out, keys_enc, **kw)

    monkeypatch.setattr(bundle, "verify", verify)
    monkeypatch.setattr(bundle, "rewrite_keys", rewrite_keys)
    await _upload(db, _keys_env_bundle(tmp_path))
    token = snapshots.encrypt_keys(get_settings(), {"SS_PASSWORD_PEPPER": PEPPER,
                                                    "SS_TOTP_ENCRYPTION_KEY": TOTP})
    await _upload(db, make_bundle(tmp_path, name="b2.tar.gz", keys=token).read_bytes(),
                  name="second")
    assert seen == [("rewrite_keys", 4_000_000), ("verify", 4_000_000)]
