"""The pipeline's snapshot modes: restore a snapshot (Reset, first deploy),
Restore backup, Roll back and Take snapshot."""

import asyncio
import base64

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentSecret, Snapshot
from sirdar_api.deploy import envfile, pipeline, snapshots, vault
from sirdar_api.deploy.runner import RunResult

from .bundle_helpers import make_bundle
from .deploy_factories import (  # noqa: F401
    ENV_SECRETS,
    fake_runner,
    make_environment,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_pipeline import OLD, SHA, _load

SNAP_KEYS = {"SS_PASSWORD_PEPPER": "dev-pepper-SECRET-abcdef0123456789",
             "SS_TOTP_ENCRYPTION_KEY": Fernet.generate_key().decode()}
BUILD = ["preflight", "bootstrap", "fetch", "render", "build"]


@pytest.fixture
async def env(db, deploy_env, ssh_server, snapshots_dir):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    return await make_environment(db, current_sha=OLD)


async def _ready_snapshot(db, tmp_path, name="dev-2026-10-04") -> Snapshot:
    settings = get_settings()
    snapshots.ensure_dirs(settings)
    snap = Snapshot(name=name, origin="upload", source="mac-dev", status="pending")
    db.add(snap)
    await db.flush()
    src = make_bundle(tmp_path, name=f"{name}.tar.gz",
                      keys=snapshots.encrypt_keys(settings, SNAP_KEYS))
    snapshots.mark_ready(snap, snapshots.store_bundle(settings, src, snap.id))
    await db.commit()
    return snap


async def _run(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, git_ref="main", sha=kw.pop("sha", SHA),
                                           actor_id=None, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def _secret(db, env_id, key) -> str:
    row = await db.scalar(select(EnvironmentSecret).where(
        EnvironmentSecret.environment_id == env_id, EnvironmentSecret.key == key)
        .execution_options(populate_existing=True))
    return vault.decrypt(get_settings(), row.value_enc)


async def test_reset_with_a_snapshot_restores_it_and_keeps_its_keys(db, env, fake_runner,
                                                                    tmp_path):
    snap = await _ready_snapshot(db, tmp_path)
    fake_runner.output["restore"] = [f"pepper {SNAP_KEYS['SS_PASSWORD_PEPPER']}\n"]
    dep_id = await _run(db, env, mode="reset", snapshot_id=snap.id)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == [*BUILD, "reset", "data", "restore", "up"]
    assert [s.number for s in steps] == [1, 2, 3, 4, 5, 7, 8, 9, 10]
    assert (dep.status, dep.snapshot_id, e.status, e.current_sha) == (
        "succeeded", snap.id, "ready", SHA)
    render = next(r for r in fake_runner.requests if r.step == "render")
    values = envfile.parse_env(base64.b64decode(render.extravars["env_file_b64"]).decode())
    assert values["SS_PASSWORD_PEPPER"] == SNAP_KEYS["SS_PASSWORD_PEPPER"]
    assert values["SS_TOTP_ENCRYPTION_KEY"] == SNAP_KEYS["SS_TOTP_ENCRYPTION_KEY"]
    assert values["POSTGRES_PASSWORD"] == ENV_SECRETS["POSTGRES_PASSWORD"]
    restore = next(r for r in fake_runner.requests if r.step == "restore")
    # Reset data checks the snapshot's revision before it wipes anything.
    reset = next(r for r in fake_runner.requests if r.step == "reset")
    assert reset.extravars["snapshot_revision"] == "0089"
    assert restore.extravars["bundle_path"] == str(snapshots.bundle_path(get_settings(), snap))
    assert restore.extravars["bundle_tool"] == snapshots.BUNDLE_TOOL
    assert restore.extravars["snapshot_revision"] == "0089"
    assert restore.extravars["api_image"] == "serversherpa-api:e73b99ca"
    assert steps[7].log == "pepper [redacted]\n"
    for key, value in SNAP_KEYS.items():
        assert await _secret(db, env.id, key) == value
    assert await _secret(db, env.id, "SS_JWT_SECRET") == ENV_SECRETS["SS_JWT_SECRET"]


async def test_an_update_dump_isnt_told_it_restores(db, env, fake_runner):
    await _run(db, env, mode="update")
    dump = next(r for r in fake_runner.requests if r.step == "dump")
    assert dump.extravars["restores_snapshot"] is False


async def test_a_plain_reset_has_no_revision_check(db, env, fake_runner):
    dep, _, _ = await _load(await _run(db, env, mode="reset"))
    assert dep.status == "succeeded"
    reset = next(r for r in fake_runner.requests if r.step == "reset")
    assert "snapshot_revision" not in reset.extravars


async def test_a_too_new_snapshot_stops_the_reset_before_the_wipe(db, env, fake_runner,
                                                                  tmp_path):
    """reset.yml refuses it (its playbook test): the deployment fails at 7 and
    no later step runs."""
    snap = await _ready_snapshot(db, tmp_path)
    fake_runner.results["reset"] = RunResult(status="failed", rc=2)
    dep, steps, e = await _load(await _run(db, env, mode="reset", snapshot_id=snap.id))
    assert (dep.status, dep.failed_step, e.status) == ("failed", 7, "failed")
    assert fake_runner.steps() == [*BUILD, "reset"]
    assert await _secret(db, env.id, "SS_PASSWORD_PEPPER") == ENV_SECRETS["SS_PASSWORD_PEPPER"]


async def test_a_failed_restore_keeps_the_old_keys(db, env, fake_runner, tmp_path):
    snap = await _ready_snapshot(db, tmp_path)
    fake_runner.results["restore"] = RunResult(status="failed", rc=2)
    dep, _, e = await _load(await _run(db, env, mode="reset", snapshot_id=snap.id))
    assert (dep.status, dep.failed_step, e.status) == ("failed", 9, "failed")
    assert await _secret(db, env.id, "SS_PASSWORD_PEPPER") == ENV_SECRETS["SS_PASSWORD_PEPPER"]


async def test_first_deploy_of_a_seeded_environment_restores(db, env, fake_runner, tmp_path):
    snap = await _ready_snapshot(db, tmp_path)
    env.current_sha = None
    await db.commit()
    dep, _, _ = await _load(await _run(db, env, mode="update", snapshot_id=snap.id))
    assert fake_runner.steps() == [*BUILD, "dump", "data", "restore", "up"]
    assert dep.status == "succeeded"
    # Whatever database is already there (Create chosen over Adopt on a host
    # that runs the environment) is backed up before ss-stack restore drops
    # it; an empty host has none, so the dump isn't required.
    dump = next(r for r in fake_runner.requests if r.step == "dump")
    assert dump.extravars["dump_required"] is False
    # ...and refuses to restore over a database that exists but is stopped.
    assert dump.extravars["restores_snapshot"] is True


async def test_a_seeded_first_deploy_keeps_the_dump_it_took(db, env, fake_runner, tmp_path):
    snap = await _ready_snapshot(db, tmp_path)
    env.current_sha = None
    await db.commit()
    fake_runner.results["dump"] = RunResult(
        status="successful", rc=0,
        data={"dump_path": "/opt/serversherpa/uat/backups/20261004T010203Z.dump"})
    dep, steps, _ = await _load(await _run(db, env, mode="update", snapshot_id=snap.id))
    assert [s.number for s in steps] == [1, 2, 3, 4, 5, 6, 8, 9, 10]
    assert (dep.status, dep.dump_path) == (
        "succeeded", "/opt/serversherpa/uat/backups/20261004T010203Z.dump")


async def test_a_deleted_snapshot_fails_step_one(db, env, fake_runner, tmp_path):
    snap = await _ready_snapshot(db, tmp_path)
    snapshots.bundle_path(get_settings(), snap).unlink()
    dep, steps, _ = await _load(await _run(db, env, mode="reset", snapshot_id=snap.id))
    assert fake_runner.requests == []
    assert (dep.status, dep.failed_step) == ("failed", 1)
    assert "missing from SIRDAR_SNAPSHOTS_DIR" in steps[0].log


async def test_restore_backup_and_roll_back(db, env, fake_runner):
    dep, _, e = await _load(await _run(db, env, mode="restore_dump", sha=OLD,
                                       restore_dump="20261004T010203Z.dump"))
    assert fake_runner.steps() == ["preflight", "fetch", "render", "build", "data",
                                   "restore_dump", "up"]
    request = next(r for r in fake_runner.requests if r.step == "restore_dump")
    assert request.extravars["dump_name"] == "20261004T010203Z.dump"
    assert (dep.status, e.current_sha) == ("succeeded", OLD)
    # The deployed commit's code and Sirdar's stored keys, whatever a failed
    # Update (or a failed restoring Reset) left in repo/ and .env.
    ran = {r.step: r.extravars for r in fake_runner.requests}
    assert ran["fetch"]["sha"] == OLD
    values = envfile.parse_env(base64.b64decode(ran["render"]["env_file_b64"]).decode())
    assert values["SS_PASSWORD_PEPPER"] == ENV_SECRETS["SS_PASSWORD_PEPPER"]
    assert values["SS_TOTP_ENCRYPTION_KEY"] == ENV_SECRETS["SS_TOTP_ENCRYPTION_KEY"]
    assert values["STACK_IMAGE_TAG"] == "aaaaaaaa"

    fake_runner.requests.clear()
    dep, _, e = await _load(await _run(db, env, mode="rollback", sha="b" * 40,
                                       restore_dump="20261004T010203Z.dump"))
    assert fake_runner.steps() == ["preflight", "fetch", "render", "build", "data",
                                   "restore_dump", "up"]
    assert (dep.status, e.current_sha, e.image_tag) == ("succeeded", "b" * 40, "bbbbbbbb")


def _fetch_bundle(keys: bytes, tmp_path):
    """What export.yml leaves on Sirdar: the bundle at snapshot_dest."""
    def effect(request):
        src = make_bundle(tmp_path, name="fetched-src.tar.gz", source="uat", keys=keys)
        src.replace(request.extravars["snapshot_dest"])
    return effect


async def _take(db, env, name="uat-2026-10-04"):
    snap = await snapshots.begin_take(db, get_settings(), env, name=name, notes="",
                                      actor_id=None)
    await db.commit()
    dep_id = await _run(db, env, mode="snapshot", sha=env.current_sha, snapshot_id=snap.id)
    return dep_id, snap.id


async def test_take_snapshot(db, env, fake_runner, tmp_path):
    env.status = "failed"                        # a job never changes the environment
    await db.commit()
    settings = get_settings()

    def effect(request):
        token = base64.b64decode(request.extravars["keys_enc_b64"])
        assert snapshots.decrypt_keys(settings, token) == {
            k: ENV_SECRETS[k] for k in snapshots.KEY_NAMES}
        _fetch_bundle(token, tmp_path)(request)

    fake_runner.effects["export"] = effect
    dep_id, snap_id = await _take(db, env)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == ["preflight", "export"]
    assert [s.number for s in steps] == [1, 11]
    export = fake_runner.requests[1].extravars
    assert export["snapshot_dest"] == str(snapshots.fetched_path(settings, snap_id))
    assert (export["api_image"], export["spaces_bucket"]) == (
        "serversherpa-api:aaaaaaaa", "serversherpa")
    assert (dep.status, e.status, e.current_sha) == ("succeeded", "failed", OLD)
    snap = await db.get(Snapshot, snap_id, populate_existing=True)
    assert (snap.status, snap.source, snap.alembic_revision) == ("ready", "uat", "0089")
    assert snapshots.bundle_path(settings, snap).is_file()
    assert not snapshots.fetched_path(settings, snap_id).exists()


async def test_take_snapshot_redacts_the_keys_token(db, env):
    snap = await snapshots.begin_take(db, get_settings(), env, name="redact-me", notes="",
                                      actor_id=None)
    dep = await pipeline.create_deployment(db, env, mode="snapshot", git_ref="main", sha=OLD,
                                           actor_id=None, snapshot_id=snap.id)
    await db.commit()
    ctx = await pipeline._prepare(db, env, dep, get_settings())
    b64 = ctx.vars_for("export")["keys_enc_b64"]
    token = base64.b64decode(b64).decode()
    assert ctx.redactor(f"{b64} {token}") == "[redacted] [redacted]"


async def test_a_bundle_that_never_arrived_fails_the_job(db, env, fake_runner):
    dep_id, snap_id = await _take(db, env)
    dep, steps, e = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 11)
    assert dep.error == "Step 11 (Take snapshot) failed: The snapshot bundle never arrived."
    assert steps[1].log.endswith("The snapshot bundle never arrived.\n")
    assert (await db.get(Snapshot, snap_id, populate_existing=True)).status == "failed"
    assert (e.status, e.current_sha) == ("ready", OLD)


async def test_a_cancelled_job_fails_its_snapshot(db, env, fake_runner):
    fake_runner.gates["export"] = asyncio.Event()
    snap = await snapshots.begin_take(db, get_settings(), env, name="cancel-me", notes="",
                                      actor_id=None)
    dep = await pipeline.create_deployment(db, env, mode="snapshot", git_ref="main",
                                           sha=OLD, actor_id=None, snapshot_id=snap.id)
    await db.commit()
    pipeline.launch(dep.id)
    await asyncio.wait_for(fake_runner.started["export"].wait(), 5)
    pipeline.request_cancel(dep.id)
    await pipeline.wait(dep.id)
    d, _, e = await _load(dep.id)
    assert d.status == "cancelled"
    assert (await db.get(Snapshot, snap.id, populate_existing=True)).status == "failed"
    assert e.status == "ready"


async def test_recover_orphans_fails_a_pending_snapshot(db, env):
    snap = await snapshots.begin_take(db, get_settings(), env, name="orphan", notes="",
                                      actor_id=None)
    await pipeline.create_deployment(db, env, mode="snapshot", git_ref="main", sha=OLD,
                                     actor_id=None, snapshot_id=snap.id)
    await db.commit()
    assert await pipeline.recover_orphans() == 1
    assert (await db.get(Snapshot, snap.id, populate_existing=True)).status == "failed"


async def test_plan_of(db, env):
    dep = await pipeline.create_deployment(db, env, mode="restore_dump", git_ref="main",
                                           sha=OLD, actor_id=None, restore_dump="x.dump")
    assert [s.key for s in pipeline.plan_of(dep)] == ["preflight", "fetch", "render", "build",
                                                      "data", "restore_dump", "up"]
    assert pipeline.restores("reset", dep.id) and not pipeline.restores("snapshot", dep.id)
    assert not pipeline.restores("reset", None)


async def test_recover_orphans_discards_the_half_fetched_bundle(db, env):
    settings = get_settings()
    snap = await snapshots.begin_take(db, settings, env, name="half", notes="",
                                      actor_id=None)
    await pipeline.create_deployment(db, env, mode="snapshot", git_ref="main", sha=OLD,
                                     actor_id=None, snapshot_id=snap.id)
    await db.commit()
    snapshots.fetched_path(settings, snap.id).write_bytes(b"partial")
    assert await pipeline.recover_orphans() == 1
    assert not snapshots.fetched_path(settings, snap.id).exists()
    e = await db.get(type(env), env.id, populate_existing=True)
    assert e.status == "ready"


async def test_a_restore_needs_a_ready_snapshot_at_create(db, env, tmp_path):
    """create_deployment locks the snapshot row and re-checks it, so a
    concurrent delete can't slip in between the route's check and the insert."""
    snap = await _ready_snapshot(db, tmp_path)
    snap_id = snap.id
    snap.status = "failed"
    await db.commit()
    with pytest.raises(snapshots.SnapshotError) as caught:
        await pipeline.create_deployment(db, env, mode="reset", git_ref="main", sha=SHA,
                                         actor_id=None, snapshot_id=snap_id)
    assert caught.value.code == "snapshot_not_ready"
    await db.rollback()
    await db.delete(await db.get(Snapshot, snap_id))
    await db.commit()
    await db.refresh(env)                       # the rollback expired it
    with pytest.raises(snapshots.SnapshotError) as caught:
        await pipeline.create_deployment(db, env, mode="reset", git_ref="main", sha=SHA,
                                         actor_id=None, snapshot_id=snap_id)
    assert caught.value.code == "snapshot_not_found"


async def test_restore_secrets_never_reach_the_error_or_logs(db, env, fake_runner, tmp_path):
    snap = await _ready_snapshot(db, tmp_path)
    fake_runner.output["restore"] = [f"{v}\n" for v in SNAP_KEYS.values()]
    fake_runner.results["restore"] = RunResult(status="failed", rc=2)
    dep, steps, _ = await _load(await _run(db, env, mode="reset", snapshot_id=snap.id))
    text = (dep.error or "") + "".join(s.log or "" for s in steps)
    for value in SNAP_KEYS.values():
        assert value not in text


async def test_create_rechecks_the_locked_row_not_a_stale_copy(db, env, tmp_path):
    """The snapshot this session already holds says ready; another session
    failed it since. The locked select must read the row, not the copy."""
    from sqlalchemy import update

    from sirdar_api.db.engine import get_sessionmaker

    snap = await _ready_snapshot(db, tmp_path)
    assert snap.status == "ready"                      # in this session's identity map
    async with get_sessionmaker()() as other:
        await other.execute(update(Snapshot).where(Snapshot.id == snap.id)
                            .values(status="failed"))
        await other.commit()
    with pytest.raises(snapshots.SnapshotError) as caught:
        await pipeline.create_deployment(db, env, mode="reset", git_ref="main", sha=SHA,
                                         actor_id=None, snapshot_id=snap.id)
    assert caught.value.code == "snapshot_not_ready"
