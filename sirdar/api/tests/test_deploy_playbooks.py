import base64
import json
import os
import subprocess
import sys
from importlib import resources
from pathlib import Path

import pytest
import yaml

from sirdar_api.deploy import bundle, runner, steps
from sirdar_api.deploy.steps import PLAYBOOK_DIR

from .bundle_helpers import make_bundle

ANSIBLE_PLAYBOOK = Path(sys.executable).parent / "ansible-playbook"
SHELL_MODULES = {"shell", "ansible.builtin.shell", "raw", "ansible.builtin.raw"}


def _tasks(playbook: str):
    plays = yaml.safe_load((PLAYBOOK_DIR / playbook).read_text())
    found: list[dict] = []

    def walk(tasks):
        for task in tasks or []:
            found.append(task)
            walk(task.get("block"))

    for play in plays:
        walk(play.get("tasks"))
    return plays, found


def _keys(mode, restore=False, publish=False):
    return [s.key for s in steps.plan_for(mode, restore=restore, publish=publish)]


def test_publish_and_teardown_plans():
    published = ["dns", "proxy", "smoke"]
    for mode in steps.PUBLISHING_MODES:
        for restore in ((False, True) if mode in ("update", "reset") else (False,)):
            assert _keys(mode, restore, publish=True) == [*_keys(mode, restore), *published]
    assert [s.number for s in steps.plan_for("update", publish=True)] == [
        1, 2, 3, 4, 5, 6, 10, 12, 13, 14]
    assert [s.number for s in steps.plan_for("update", restore=True, publish=True)] == [
        1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14]
    assert [s.number for s in steps.plan_for("restore_dump", publish=True)] == [
        1, 3, 4, 5, 8, 9, 10, 12, 13, 14]
    assert _keys("publish") == published
    assert _keys("teardown") == ["teardown", "unproxy", "undns"]
    assert [s.number for s in steps.plan_for("teardown")] == [15, 16, 17]
    for mode in ("snapshot", "publish", "teardown"):
        with pytest.raises(ValueError):
            steps.plan_for(mode, publish=True)
    for mode in steps.PUBLISHING_MODES:
        numbers = [s.number for s in steps.plan_for(mode, publish=True)]
        assert numbers == sorted(set(numbers)), f"{mode}: numbers must rise"
    runs = {s.key: s.runs for s in steps.STEPS}
    assert [k for k, r in runs.items() if r == "python"] == [
        "dns", "proxy", "smoke", "unproxy", "undns"]
    assert all(s.playbook == "" for s in steps.STEPS if s.runs == "python")
    assert all(s.playbook for s in steps.ANSIBLE_STEPS)
    assert steps.STEPS_BY_KEY["proxy"].timeout >= 30 * 60
    assert (steps.STEPS_BY_KEY["dns"].name, steps.STEPS_BY_KEY["teardown"].name) == (
        "DNS records", "Remove environment")


def test_plans():
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 13, 14,
                                               15, 16, 17]
    assert [s.number for s in steps.plan_for("update")] == [1, 2, 3, 4, 5, 6, 10]
    build = ["preflight", "bootstrap", "fetch", "render", "build"]
    # a seeded first deploy backs up whatever database is already there
    assert _keys("update", True) == [*build, "dump", "data", "restore", "up"]
    assert [s.number for s in steps.plan_for("update", restore=True)] == [
        1, 2, 3, 4, 5, 6, 8, 9, 10]
    assert _keys("reset") == [*build, "reset", "up"]
    assert _keys("reset", True) == [*build, "reset", "data", "restore", "up"]
    # Restore backup runs the deployed commit with Sirdar's stored keys, like Roll back
    restore_backup = ["preflight", "fetch", "render", "build", "data", "restore_dump", "up"]
    assert _keys("restore_dump") == restore_backup
    assert [s.number for s in steps.plan_for("restore_dump")] == [1, 3, 4, 5, 8, 9, 10]
    assert _keys("rollback") == restore_backup
    assert _keys("snapshot") == ["preflight", "export"]
    for mode, restore in (("adopt", False), ("snapshot", True), ("restore_dump", True)):
        with pytest.raises(ValueError):
            steps.plan_for(mode, restore=restore)
    for mode in steps.MODES:
        numbers = [s.number for s in steps.plan_for(mode)]
        assert numbers == sorted(set(numbers)), f"{mode}: numbers must rise"
    assert steps.STEPS_BY_KEY["up"].timeout >= 30 * 60
    assert steps.STEPS_BY_KEY["build"].timeout >= 60 * 60
    assert steps.STEPS_BY_KEY["restore"].timeout >= 60 * 60
    assert steps.STEPS_BY_KEY["export"].timeout >= 60 * 60
    assert steps.STEPS_BY_KEY["up"].name == "Start services"


def test_every_playbook_belongs_to_a_step():
    assert sorted(p.name for p in PLAYBOOK_DIR.glob("*.yml")) == \
        sorted(s.playbook for s in steps.ANSIBLE_STEPS)


def test_playbooks_ship_with_the_package():
    folder = resources.files("sirdar_api.deploy").joinpath("ansible")
    for step in steps.ANSIBLE_STEPS:
        assert folder.joinpath(step.playbook).is_file()


@pytest.mark.parametrize("step", steps.ANSIBLE_STEPS, ids=lambda s: s.key)
def test_playbook_shape(step):
    plays, tasks = _tasks(step.playbook)
    assert len(plays) == 1 and plays[0]["hosts"] == "target"
    assert tasks
    for task in tasks:
        assert task.get("name"), f"{step.playbook}: every task needs a name"
        assert not SHELL_MODULES & set(task), f"{step.playbook}: {task['name']} uses a shell"
        text = yaml.safe_dump(task)
        if ("env_file_b64" in text or "keys_enc_b64" in text) and "block" not in task:
            assert task.get("no_log") is True, f"{step.playbook}: {task['name']} needs no_log"


@pytest.mark.parametrize("step", steps.ANSIBLE_STEPS, ids=lambda s: s.key)
def test_syntax_check(step, tmp_path):
    cfg = tmp_path / "ansible.cfg"
    cfg.write_text("[defaults]\n")
    env = {**os.environ, "ANSIBLE_CONFIG": str(cfg), "ANSIBLE_HOME": str(tmp_path),
           "ANSIBLE_LOCAL_TEMP": str(tmp_path / "tmp"), "ANSIBLE_NOCOLOR": "1"}
    result = subprocess.run(
        [str(ANSIBLE_PLAYBOOK), "--syntax-check", "-i", "target,",
         str(PLAYBOOK_DIR / step.playbook)],
        capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


DUMP_BLOCKED = ("The database isn't running, so the pre-deploy backup can't be taken. "
                "Start it (or Reset) and retry.")


def _run_dump(tmp_path, *, db_running: bool, dump_required: bool | None,
              volume: bool = False, restoring: bool | None = None):
    """dump.yml on this machine (connection local) with stand-ins for docker
    (`ps` answers a container id only when db_running; `volume inspect`
    succeeds only for ss-e2e-db_pgdata when `volume`) and ss-stack."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/bin/sh\n"
        f"echo \"$*\" >> {tmp_path / 'docker-calls'}\n"
        "if [ \"$1\" = volume ]; then\n"
        + ("  [ \"$3\" = ss-e2e-db_pgdata ] && exit 0\n" if volume else "")
        + "  echo 'no such volume' >&2; exit 1\nfi\n"
        + ("echo 0123abcd\n" if db_running else "") + "exit 0\n")
    ss_stack = bin_dir / "ss-stack"
    ss_stack.write_text(f"#!/bin/sh\necho \"$1 $2\" > {tmp_path / 'ss-stack-called'}\n"
                        "echo /x/backups/e2e.dump\n")
    for f in (docker, ss_stack):
        f.chmod(0o755)
    cfg = tmp_path / "ansible.cfg"
    cfg.write_text("[defaults]\n")
    extra = {"env_name": "e2e", "env_dir": "/x", "ss_stack": str(ss_stack)}
    if dump_required is not None:
        extra["dump_required"] = dump_required
    if restoring is not None:
        extra["restores_snapshot"] = restoring
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
           "ANSIBLE_CONFIG": str(cfg), "ANSIBLE_HOME": str(tmp_path),
           "ANSIBLE_LOCAL_TEMP": str(tmp_path / "tmp"), "ANSIBLE_NOCOLOR": "1"}
    return subprocess.run(
        [str(ANSIBLE_PLAYBOOK), "-i", "target,", "-c", "local",
         "-e", f"ansible_python_interpreter={sys.executable}",
         "-e", json.dumps(extra), str(PLAYBOOK_DIR / "dump.yml")],
        capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, check=False)


@pytest.mark.parametrize("db_running, dump_required, ok, dumped", [
    (True, True, True, True),
    (True, False, True, True),
    (False, False, True, False),      # a first deploy: nothing to back up yet
    (False, None, True, False),
    (False, True, False, False),      # an established environment: never migrate unbacked
])
def test_dump_playbook_logic(tmp_path, db_running, dump_required, ok, dumped):
    result = _run_dump(tmp_path, db_running=db_running, dump_required=dump_required)
    out = result.stdout + result.stderr
    assert (result.returncode == 0) is ok, out
    called = tmp_path / "ss-stack-called"
    assert called.exists() is dumped, out
    if dumped:
        assert called.read_text() == "dump /x\n"
    assert (DUMP_BLOCKED in out) is (not ok), out


STOPPED_DB = ("A database for e2e already exists on this server but isn't running. Adopt the "
              "environment instead, or remove its volume (ss-e2e-db_pgdata).")


@pytest.mark.parametrize("db_running, volume, restoring, ok, dumped", [
    (False, True, True, False, False),    # a stopped database the restore would drop
    (False, False, True, True, False),    # an empty host: nothing to keep
    (True, True, True, True, True),       # running: backed up, then restored over
    (False, True, False, True, False),    # an Update's first deploy doesn't restore
    (False, True, None, True, False),
])
def test_dump_playbook_refuses_to_restore_over_a_stopped_database(
        tmp_path, db_running, volume, restoring, ok, dumped):
    result = _run_dump(tmp_path, db_running=db_running, dump_required=False, volume=volume,
                       restoring=restoring)
    out = result.stdout + result.stderr
    assert (result.returncode == 0) is ok, out
    assert (tmp_path / "ss-stack-called").exists() is dumped, out
    assert (STOPPED_DB in out) is (not ok), out
    calls = (tmp_path / "docker-calls").read_text().splitlines()
    inspected = "volume inspect ss-e2e-db_pgdata" in calls
    assert inspected is (bool(restoring) and not db_running), calls


def test_the_volume_name_is_the_db_stacks():
    """dump.yml's check names the volume `ss-stack data` would start."""
    compose = yaml.safe_load((REPO / "deploy" / "stack" / "db" / "compose.yml").read_text())
    assert compose["name"] == "ss-${STACK_ENV:?set STACK_ENV}-db"
    assert "pgdata" in compose["volumes"]
    assert "pgdata:/var/lib/postgresql/data" in compose["services"]["postgres"]["volumes"]
    text = (PLAYBOOK_DIR / "dump.yml").read_text()
    assert '"ss-{{ env_name }}-db_pgdata"' in text


# ---- the phase 3 playbooks, run on this machine with stand-ins -------------------

REPO = Path(__file__).resolve().parents[3]
ENV_EXAMPLE = REPO / "deploy" / "stack" / "env.example"
# Records every call; answers the few that must print or write something.
FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
args=("$@")
last="${args[${#args[@]}-1]}"
[[ -n "${FAKE_FAIL:-}" && "$*" == *"$FAKE_FAIL"* ]] && { echo "fake failure" >&2; exit 1; }
case "$*" in
  *"SELECT version_num FROM alembic_version"*) echo "${FAKE_REVISION:-0089}" ;;
  *" cp postgres:"*) printf 'PGDMP-from-container' > "$last" ;;
  *pg_restore*) cat > "$DOCKER_LOG.restored" ;;
  *export-objects*)
    for ((i = 0; i < ${#args[@]}; i++)); do
      [[ ${args[i]} == -v ]] && mount=${args[i+1]}
    done
    "$FAKE_PYTHON" -c 'import io, sys, tarfile
with tarfile.open(sys.argv[1], "w") as tar:
    info = tarfile.TarInfo("a/hello.txt")
    info.size = 5
    tar.addfile(info, io.BytesIO(b"hello"))' "${mount%%:*}/objects.tar"
    ;;
esac
exit 0
"""


def _target(tmp_path: Path, *, head: int = 89) -> tuple[Path, dict]:
    """An environment folder like the target's: .env, the repo's deploy/stack
    (the real ss-stack and compose files) and migrations up to `head`. Plus
    a stand-in docker on PATH."""
    env_dir = tmp_path / "env"
    (env_dir / "repo" / "deploy").mkdir(parents=True)
    (env_dir / "repo" / "deploy" / "stack").symlink_to(REPO / "deploy" / "stack")
    versions = env_dir / "repo" / "api" / "migrations" / "versions"
    versions.mkdir(parents=True)
    for number in (1, head - 1, head):
        (versions / f"{number:04d}_step.py").write_text("")
    (versions / "__init__.py").write_text("")
    (env_dir / ".env").write_text(ENV_EXAMPLE.read_text().replace("=CHANGEME", "=0123abcd")
                                  .replace("STACK_ENV=uat", "STACK_ENV=e2e"))
    (env_dir / "backups").mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
           "DOCKER_LOG": str(tmp_path / "docker.log"), "FAKE_PYTHON": sys.executable}
    return env_dir, env


def _play(tmp_path: Path, playbook: str, extra: dict, env: dict):
    """Run a playbook here (connection local); (result, docker calls)."""
    cfg = tmp_path / "ansible.cfg"
    cfg.write_text("[defaults]\n")
    env = {**env, "ANSIBLE_CONFIG": str(cfg), "ANSIBLE_HOME": str(tmp_path / "ah"),
           "ANSIBLE_LOCAL_TEMP": str(tmp_path / "tmp"), "ANSIBLE_NOCOLOR": "1"}
    result = subprocess.run(
        [str(ANSIBLE_PLAYBOOK), "-i", "target,", "-c", "local",
         "-e", f"ansible_python_interpreter={sys.executable}",
         "-e", json.dumps({"snapshot_python": sys.executable, **extra}),
         str(PLAYBOOK_DIR / playbook)],
        capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, check=False)
    log = Path(env["DOCKER_LOG"])
    return result, (log.read_text().splitlines() if log.exists() else [])


def _common(env_dir: Path) -> dict:
    return {"env_name": "e2e", "env_dir": str(env_dir),
            "ss_stack": str(env_dir / "repo/deploy/stack/ss-stack")}


def test_data_playbook_starts_db_and_storage(tmp_path):
    env_dir, env = _target(tmp_path)
    result, calls = _play(tmp_path, "data.yml", _common(env_dir), env)
    assert result.returncode == 0, result.stdout + result.stderr
    wait = "up -d --wait --wait-timeout 300 --remove-orphans"
    assert [c.split(" -f ")[-1] for c in calls if c.startswith("compose")] == [
        f"{env_dir}/repo/deploy/stack/db/compose.yml {wait}",
        f"{env_dir}/repo/deploy/stack/storage/compose.yml {wait}"]


def test_data_playbook_explains_an_old_checkout(tmp_path):
    env_dir, env = _target(tmp_path)
    old = tmp_path / "old-ss-stack"
    old.write_text("#!/bin/sh\necho usage\nexit 2\n")
    old.chmod(0o755)
    result, calls = _play(tmp_path, "data.yml", {**_common(env_dir), "ss_stack": str(old)}, env)
    assert result.returncode != 0
    assert "This commit's ss-stack predates snapshots" in result.stdout
    assert calls == []


def _restore_vars(env_dir: Path, bundle_file: Path, revision: str = "0089") -> dict:
    return {**_common(env_dir), "bundle_path": str(bundle_file),
            "bundle_tool": bundle.__file__, "snapshot_revision": revision,
            "api_image": "serversherpa-api:0123abcd"}


def test_restore_playbook_restores_db_and_objects(tmp_path):
    env_dir, env = _target(tmp_path)
    snap = make_bundle(tmp_path)
    result, calls = _play(tmp_path, "restore.yml", _restore_vars(env_dir, snap), env)
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    assert any(c.endswith("pg_restore --exit-on-error --no-owner --no-acl -U serversherpa "
                          "-d serversherpa") for c in calls)
    assert any("DELETE FROM auth_sessions" in c for c in calls)        # --clear-sessions
    assert (tmp_path / "docker.log.restored").read_bytes() == b"PGDMP-fake-dump"
    assert calls[-1] == (
        f"run --rm --network ss-e2e --env-file {env_dir}/.env "
        f"--user {os.getuid()}:{os.getgid()} -e HOME=/tmp -v {env_dir}/restore-work:/work:ro "
        "serversherpa-api:0123abcd python /work/bundle.py import-objects --in /work/objects.tar")
    assert not (env_dir / "restore-work").exists()
    assert "KEYS-TOKEN" not in out


def test_restore_playbook_refuses_a_newer_snapshot(tmp_path):
    env_dir, env = _target(tmp_path, head=88)
    snap = make_bundle(tmp_path)
    result, calls = _play(tmp_path, "restore.yml", _restore_vars(env_dir, snap), env)
    assert result.returncode != 0
    assert "at migration 0089, newer than this commit's newest migration (88)" in result.stdout
    assert calls == []


@pytest.mark.parametrize("revision, head, wiped", [
    (None, 88, True),             # a plain Reset: no snapshot, no check
    ("0089", 89, True),
    ("0089", 88, False),          # too new: refused before anything is deleted
])
def test_reset_playbook_checks_the_snapshot_before_wiping(tmp_path, revision, head, wiped):
    env_dir, env = _target(tmp_path, head=head)
    extra = _common(env_dir)
    if revision is not None:
        extra["snapshot_revision"] = revision
    result, calls = _play(tmp_path, "reset.yml", extra, env)
    out = result.stdout + result.stderr
    assert (result.returncode == 0) is wiped, out
    downs = [c for c in calls if c.startswith("compose") and c.endswith(" down --volumes")]
    assert bool(downs) is wiped, calls
    if not wiped:
        assert calls == []
        assert ("at migration 0089, newer than this commit's newest migration (88)"
                in result.stdout)


def test_reset_and_restore_share_the_revision_check():
    """The same three tasks: Reset runs them early (before the wipe), only
    when it restores a snapshot; Restore snapshot keeps them for a seeded
    first deploy, which has no Reset."""
    _, reset = _tasks("reset.yml")
    _, restore = _tasks("restore.yml")
    early = [t for t in reset if "ss-stack" not in t["name"]]
    assert [{k: v for k, v in t.items() if k != "when"} for t in early] == [
        {k: v for k, v in t.items() if k != "when"} for t in restore[:3]]
    for task in early:
        when = task["when"] if isinstance(task["when"], list) else [task["when"]]
        assert "snapshot_revision is defined" in when, task["name"]


def test_restore_playbook_stops_on_a_damaged_bundle_and_cleans_up(tmp_path):
    env_dir, env = _target(tmp_path)
    bad = tmp_path / "bad.tar.gz"
    bad.write_bytes(make_bundle(tmp_path).read_bytes()[:300])
    result, calls = _play(tmp_path, "restore.yml", _restore_vars(env_dir, bad), env)
    assert result.returncode != 0
    assert bundle._DAMAGED in result.stdout
    assert calls == []
    assert not (env_dir / "restore-work").exists()


def test_restore_dump_playbook(tmp_path):
    env_dir, env = _target(tmp_path)
    (env_dir / "backups" / "20261004T010203Z.dump").write_bytes(b"PGDMP-backup")
    extra = {**_common(env_dir), "dump_name": "20261004T010203Z.dump"}
    result, calls = _play(tmp_path, "restore_dump.yml", extra, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "docker.log.restored").read_bytes() == b"PGDMP-backup"
    assert not any("auth_sessions" in c for c in calls)

    missing = {**extra, "dump_name": "20200101T000000Z.dump"}
    result, _ = _play(tmp_path, "restore_dump.yml", missing, env)
    assert result.returncode != 0
    assert f"There's no backup 20200101T000000Z.dump in {env_dir}/backups." in result.stdout

    # Only `ss-stack dump` names: nothing outside backups/, even a file that exists.
    (env_dir / "backups" / "notes.dump").write_bytes(b"PGDMP-other")
    for bad in ("../.env", "notes.dump", "20261004T010203Z.dump/..", "/etc/passwd",
                "20261004T010203Z.dump.partial", "20261004T010203Z.dump\n"):
        Path(env["DOCKER_LOG"]).unlink(missing_ok=True)
        result, calls = _play(tmp_path, "restore_dump.yml", {**extra, "dump_name": bad}, env)
        assert result.returncode != 0, bad
        assert "isn't a backup name" in result.stdout, bad
        assert calls == [], bad


def _export_vars(env_dir: Path, dest: Path) -> dict:
    return {**_common(env_dir), "snapshot_dest": str(dest), "bundle_tool": bundle.__file__,
            "keys_enc_b64": base64.b64encode(b"KEYS-TOKEN-SECRET").decode(),
            "api_image": "serversherpa-api:0123abcd", "spaces_bucket": "serversherpa"}


def test_export_playbook_builds_and_fetches_a_bundle(tmp_path):
    env_dir, env = _target(tmp_path)
    dest = tmp_path / "sirdar" / "incoming" / "snap.tar.gz"
    result, calls = _play(tmp_path, "export.yml", _export_vars(env_dir, dest), env)
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    manifest, keys_name, keys = bundle.read_head(dest)
    assert bundle.verify(dest) == manifest
    assert (manifest["source"], manifest["alembic_revision"], manifest["bucket"],
            manifest["object_count"]) == ("e2e", "0089", "serversherpa", 1)
    assert (keys_name, keys) == ("keys.enc", b"KEYS-TOKEN-SECRET")
    db = f"compose --env-file {env_dir}/.env -f {env_dir}/repo/deploy/stack/db/compose.yml"
    assert calls[:3] == [
        f"{db} exec -T postgres psql -U serversherpa -d serversherpa -tAc "
        "SELECT version_num FROM alembic_version",
        f"{db} exec -T postgres pg_dump -U serversherpa -d serversherpa -Fc --no-owner "
        "--no-acl -f /tmp/sirdar-snapshot.dump",
        f"{db} cp postgres:/tmp/sirdar-snapshot.dump {env_dir}/snapshot-work/db.dump"]
    assert calls[3] == (
        f"run --rm --network ss-e2e --env-file {env_dir}/.env "
        f"--user {os.getuid()}:{os.getgid()} -e HOME=/tmp -v {env_dir}/snapshot-work:/work "
        "serversherpa-api:0123abcd python /work/bundle.py export-objects --out /work/objects.tar")
    assert calls[-1] == f"{db} exec -T postgres rm -f /tmp/sirdar-snapshot.dump"
    assert not (env_dir / "snapshot-work").exists()
    assert "KEYS-TOKEN-SECRET" not in out


def test_export_playbook_cleans_up_after_a_failure(tmp_path):
    env_dir, env = _target(tmp_path)
    dest = tmp_path / "sirdar" / "snap.tar.gz"
    result, calls = _play(tmp_path, "export.yml", _export_vars(env_dir, dest),
                          {**env, "FAKE_FAIL": "pg_dump"})
    assert result.returncode != 0
    assert calls[-1].endswith("exec -T postgres rm -f /tmp/sirdar-snapshot.dump")
    assert not (env_dir / "snapshot-work").exists()
    assert not dest.exists()


# ---- step 15: Remove environment ------------------------------------------------------

TEST_ROOT_ENV = "SIRDAR_TEST_TEARDOWN_ROOT"


def _teardown_vars(env_dir: Path, /, **override) -> dict:
    # _target names the folder "env": that is the environment name the
    # playbook's safety check compares against. Wrapped as the runner wraps
    # every extravar.
    return runner._unsafe({**_common(env_dir), "env_name": "env", "teardown_become": False,
                           **override})


def _teardown_target(tmp_path: Path, *, test_root: bool = True) -> tuple[Path, dict]:
    """_target, with the controller-side test root pointing at tmp_path
    (the only way to move the root away from /opt/serversherpa)."""
    env_dir, env = _target(tmp_path)
    env.pop(TEST_ROOT_ENV, None)
    if test_root:
        env[TEST_ROOT_ENV] = str(tmp_path)
    return env_dir, env


def test_teardown_playbook_stops_everything_and_removes_the_folder(tmp_path):
    env_dir, env = _teardown_target(tmp_path)
    result, calls = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir), env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert [c.split(" -f ")[-1] for c in calls if c.startswith("compose")] == [
        f"{env_dir}/repo/deploy/stack/{s}/compose.yml down --volumes"
        for s in ("status", "web", "api", "storage", "db")]
    assert "network rm ss-e2e" in calls
    assert not env_dir.exists()
    assert (REPO / "deploy" / "stack" / "ss-stack").is_file()      # the symlink went, not this


def test_teardown_playbook_gives_ss_stack_no_stdin():
    """docker compose under ss-stack must never read the SSH session's stdin."""
    _, tasks = _tasks("teardown.yml")
    down = [t for t in tasks if t["name"] == "ss-stack down --volumes"]
    assert len(down) == 1
    argv = down[0]["ansible.builtin.command"]["argv"]
    assert argv[:2] == ["sh", "-c"]
    assert argv[2] == 'exec "$0" down "$1" --volumes </dev/null'
    assert argv[3:] == ["{{ ss_stack }}", "{{ env_dir }}"]      # arguments, never script text


def test_teardown_playbook_removes_a_folder_that_never_deployed(tmp_path):
    env_dir, env = _teardown_target(tmp_path)
    (env_dir / ".env").unlink()
    result, calls = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir), env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert calls == [] and not env_dir.exists()
    again, _ = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir), env)
    assert again.returncode == 0, again.stdout + again.stderr


def _refused(tmp_path, env_dir, result, calls):
    out = result.stdout + result.stderr
    assert result.returncode != 0, out
    assert "Refusing to remove" in result.stdout, out
    assert calls == [], calls                                   # no docker
    assert env_dir.exists() and (env_dir / ".env").exists()     # no rm
    assert Path("/etc").exists()


def test_teardown_playbook_refuses_a_folder_outside_opt_serversherpa(tmp_path):
    env_dir, env = _teardown_target(tmp_path, test_root=False)
    result, calls = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir), env)
    _refused(tmp_path, env_dir, result, calls)
    assert f"Refusing to remove {env_dir}: it isn't /opt/serversherpa/env." in result.stdout


@pytest.mark.parametrize("override", [
    {"root": "/", "env_name": "etc", "env_dir": "//etc"},
    {"env_root": "", "env_name": "etc", "env_dir": "/etc"},
    {"env_root": "/", "env_name": "etc", "env_dir": "//etc"},
    {"root": "{tmp}"},                       # the real folder, moved under an extravar root
    {"env_root": "{tmp}"},
    {"teardown_root": "{tmp}"},
], ids=["root=/", "env_root=empty,/etc", "env_root=/", "root=tmp", "env_root=tmp",
        "teardown_root=tmp"])
def test_teardown_playbook_root_cannot_come_from_extravars(tmp_path, override):
    env_dir, env = _teardown_target(tmp_path, test_root=False)
    override = {k: v.format(tmp=tmp_path) for k, v in override.items()}
    result, calls = _play(tmp_path, "teardown.yml", _teardown_vars(env_dir, **override), env)
    _refused(tmp_path, env_dir, result, calls)


def test_teardown_playbook_lookup_cannot_be_shadowed(tmp_path):
    env_dir, env = _teardown_target(tmp_path, test_root=False)
    result, calls = _play(tmp_path, "teardown.yml",
                          _teardown_vars(env_dir, lookup=str(tmp_path)), env)
    assert result.returncode != 0
    assert calls == [] and env_dir.exists() and (env_dir / ".env").exists()


@pytest.mark.parametrize("env_name, env_dir", [
    ("env", "{root}/env/"),                 # not exactly the folder
    ("env", "{root}/env/.."),
    ("env", "{root}/other"),
    ("env", "{root}"),
    ("env", "{root}/env/repo"),
    ("..", "{root}/.."),
    ("Env", "{root}/Env"),
    ("env/x", "{root}/env/x"),
    ("e", "{root}/e"),
    ("env-", "{root}/env-"),                # names.CUSTOM_NAME_RE: no trailing hyphen
    ("env\n", "{root}/env\n"),            # \Z, not $: no trailing newline
    ("{{ 7*7 }}", "{root}/{{ 7*7 }}"),
])
def test_teardown_playbook_refuses_anything_but_root_slash_name(tmp_path, env_name, env_dir):
    real_dir, env = _teardown_target(tmp_path)
    extra = _teardown_vars(real_dir, env_name=env_name, env_dir=env_dir.format(root=tmp_path))
    result, calls = _play(tmp_path, "teardown.yml", extra, env)
    _refused(tmp_path, real_dir, result, calls)


def test_teardown_playbook_refuses_another_ss_stack(tmp_path):
    env_dir, env = _teardown_target(tmp_path)
    other = tmp_path / "bin" / "docker"
    result, calls = _play(tmp_path, "teardown.yml",
                          _teardown_vars(env_dir, ss_stack=str(other)), env)
    _refused(tmp_path, env_dir, result, calls)


def test_teardown_playbook_has_no_overridable_root():
    """The root is a literal in the assert, or the controller-side test
    variable; no play var an extravar could replace."""
    plays, tasks = _tasks("teardown.yml")
    assert "vars" not in plays[0]
    text = (PLAYBOOK_DIR / "teardown.yml").read_text()
    assert "env_root" not in text
    guard = tasks[0]["ansible.builtin.assert"]["that"]
    assert guard == [
        "env_name is match('^[a-z][a-z0-9-]{1,31}(?<!-)\\Z')",
        f"env_dir == (lookup('env', '{TEST_ROOT_ENV}') or '/opt/serversherpa') ~ '/' ~ env_name",
        "ss_stack == env_dir ~ '/repo/deploy/stack/ss-stack'",
    ]


def test_the_test_root_never_reaches_a_real_run(tmp_path, monkeypatch):
    """SIRDAR_TEST_TEARDOWN_ROOT is outside the runner's job-env allowlist:
    set in the API process, the playbook never sees it."""
    from .test_deploy_runner import _request
    monkeypatch.setenv(TEST_ROOT_ENV, "/")
    assert TEST_ROOT_ENV not in runner._INHERITED_ENV
    assert not TEST_ROOT_ENV.startswith(runner._INHERITED_PREFIXES)
    ansible = runner.AnsibleRunner(str(tmp_path / "runner"))
    run_dir = ansible.prepare(_request())
    try:
        built = ansible.build_runner(run_dir, _request(), lambda e: False, lambda: False)
        assert TEST_ROOT_ENV not in built.config.env
    finally:
        import shutil
        shutil.rmtree(run_dir)
