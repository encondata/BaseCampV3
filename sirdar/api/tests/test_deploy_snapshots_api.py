"""Snapshot endpoints, seeded environments and Reset with a snapshot (phase 3)."""

import base64
import uuid

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Snapshot
from sirdar_api.deploy import pipeline, snapshots

from .api_helpers import auth_headers
from .bundle_helpers import make_bundle
from .deploy_factories import (  # noqa: F401
    ENV_SECRETS,
    fake_runner,
    leak_guard,
    make_environment,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_deployments_api import LS, OLD, SHA, _headers_without_change

SNAPSHOTS = "/api/deploy/snapshots"
START = "/api/deploy/environments/uat/deployments"
PEPPER = "dev-pepper-SECRET-0123456789abcdefABCDEF"
TOTP = Fernet.generate_key().decode()
KEYS_ENV = f"SS_PASSWORD_PEPPER={PEPPER}\nSS_TOTP_ENCRYPTION_KEY={TOTP}\n".encode()
BUILD = ["preflight", "bootstrap", "fetch", "render", "build"]


@pytest.fixture
async def ready(db, deploy_env, ssh_server, snapshots_dir):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    ssh_server.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    return await make_environment(db, current_sha=OLD)


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def _upload(client, h, tmp_path, *, name="dev-2026-10-04", data: bytes | None = None,
                  notes="from the Mac"):
    if data is None:
        data = make_bundle(tmp_path, name=f"{name}.tar.gz", source="mac-dev",
                           keys_member="keys.env", keys=KEYS_ENV).read_bytes()
    return await client.post(SNAPSHOTS, params={"name": name, "notes": notes},
                             content=data, headers={**h, "Content-Type": "application/gzip"})


async def _finish(body: dict) -> None:
    await pipeline.wait(uuid.UUID(body["id"]))


async def test_upload_list_and_delete(client, db, ready, tmp_path, leak_guard):
    leak_guard += [PEPPER, TOTP]
    h = await auth_headers(client, db)
    resp = await _upload(client, h, tmp_path)
    assert resp.status_code == 201, resp.text
    snap = resp.json()
    assert (snap["name"], snap["origin"], snap["source"], snap["status"], snap["notes"],
            snap["alembic_revision"], snap["object_count"], snap["created_by_name"],
            snap["deployment_id"]) == (
        "dev-2026-10-04", "upload", "mac-dev", "ready", "from the Mac", "0089", 2,
        "Boss User", None)
    assert snap["size_bytes"] > 0 and len(snap["checksum"]) == 64
    assert await _audits(db, "deploy.snapshot_upload") == [
        {"name": "dev-2026-10-04", "source": "mac-dev", "alembic_revision": "0089",
         "size_bytes": snap["size_bytes"], "checksum": snap["checksum"]}]
    listed = (await client.get(SNAPSHOTS, headers=h)).json()["snapshots"]
    assert [s["id"] for s in listed] == [snap["id"]]

    again = await _upload(client, h, tmp_path)
    assert (again.status_code, again.json()) == (409, {"detail": {"code": "snapshot_exists"}})

    resp = await client.delete(f"{SNAPSHOTS}/{snap['id']}", headers=h)
    assert resp.status_code == 204
    assert (await client.get(SNAPSHOTS, headers=h)).json() == {"snapshots": []}
    assert sorted(p.name for p in snapshots.root(get_settings()).iterdir()) == ["incoming"]
    assert await _audits(db, "deploy.snapshot_delete") == [{"name": "dev-2026-10-04"}]
    gone = await client.delete(f"{SNAPSHOTS}/{snap['id']}", headers=h)
    assert (gone.status_code, gone.json()) == (404, {"detail": {"code": "snapshot_not_found"}})


async def test_upload_errors(client, db, ready, tmp_path, monkeypatch, leak_guard):
    h = await auth_headers(client, db)
    resp = await _upload(client, h, tmp_path, name="bad name")
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "snapshot_name_invalid"}})
    resp = await _upload(client, h, tmp_path, data=b"not a bundle at all")
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "bundle_invalid",
                                     "reason": "The file isn't a complete .tar.gz bundle."}
    monkeypatch.setenv("SIRDAR_SNAPSHOT_MAX_BYTES", "10")
    get_settings.cache_clear()
    resp = await _upload(client, h, tmp_path)
    assert (resp.status_code, resp.json()) == (413, {"detail": {
        "code": "snapshot_too_large", "max_bytes": 10}})
    assert await _audits(db, "deploy.snapshot_upload") == []


async def test_snapshot_permissions(client, db, ready, tmp_path, leak_guard):
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(SNAPSHOTS, headers=admin)).json() == {"snapshots": []}
    for resp in (await _upload(client, admin, tmp_path),
                 await client.post("/api/deploy/environments/uat/snapshots", headers=admin,
                                   json={"name": "x1"}),
                 await client.delete(f"{SNAPSHOTS}/{uuid.uuid4()}", headers=admin)):
        assert resp.status_code == 403
    adder = await _headers_without_change(client, db)
    resp = await _upload(client, adder, tmp_path)
    assert resp.status_code == 201
    resp = await client.delete(f"{SNAPSHOTS}/{resp.json()['id']}", headers=adder)
    assert resp.status_code == 403
    assert (await client.get(SNAPSHOTS)).status_code == 401


async def test_take_snapshot(client, db, ready, fake_runner, tmp_path, leak_guard):
    settings = get_settings()

    def fetched(request):
        token = base64.b64decode(request.extravars["keys_enc_b64"])
        src = make_bundle(tmp_path, name="fetched.tar.gz", keys=token)
        src.replace(request.extravars["snapshot_dest"])

    fake_runner.effects["export"] = fetched
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/uat/snapshots", headers=h,
                             json={"name": "uat-2026-10-04", "notes": "before uat2"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["snapshot"]["status"], body["snapshot"]["source"]) == ("pending", "uat")
    dep = body["deployment"]
    assert (dep["mode"], dep["sha"], dep["snapshot"]["name"]) == (
        "snapshot", OLD, "uat-2026-10-04")
    assert body["snapshot"]["deployment_id"] == dep["id"]
    assert [s["key"] for s in dep["steps"]] == ["preflight", "export"]
    await _finish(dep)
    snap = (await client.get(SNAPSHOTS, headers=h)).json()["snapshots"][0]
    assert (snap["status"], snap["origin"], snap["notes"]) == (
        "ready", "environment", "before uat2")
    env = (await client.get("/api/deploy/environments/uat", headers=h)).json()
    assert (env["status"], env["current_sha"]) == ("ready", OLD)
    assert await _audits(db, "deploy.snapshot_take") == [
        {"environment": "uat", "mode": "snapshot", "git_ref": "main", "sha": OLD,
         "snapshot": "uat-2026-10-04"}]
    leak_guard.append(base64.b64encode(snapshots.encrypt_keys(settings, ENV_SECRETS)).decode())


async def test_take_snapshot_errors(client, db, ready, fake_runner, leak_guard):
    h = await auth_headers(client, db)
    await make_environment(db, name="fresh")
    resp = await client.post("/api/deploy/environments/fresh/snapshots", headers=h,
                             json={"name": "x1"})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_deployed"}})
    resp = await client.post("/api/deploy/environments/uat/snapshots", headers=h,
                             json={"name": "has space"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "snapshot_name_invalid"}})
    assert await db.scalar(select(Snapshot.id)) is None


async def _ready_snapshot(client, h, tmp_path, name="dev-2026-10-04") -> dict:
    resp = await _upload(client, h, tmp_path, name=name)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_reset_with_a_snapshot(client, db, ready, fake_runner, tmp_path, leak_guard):
    leak_guard += [PEPPER, TOTP]
    h = await auth_headers(client, db)
    snap = await _ready_snapshot(client, h, tmp_path)
    resp = await client.post(START, headers=h, json={"mode": "update", "snapshot_id": snap["id"]})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "snapshot_not_allowed"}})
    resp = await client.post(START, headers=h, json={"mode": "reset", "confirm_name": "uat",
                                                     "snapshot_id": str(uuid.uuid4())})
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "snapshot_not_found"}})
    resp = await client.post(START, headers=h, json={"mode": "reset", "confirm_name": "uat",
                                                     "snapshot_id": snap["id"]})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [s["key"] for s in body["steps"]] == [*BUILD, "reset", "data", "restore", "up"]
    assert body["snapshot"] == {"id": snap["id"], "name": "dev-2026-10-04"}
    in_use = await client.delete(f"{SNAPSHOTS}/{snap['id']}", headers=h)
    assert (in_use.status_code, in_use.json()) == (409, {"detail": {"code": "snapshot_in_use"}})
    await _finish(body)
    assert (await client.get(f"/api/deploy/deployments/{body['id']}", headers=h)).json()[
        "status"] == "succeeded"
    assert await _audits(db, "deploy.deployment_start") == [
        {"environment": "uat", "mode": "reset", "git_ref": "main", "sha": SHA,
         "snapshot": "dev-2026-10-04"}]


async def test_create_from_a_snapshot_restores_on_the_first_deploy(
        client, db, ready, fake_runner, tmp_path, leak_guard):
    h = await auth_headers(client, db)
    snap = await _ready_snapshot(client, h, tmp_path)
    new = {"mode": "new", "name": "uat2", "type": "custom", "target": "ssh",
           "proxy_ip": "10.10.48.6", "snapshot_id": snap["id"]}
    resp = await client.post("/api/deploy/environments", headers=h,
                             json={**new, "snapshot_id": str(uuid.uuid4())})
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "snapshot_not_found"}})
    resp = await client.post("/api/deploy/environments", headers=h,
                             json={"mode": "adopt", "name": "uat2", "type": "dev",
                                   "target": "ssh", "snapshot_id": snap["id"]})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "snapshot_not_allowed"}})
    resp = await client.post("/api/deploy/environments", headers=h, json=new)
    assert resp.status_code == 201, resp.text
    assert resp.json()["seed_snapshot"] == {"id": snap["id"], "name": "dev-2026-10-04"}
    in_use = await client.delete(f"{SNAPSHOTS}/{snap['id']}", headers=h)
    assert in_use.status_code == 409                       # uat2 hasn't deployed yet

    url = "/api/deploy/environments/uat2/deployments"
    first = (await client.post(url, headers=h, json={})).json()
    assert [s["key"] for s in first["steps"]] == [*BUILD, "dump", "data", "restore", "up"]
    assert first["snapshot"]["name"] == "dev-2026-10-04"
    await _finish(first)
    second = (await client.post(url, headers=h, json={})).json()
    assert [s["key"] for s in second["steps"]] == [*BUILD, "dump", "up"]
    assert second["snapshot"] is None
    await _finish(second)


async def test_a_snapshot_failed_after_the_route_check_answers_409(
        client, db, ready, fake_runner, tmp_path, monkeypatch, leak_guard):
    """create_deployment re-checks the locked row; its SnapshotError is a 4xx,
    and nothing is left behind."""
    from sqlalchemy import update

    from sirdar_api.db.engine import get_sessionmaker
    from sirdar_api.db.models import Deployment

    h = await auth_headers(client, db)
    snap = await _ready_snapshot(client, h, tmp_path)
    real = snapshots.ready_snapshot

    async def then_failed(session, snapshot_id):
        found = await real(session, snapshot_id)
        async with get_sessionmaker()() as other:
            await other.execute(update(Snapshot).where(Snapshot.id == snapshot_id)
                                .values(status="failed"))
            await other.commit()
        return found

    monkeypatch.setattr(snapshots, "ready_snapshot", then_failed)
    resp = await client.post(START, headers=h, json={"mode": "reset", "confirm_name": "uat",
                                                     "snapshot_id": snap["id"]})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "snapshot_not_ready"}})
    assert await db.scalar(select(Deployment.id)) is None
    env = (await client.get("/api/deploy/environments/uat", headers=h)).json()
    assert env["status"] == "ready"
    assert await _audits(db, "deploy.deployment_start") == []


async def test_delete_a_failed_snapshot_removes_its_leftover_bundle(
        client, db, ready, tmp_path, leak_guard):
    h = await auth_headers(client, db)
    snap = Snapshot(name="half-in", origin="environment", source="uat", status="failed")
    db.add(snap)
    await db.commit()
    snapshots.ensure_dirs(get_settings())
    leftover = snapshots.root(get_settings()) / f"{snap.id}.tar.gz"
    leftover.write_bytes(b"stored before the cancel landed")
    resp = await client.delete(f"{SNAPSHOTS}/{snap.id}", headers=h)
    assert resp.status_code == 204
    assert not leftover.exists()
