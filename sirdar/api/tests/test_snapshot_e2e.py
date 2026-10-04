"""Opt-in: the phase 3 playbooks for real through ansible-runner against the
throwaway Ubuntu 24.04 SSH container of test_runner_e2e.py.

    SIRDAR_RUNNER_E2E=1 .venv/bin/pytest -q tests/test_snapshot_e2e.py

The container has no Docker daemon, so a stand-in `docker` (logging every
call, answering psql/cp, consuming pg_restore's stdin, writing objects.tar
for export-objects) sits on its PATH. Everything else is real: SSH with the
pinned key, the real ss-stack and compose files in the environment's repo
folder, the host python3 packing and unpacking with bundle.py, ansible's
copy of the bundle to the target and its fetch back to Sirdar, and the
backups listing over SSH."""

import base64
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from sirdar_api.deploy import bundle, environments
from sirdar_api.deploy.runner import AnsibleRunner, RunRequest
from sirdar_api.deploy.ssh import SshTargetConfig

from .bundle_helpers import make_bundle
from .test_runner_e2e import ENV_DIR, PASSWORD, USER, _exec, _pinned, target  # noqa: F401

pytestmark = pytest.mark.skipif(os.environ.get("SIRDAR_RUNNER_E2E") != "1",
                                reason="opt-in: set SIRDAR_RUNNER_E2E=1")

REPO = Path(__file__).resolve().parents[3]
LOG = "/tmp/fake-docker.log"
FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> /tmp/fake-docker.log
args=("$@")
last="${args[${#args[@]}-1]}"
case "$*" in
  *"SELECT version_num FROM alembic_version"*) echo 0089 ;;
  *" cp postgres:"*) printf 'PGDMP-from-the-target' > "$last" ;;
  *pg_restore*) cat > /tmp/fake-docker.restored ;;
  *export-objects*)
    for ((i = 0; i < ${#args[@]}; i++)); do
      [[ ${args[i]} == -v ]] && mount=${args[i+1]}
    done
    python3 -c 'import io, sys, tarfile
with tarfile.open(sys.argv[1], "w") as tar:
    info = tarfile.TarInfo("wiki/page.png"); info.size = 3
    tar.addfile(info, io.BytesIO(b"png"))' "${mount%%:*}/objects.tar" ;;
esac
exit 0
"""


@pytest.fixture(scope="module")
def stage(target):
    """The environment folder of a deployed environment named e2e."""
    _exec(target, "sh", "-c", "cat > /usr/local/bin/docker && chmod 755 /usr/local/bin/docker",
          stdin=FAKE_DOCKER)
    stack = REPO / "deploy" / "stack"
    _exec(target, "mkdir", "-p", f"{ENV_DIR}/repo/deploy", f"{ENV_DIR}/backups",
          f"{ENV_DIR}/repo/api/migrations/versions")
    subprocess.run(["docker", "cp", str(stack), f"{target['name']}:{ENV_DIR}/repo/deploy/"],
                   check=True, capture_output=True)
    for name in ("0001_initial.py", "0088_x.py", "0089_y.py"):
        _exec(target, "touch", f"{ENV_DIR}/repo/api/migrations/versions/{name}")
    env_text = ((stack / "env.example").read_text().replace("=CHANGEME", "=0123abcd")
                .replace("STACK_ENV=uat", "STACK_ENV=e2e"))
    _exec(target, "sh", "-c", f"cat > {ENV_DIR}/.env", stdin=env_text)
    _exec(target, "sh", "-c", f"printf PGDMP-backup > {ENV_DIR}/backups/20261004T010203Z.dump")
    _exec(target, "chown", "-R", USER, ENV_DIR)
    return target


def _common() -> dict:
    return {"env_name": "e2e", "env_dir": ENV_DIR,
            "ss_stack": f"{ENV_DIR}/repo/deploy/stack/ss-stack"}


async def _run(db, stage, tmp_path, step: str, playbook: str, extravars: dict):
    _exec(stage, "rm", "-f", LOG, "/tmp/fake-docker.restored")
    run_target = await _pinned(db, stage, password=PASSWORD, become_password=PASSWORD)
    lines: list[str] = []
    result = await AnsibleRunner(str(tmp_path / "runner")).run(
        RunRequest(step=step, playbook=playbook, target=run_target, timeout=600,
                   extravars={**_common(), **extravars}), lines.append)
    calls = _exec(stage, "sh", "-c", f"cat {LOG} 2>/dev/null || true").splitlines()
    return result, "".join(lines), calls


async def test_backups_are_listed_over_ssh(db, stage):
    await _pinned(db, stage, password=PASSWORD)
    cfg = SshTargetConfig(host="127.0.0.1", port=stage["port"], user=USER, password=PASSWORD)
    rows = await environments.list_backups(db, cfg, SimpleNamespace(name="e2e"))
    assert [(r["name"], r["size_bytes"]) for r in rows] == [("20261004T010203Z.dump", 12)]


async def test_start_data_services(db, stage, tmp_path):
    result, out, calls = await _run(db, stage, tmp_path, "data", "data.yml", {})
    assert result.status == "successful", out
    assert [c.split(" -f ")[-1].split("/")[-2] for c in calls if c.startswith("compose")] == [
        "db", "storage"]


async def test_restore_snapshot(db, stage, tmp_path):
    snap = make_bundle(tmp_path)
    extravars = {"bundle_path": str(snap), "bundle_tool": bundle.__file__,
                 "snapshot_revision": "0089", "api_image": "serversherpa-api:0123abcd"}
    result, out, calls = await _run(db, stage, tmp_path, "restore", "restore.yml", extravars)
    assert result.status == "successful", out
    assert _exec(stage, "cat", "/tmp/fake-docker.restored") == "PGDMP-fake-dump"
    assert any("DELETE FROM auth_sessions" in c for c in calls)
    assert calls[-1].endswith("serversherpa-api:0123abcd python /work/bundle.py "
                              "import-objects --in /work/objects.tar")
    uid, gid = _exec(stage, "id", "-u", USER).strip(), _exec(stage, "id", "-g", USER).strip()
    assert f"--user {uid}:{gid} -e HOME=/tmp -v {ENV_DIR}/restore-work:/work:ro" in calls[-1]
    assert _exec(stage, "sh", "-c", f"test -e {ENV_DIR}/restore-work && echo left || echo gone"
                 ).strip() == "gone"
    assert list((tmp_path / "runner").iterdir()) == []

    newer = {**extravars, "snapshot_revision": "0090"}
    result, out, calls = await _run(db, stage, tmp_path, "restore", "restore.yml", newer)
    assert result.status == "failed"
    assert "newer than this commit's newest migration (89)" in out
    assert calls == []


async def test_restore_backup(db, stage, tmp_path):
    result, out, _ = await _run(db, stage, tmp_path, "restore_dump", "restore_dump.yml",
                                {"dump_name": "20261004T010203Z.dump"})
    assert result.status == "successful", out
    assert _exec(stage, "cat", "/tmp/fake-docker.restored") == "PGDMP-backup"


async def test_take_snapshot_fetches_the_bundle(db, stage, tmp_path):
    dest = tmp_path / "snapshots" / "incoming" / "taken.tar.gz"
    token = b"gAAAA-fernet-token-SECRET"
    extravars = {"snapshot_dest": str(dest), "bundle_tool": bundle.__file__,
                 "keys_enc_b64": base64.b64encode(token).decode(),
                 "api_image": "serversherpa-api:0123abcd", "spaces_bucket": "serversherpa"}
    result, out, calls = await _run(db, stage, tmp_path, "export", "export.yml", extravars)
    assert result.status == "successful", out
    manifest = bundle.verify(dest)
    assert (manifest["source"], manifest["alembic_revision"], manifest["object_count"]) == (
        "e2e", "0089", 1)
    assert bundle.read_head(dest)[1:] == ("keys.enc", token)
    assert calls[-1].endswith("exec -T postgres rm -f /tmp/sirdar-snapshot.dump")
    assert token.decode() not in out and extravars["keys_enc_b64"] not in out
    assert _exec(stage, "sh", "-c", f"test -e {ENV_DIR}/snapshot-work && echo left || echo gone"
                 ).strip() == "gone"
