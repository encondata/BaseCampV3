"""scripts/make-seed-snapshot.sh with stand-ins: a docker that answers
pg_dump and psql, and a Python wrapper whose export-objects writes a small
objects.tar (the real one needs boto3 and the dev MinIO)."""

import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from sirdar_api.deploy import bundle

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "make-seed-snapshot.sh"
PEPPER = "dev-pepper-SECRET-abc123"
TOTP = "x" * 43 + "="
SPACES = "spaces-SECRET-777"
ENV = {"POSTGRES_USER": "serversherpa", "POSTGRES_DB": "serversherpa",
       "SS_SPACES_BUCKET": "serversherpa-dev", "SS_SPACES_ACCESS_KEY": "serversherpa",
       "SS_SPACES_SECRET_KEY": SPACES, "SS_PASSWORD_PEPPER": PEPPER,
       "SS_TOTP_ENCRYPTION_KEY": TOTP}

FAKE_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *pg_dump*) printf 'PGDMP-from-the-mac' ;;
  *alembic_version*) printf '0089\\n' ;;
esac
"""
# Runs the real interpreter, except export-objects: a one-object tar, after
# checking the secret came through the environment (never the arguments).
FAKE_PYTHON = f"""#!/usr/bin/env bash
if [[ ${{2:-}} == export-objects ]]; then
  printf '%s\\n' "$*" > "$PY_LOG"
  [[ $SNAP_S3_SECRET == {SPACES} ]] || {{ echo "wrong secret" >&2; exit 1; }}
  out=$4
  exec {sys.executable} -c 'import io, sys, tarfile
with tarfile.open(sys.argv[1], "w") as t:
    i = tarfile.TarInfo("people/1/avatar.png"); i.size = 3; t.addfile(i, io.BytesIO(b"png"))
print("{{}}")' "$out"
fi
exec {sys.executable} "$@"
"""


@pytest.fixture
def stage(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, text in (("docker", FAKE_DOCKER), ("python", FAKE_PYTHON)):
        (bin_dir / name).write_text(text)
        (bin_dir / name).chmod(0o755)
    env_file = tmp_path / "root.env"
    env_file.write_text("# dev\n" + "".join(f"{k}={v}\n" for k, v in ENV.items()))
    tmpdir = tmp_path / "tmpdir"
    tmpdir.mkdir()
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "TMPDIR": str(tmpdir),
           "DOCKER_LOG": str(tmp_path / "docker.log"), "PY_LOG": str(tmp_path / "py.log")}
    return {"tmp": tmp_path, "env": env, "env_file": env_file, "python": bin_dir / "python",
            "tmpdir": tmpdir}


def _run(stage, *extra):
    out = stage["tmp"] / "seed.tar.gz"
    args = ["bash", str(SCRIPT), "--out", str(out), "--env-file", str(stage["env_file"]),
            "--python", str(stage["python"]), *extra]
    return out, subprocess.run(args, env=stage["env"], capture_output=True, text=True,
                               cwd=stage["tmp"], check=False)


def test_builds_a_bundle_with_plain_keys(stage):
    out, result = _run(stage)
    assert result.returncode == 0, result.stderr
    manifest = bundle.verify(out)
    assert (manifest["source"], manifest["alembic_revision"], manifest["bucket"],
            manifest["object_count"]) == ("mac-dev", "0089", "serversherpa-dev", 1)
    _, name, keys = bundle.read_head(out)
    assert (name, keys.decode()) == (
        "keys.env", f"SS_PASSWORD_PEPPER={PEPPER}\nSS_TOTP_ENCRYPTION_KEY={TOTP}\n")
    with tarfile.open(out, "r:gz") as tar:
        assert tar.extractfile("db.dump").read() == b"PGDMP-from-the-mac"
    assert out.stat().st_mode & 0o777 == 0o600
    calls = (stage["tmp"] / "docker.log").read_text().splitlines()
    assert calls == [
        "exec serversherpa-dev-postgres-1 pg_dump -U serversherpa -d serversherpa -Fc "
        "--no-owner --no-acl",
        "exec serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa -tAc "
        "SELECT version_num FROM alembic_version"]
    exported = (stage["tmp"] / "py.log").read_text()
    assert "--endpoint http://127.0.0.1:9000 --key-id serversherpa --bucket serversherpa-dev" \
        in exported
    for secret in (PEPPER, TOTP, SPACES):
        assert secret not in result.stdout + result.stderr + exported
    assert "Snapshot bundle: " in result.stdout and "migration  0089" in result.stdout
    assert list(stage["tmpdir"].iterdir()) == []


def test_options(stage):
    out, result = _run(stage, "--source", "dev-oct", "--pg-container", "pg1",
                       "--s3-endpoint", "http://minio.local:9000")
    assert result.returncode == 0, result.stderr
    assert bundle.verify(out)["source"] == "dev-oct"
    assert (stage["tmp"] / "docker.log").read_text().startswith("exec pg1 pg_dump")
    assert "--endpoint http://minio.local:9000" in (stage["tmp"] / "py.log").read_text()


def test_refuses_an_existing_file_and_missing_settings(stage):
    (stage["tmp"] / "seed.tar.gz").write_text("keep me")
    _, result = _run(stage)
    assert result.returncode == 1 and "already exists" in result.stderr
    assert (stage["tmp"] / "seed.tar.gz").read_text() == "keep me"
    (stage["tmp"] / "seed.tar.gz").unlink()
    stage["env_file"].write_text("POSTGRES_USER=serversherpa\n")
    _, result = _run(stage)
    assert result.returncode == 1
    assert "POSTGRES_DB isn't set in" in result.stderr
    assert not (stage["tmp"] / "docker.log").exists()


def test_usage(stage):
    result = subprocess.run(["bash", str(SCRIPT), "--bogus", "x"], env=stage["env"],
                            capture_output=True, text=True, check=False)
    assert result.returncode == 2
    assert "scripts/make-seed-snapshot.sh [--out FILE]" in result.stdout + result.stderr
