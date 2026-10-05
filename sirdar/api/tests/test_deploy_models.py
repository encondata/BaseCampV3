import os
import subprocess

import psycopg
import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    EsxiVm,
    Integration,
    ManagedRecord,
    ProxmoxVm,
    Snapshot,
)

from .conftest import API_DIR, TEST_DB, _psycopg_url

SHA = "a" * 40


async def _env(db, name="uat") -> Environment:
    env = Environment(name=name, type="dev", target_id="ssh",
                      base_domain=f"{name}.serversherpa.com", proxy_ip="10.0.0.2",
                      git_ref="main", status="new", bind_ip="0.0.0.0", keep_dumps=5,
                      spaces_bucket="serversherpa", log_level="INFO")
    db.add(env)
    await db.commit()
    return env


def _dep(env, status="running") -> Deployment:
    return Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status=status, start_step=1)


async def test_tables_exist(db):
    names = set(await db.scalars(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")))
    assert {"environments", "environment_services", "environment_secrets", "deployments",
            "deployment_steps"} <= names


async def test_server_defaults_are_loaded(db):
    env = await _env(db)
    dep = _dep(env)
    db.add(dep)
    await db.commit()
    assert env.created_at is not None and env.updated_at is not None
    assert dep.created_at is not None and dep.started_at is not None
    assert dep.finished_at is None


async def test_one_running_deployment_per_environment(db):
    env = await _env(db)
    other = await _env(db, "qa")
    db.add(_dep(env))
    await db.commit()
    db.add(_dep(other))
    db.add(_dep(env, "succeeded"))
    await db.commit()
    db.add(_dep(env))
    with pytest.raises(IntegrityError) as exc:
        await db.commit()
    assert "deployments_one_running" in str(exc.value.orig)
    await db.rollback()


async def test_check_constraints_and_unique_names(db):
    env = await _env(db)
    db.add(_dep(env, "bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add(Environment(name="uat", type="dev", target_id="ssh", base_domain="x.example.com",
                       proxy_ip="10.0.0.2", git_ref="main", status="new", bind_ip="0.0.0.0",
                       keep_dumps=5, spaces_bucket="serversherpa", log_level="INFO"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_deleting_an_environment_cascades(db):
    env = await _env(db)
    db.add(EnvironmentService(environment_id=env.id, service="api", host_ip="10.0.0.5",
                              port=8000, hostname="api.uat.serversherpa.com", proxied=False))
    db.add(EnvironmentSecret(environment_id=env.id, key="POSTGRES_PASSWORD", value_enc=b"x"))
    dep = _dep(env)
    db.add(dep)
    await db.flush()
    db.add(DeploymentStep(deployment_id=dep.id, number=1, key="preflight", name="Preflight",
                          status="pending"))
    await db.commit()
    await db.execute(delete(Environment).where(Environment.id == env.id))
    await db.commit()
    for model in (EnvironmentService, EnvironmentSecret, Deployment, DeploymentStep):
        assert await db.scalar(select(func.count()).select_from(model)) == 0


def _snapshot(name="dev-2026-10-04", status="ready", **over) -> Snapshot:
    kw = dict(name=name, origin="upload", source="mac-dev", status=status,
              alembic_revision="0089", size_bytes=10, checksum="0" * 64,
              bundle_file=f"{name}.tar.gz")
    kw.update(over)
    return Snapshot(**kw)


async def test_snapshots_and_the_columns_that_point_at_them(db):
    snap = _snapshot()
    db.add(snap)
    env = await _env(db)
    env.seed_snapshot_id = snap.id
    dep = Deployment(environment_id=env.id, mode="snapshot", git_ref="main", sha=SHA,
                     status="succeeded", start_step=1, snapshot_id=snap.id,
                     restore_dump="20261004T010203Z.dump")
    db.add(dep)
    await db.commit()
    await db.refresh(snap)
    assert (snap.notes, snap.object_count) == ("", None)
    assert snap.created_at is not None
    await db.execute(delete(Snapshot).where(Snapshot.id == snap.id))
    await db.commit()
    await db.refresh(env)
    await db.refresh(dep)
    assert (env.seed_snapshot_id, dep.snapshot_id) == (None, None)
    assert dep.restore_dump == "20261004T010203Z.dump"


@pytest.mark.parametrize("mode", ["update", "reset", "adopt", "snapshot", "restore_dump",
                                  "rollback"])
async def test_deployment_modes(db, mode):
    env = await _env(db)
    db.add(Deployment(environment_id=env.id, mode=mode, git_ref="main", sha=SHA,
                      status="succeeded", start_step=1))
    await db.commit()


async def test_snapshot_constraints(db):
    db.add(_snapshot(name="pending-one", status="pending", bundle_file=None,
                     alembic_revision=None, size_bytes=None, checksum=None))
    await db.commit()
    for bad in (_snapshot(name="x", bundle_file=None), _snapshot(name="y", status="bogus"),
                _snapshot(name="z", origin="email"), _snapshot(name="pending-one")):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    env = await _env(db)
    db.add(Deployment(environment_id=env.id, mode="bogus", git_ref="main", sha=SHA,
                      status="running", start_step=1))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


def _alembic(*args: str) -> None:
    subprocess.run([str(API_DIR / ".venv/bin/alembic"), *args], cwd=API_DIR,
                   env={**os.environ}, check=True, capture_output=True)


async def test_migration_0005_moves_start_services_to_step_10():
    """Deployments recorded before phase 3 keep a consistent plan: "up" was
    step 8 and is step 10 now, and so are failed_step and start_step."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    _alembic("downgrade", "0004")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            env_id = conn.execute(
                "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
                "VALUES ('old', 'dev', 'ssh', 'old.example.com', '10.0.0.2') RETURNING id"
            ).fetchone()[0]
            dep_id = conn.execute(
                "INSERT INTO deployments (environment_id, mode, git_ref, sha, status, "
                "start_step, failed_step) VALUES (%s, 'update', 'main', %s, 'failed', 8, 8) "
                "RETURNING id", (env_id, SHA)).fetchone()[0]
            for number, key in ((6, "dump"), (8, "up")):
                conn.execute("INSERT INTO deployment_steps (deployment_id, number, key, name) "
                             "VALUES (%s, %s, %s, %s)", (dep_id, number, key, key))
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        steps = conn.execute("SELECT key, number FROM deployment_steps WHERE deployment_id = %s "
                             "ORDER BY number", (dep_id,)).fetchall()
        dep = conn.execute("SELECT start_step, failed_step FROM deployments WHERE id = %s",
                           (dep_id,)).fetchone()
    assert steps == [("dump", 6), ("up", 10)]
    assert dep == (10, 10)


def _record(env_id, **over) -> ManagedRecord:
    kw = dict(environment_id=env_id, service="api", kind="dns_record", external_id="rec-1",
              name="api.uat.serversherpa.com", origin="created")
    kw.update(over)
    return ManagedRecord(**kw)


async def test_publish_tables_and_columns(db):
    env = await _env(db)
    await db.refresh(env)
    assert env.publish is False
    db.add(Integration(kind="cloudflare", config={"zone": "serversherpa.com"}, secret_enc=b"x"))
    db.add(_record(env.id))
    dep = Deployment(environment_id=env.id, mode="publish", git_ref="main", sha=SHA,
                     status="succeeded", start_step=12, publish=True)
    db.add(dep)
    env.status = "deleting"
    await db.commit()
    row = await db.get(Integration, "cloudflare")
    assert row.updated_at is not None and row.config == {"zone": "serversherpa.com"}
    await db.refresh(dep)
    assert dep.publish is True
    db.add(Deployment(environment_id=env.id, mode="teardown", git_ref="main", sha="",
                      status="failed", start_step=15))
    await db.commit()
    await db.execute(delete(Environment).where(Environment.id == env.id))
    await db.commit()
    assert await db.scalar(select(func.count()).select_from(ManagedRecord)) == 0


async def test_managed_record_constraints(db):
    env, other = await _env(db), await _env(db, name="uat2")
    env_id, other_id = env.id, other.id
    db.add(_record(env_id))
    await db.commit()
    for bad in (_record(env_id, external_id="rec-2"),      # a second api record for uat
                _record(other_id),                         # uat's record, claimed by uat2
                _record(other_id, external_id="r3", kind="cname"),
                _record(other_id, external_id="r4", origin="adopted")):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    # one id per kind: a proxy host and a DNS record may share "rec-1"
    db.add(_record(other_id, kind="proxy_host"))
    await db.commit()
    db.add(Integration(kind="route53"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_deleting_an_environment_cascades_its_managed_records(db):
    """Delete environment ends by deleting the row: its managed_records go with
    it, and another environment's stay."""
    env, other = await _env(db), await _env(db, name="uat2")
    env_id, other_id = env.id, other.id
    db.add(_record(env_id))
    db.add(_record(env_id, kind="proxy_host", external_id="7"))
    db.add(_record(other_id, service="portal", external_id="rec-9"))
    await db.commit()
    await db.execute(delete(Environment).where(Environment.id == env_id))
    await db.commit()
    left = await db.scalars(select(ManagedRecord.environment_id))
    assert list(left) == [other_id]


async def test_migration_0006_round_trip():
    """Downgrading drops the publish and teardown deployments with their
    steps; upgrading again leaves every existing environment unpublished."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip, publish) "
            "VALUES ('pub', 'dev', 'ssh', 'pub.example.com', '10.0.0.2', true) RETURNING id"
        ).fetchone()[0]
        dep_id = conn.execute(
            "INSERT INTO deployments (environment_id, mode, git_ref, sha, status, start_step, "
            "publish) VALUES (%s, 'publish', 'main', %s, 'succeeded', 12, true) RETURNING id",
            (env_id, SHA)).fetchone()[0]
        conn.execute("INSERT INTO deployment_steps (deployment_id, number, key, name) "
                     "VALUES (%s, 12, 'dns', 'DNS records')", (dep_id,))
    _alembic("downgrade", "0005")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM deployments WHERE id = %s",
                                (dep_id,)).fetchone()[0] == 0
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT publish FROM environments WHERE id = %s",
                            (env_id,)).fetchone()[0] is False


def _vm(env_id, **over) -> ProxmoxVm:
    kw = dict(environment_id=env_id, node="pve", template_vmid=9000, storage="local-lvm",
              pool="sirdar", bridge="vmbr0", vlan_tag=None, name="ss-uat", cores=4,
              memory_mb=8192, disk_gb=64, ip_mode="static", ip_cidr="10.10.48.70/24",
              gateway="10.10.48.1",
              ssh_public_key="ssh-ed25519 AAAAC3Nz test", ssh_private_key_enc=b"enc")
    kw.update(over)
    return ProxmoxVm(**kw)


async def test_proxmox_vms_and_the_vm_columns(db):
    env = await _env(db)
    db.add(_vm(env.id))
    db.add(Integration(kind="proxmox", config={"url": "https://10.10.48.5:8006"},
                       secret_enc=b"x"))
    dep = Deployment(environment_id=env.id, mode="vm_restore", git_ref=SHA, sha=SHA,
                     status="succeeded", start_step=0, vm=True,
                     vm_snapshot="sirdar-20261004T120000Z")
    db.add(dep)
    await db.commit()
    vm = await db.get(ProxmoxVm, env.id)
    assert (vm.vmid, vm.ip, vm.keep_snapshots, vm.created) == (None, None, 3, False)
    assert (vm.template_vmid, vm.storage, vm.pool, vm.bridge, vm.vlan_tag) == (
        9000, "local-lvm", "sirdar", "vmbr0", None)
    assert vm.created_at is not None
    await db.refresh(dep)
    assert (dep.vm, dep.take_vm_snapshot, dep.vm_snapshot) == (
        True, False, "sirdar-20261004T120000Z")
    plain = _dep(env, status="succeeded")
    db.add(plain)
    await db.commit()
    await db.refresh(plain)
    assert (plain.vm, plain.take_vm_snapshot, plain.vm_snapshot) == (False, False, None)
    await db.execute(delete(Environment).where(Environment.id == env.id))
    await db.commit()
    assert await db.scalar(select(func.count()).select_from(ProxmoxVm)) == 0


async def test_proxmox_vm_constraints(db):
    env, other = await _env(db), await _env(db, name="uat2")
    env_id, other_id = env.id, other.id
    db.add(_vm(env_id, vmid=120))
    await db.commit()
    for bad in (_vm(other_id, name="ss-uat2", vmid=120),          # one VM id, one environment
                _vm(other_id),                                    # the name ss-uat again
                _vm(other_id, name="ss-uat2", ip_cidr=None),      # static needs an address
                _vm(other_id, name="ss-uat2", ip_mode="dhcp"),    # dhcp with an address
                _vm(other_id, name="ss-uat2", ip_mode="bridged"),
                _vm(other_id, name="ss-uat2", cores=0),
                _vm(other_id, name="ss-uat2", memory_mb=1024),
                _vm(other_id, name="ss-uat2", disk_gb=10),
                _vm(other_id, name="ss-uat2", keep_snapshots=11),
                _vm(other_id, name="ss-uat2", vmid=99),
                _vm(other_id, name="ss-uat2", template_vmid=None),  # clone inputs are frozen
                _vm(other_id, name="ss-uat2", storage=None),
                _vm(other_id, name="ss-uat2", vlan_tag=4095)):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    db.add(_vm(other_id, name="ss-uat2", ip_mode="dhcp", ip_cidr=None, gateway=None))
    await db.commit()
    db.add(Integration(kind="vsphere"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_migration_0007_round_trip():
    """Downgrading drops the VM restores, the VM steps and the Proxmox
    credentials, and keeps the environments (their VMs would be orphaned)."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
            "VALUES ('vm1', 'dev', 'proxmox', 'vm1.example.com', '10.0.0.2') RETURNING id"
        ).fetchone()[0]
        dep_id = conn.execute(
            "INSERT INTO deployments (environment_id, mode, git_ref, sha, status, start_step, "
            "vm) VALUES (%s, 'vm_restore', %s, %s, 'succeeded', 0, true) RETURNING id",
            (env_id, SHA, SHA)).fetchone()[0]
        conn.execute("INSERT INTO deployment_steps (deployment_id, number, key, name) "
                     "VALUES (%s, 0, 'vm_restore', 'Restore VM snapshot')", (dep_id,))
        conn.execute("INSERT INTO integrations (kind, config) VALUES ('proxmox', '{}')")
    _alembic("downgrade", "0006")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM deployments WHERE id = %s",
                                (dep_id,)).fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM integrations WHERE kind = 'proxmox'"
                                ).fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM environments WHERE id = %s",
                                (env_id,)).fetchone()[0] == 1
            assert not conn.execute("SELECT to_regclass('proxmox_vms') IS NOT NULL"
                                    ).fetchone()[0]
            assert conn.execute(
                "SELECT count(*) FROM information_schema.columns WHERE table_name = "
                "'deployments' AND column_name IN ('vm', 'take_vm_snapshot', 'vm_snapshot')"
            ).fetchone()[0] == 0
            for bad in ("INSERT INTO integrations (kind, config) VALUES ('proxmox', '{}')",
                        "INSERT INTO deployments (environment_id, mode, git_ref, sha, status, "
                        f"start_step) VALUES ('{env_id}', 'vm_restore', 'main', '{SHA}', "
                        "'succeeded', 0)"):
                with pytest.raises(psycopg.errors.CheckViolation):
                    conn.execute(bad)
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT to_regclass('proxmox_vms') IS NOT NULL").fetchone()[0]


async def test_migration_0007_downgrade_refuses_while_vms_are_managed():
    """Downgrading would erase the ownership record and the SSH key of each VM
    Sirdar built, orphaning them: it refuses, and nothing changes."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
            "VALUES ('vm2', 'dev', 'proxmox', 'vm2.example.com', '10.0.0.2') RETURNING id"
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO proxmox_vms (environment_id, node, vmid, template_vmid, storage, "
            "pool, bridge, name, cores, memory_mb, disk_gb, ip_mode, ssh_public_key, "
            "ssh_private_key_enc) VALUES (%s, 'pve', 120, 9000, 'local-lvm', 'sirdar', "
            "'vmbr0', 'ss-vm2', 4, 8192, 64, 'dhcp', 'ssh-ed25519 x', 'k')",
            (env_id,))
        conn.execute("INSERT INTO integrations (kind, config) VALUES ('proxmox', '{}')")
    with pytest.raises(subprocess.CalledProcessError) as err:
        _alembic("downgrade", "0006")
    assert b"Can't downgrade below 0007 while Sirdar manages Proxmox VMs" in err.value.stderr
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        # The refused downgrade rolls back as a whole: still at head.
        assert conn.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0008"
        assert conn.execute("SELECT count(*) FROM proxmox_vms").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM integrations WHERE kind = 'proxmox'"
                            ).fetchone()[0] == 1


def _esxi_vm(env_id, **over) -> EsxiVm:
    kw = dict(environment_id=env_id, name="ss-uat3", host="10.10.48.10", datastore="datastore1",
              network="VM Network", source_vm="sirdar-ubuntu-2404-seed", cores=4,
              memory_mb=8192, disk_gb=64, ip_mode="static", ip_cidr="10.10.48.71/24",
              gateway="10.10.48.1", ssh_public_key="ssh-ed25519 AAAAC3Nz test",
              ssh_private_key_enc=b"enc", host_key_public="ssh-ed25519 AAAAC3Nz host",
              host_key_private_enc=b"henc")
    kw.update(over)
    return EsxiVm(**kw)


async def test_esxi_vms(db):
    env = await _env(db, name="uat3")
    db.add(_esxi_vm(env.id))
    db.add(Integration(kind="esxi", config={"url": "https://10.10.48.10"}, secret_enc=b"x"))
    await db.commit()
    vm = await db.get(EsxiVm, env.id)
    assert (vm.moref, vm.instance_uuid, vm.vm_path, vm.ip, vm.created, vm.keep_snapshots,
            vm.resource_pool, vm.dns_servers) == (None, None, None, None, False, 3, None, [])
    vm.moref, vm.instance_uuid = "12", "52b1c3d4-0000-0000-0000-000000000001"
    vm.vm_path, vm.created = "[datastore1] ss-uat3/ss-uat3.vmx", True
    vm.dns_servers, vm.host_key_private_enc = ["10.10.48.1"], None
    await db.commit()
    other_id = (await _env(db, name="uat4")).id   # read before a rollback expires it
    for bad in (_esxi_vm(other_id),                                    # the name is taken
                _esxi_vm(other_id, name="ss-uat4", moref="13"),        # moref without a uuid
                _esxi_vm(other_id, name="ss-uat4", created=True),      # created without a VM
                _esxi_vm(other_id, name="ss-uat4", moref="14",
                         instance_uuid="52b1c3d4-0000-0000-0000-000000000001"),  # uuid taken
                _esxi_vm(other_id, name="ss-uat4", ip_mode="dhcp"),    # dhcp with an address
                _esxi_vm(other_id, name="ss-uat4", cores=0),
                _esxi_vm(other_id, name="ss-uat4", disk_gb=10),
                _esxi_vm(other_id, name="ss-uat4", keep_snapshots=11),
                _esxi_vm(other_id, name="ss-uat4", host_key_public=None)):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    db.add(_esxi_vm(other_id, name="ss-uat4", ip_mode="dhcp", ip_cidr=None, gateway=None))
    await db.commit()
    await db.delete(await db.get(Environment, other_id))
    await db.commit()
    assert await db.get(EsxiVm, other_id) is None                       # cascades


async def test_migration_0008_downgrade_refuses_while_esxi_vms_are_managed():
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
            "VALUES ('vm3', 'dev', 'esxi', 'vm3.example.com', '10.0.0.2') RETURNING id"
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO esxi_vms (environment_id, name, host, datastore, network, source_vm, "
            "cores, memory_mb, disk_gb, ip_mode, ssh_public_key, ssh_private_key_enc, "
            "host_key_public) VALUES (%s, 'ss-vm3', '10.10.48.10', 'datastore1', "
            "'VM Network', 'seed', 4, 8192, 64, 'dhcp', 'ssh-ed25519 x', 'k', "
            "'ssh-ed25519 h')", (env_id,))
    with pytest.raises(subprocess.CalledProcessError) as err:
        _alembic("downgrade", "0007")
    assert b"while Sirdar manages ESXi VMs" in err.value.stderr
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM esxi_vms").fetchone()[0] == 1
        conn.execute("DELETE FROM esxi_vms")
        conn.execute("INSERT INTO integrations (kind, config) VALUES ('esxi', '{}')")
    _alembic("downgrade", "0007")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert not conn.execute("SELECT to_regclass('esxi_vms') IS NOT NULL").fetchone()[0]
            assert conn.execute("SELECT count(*) FROM integrations WHERE kind = 'esxi'"
                                ).fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM environments WHERE id = %s",
                                (env_id,)).fetchone()[0] == 1
            with pytest.raises(psycopg.errors.CheckViolation):
                conn.execute("INSERT INTO integrations (kind, config) VALUES ('esxi', '{}')")
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        assert conn.execute("SELECT to_regclass('esxi_vms') IS NOT NULL").fetchone()[0]
