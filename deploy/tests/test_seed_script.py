"""scripts/make-seed-snapshot.sh with stand-ins: a docker that answers
pg_dump and psql, a boto3 that serves two objects to the real
deploy/stack/objects.py, and a `slipway` CLI that records how it was called.
When Slipway itself is importable (its virtualenv runs these tests), one more
test packs with the real CLI and opens the file with the passphrase."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from conftest import REPO

SCRIPT = REPO / "scripts" / "make-seed-snapshot.sh"
# the kinds slipway.yml declares: a hex pepper and a Fernet 2FA key
PEPPER = "5ec2e7" * 10 + "abcd"
TOTP = "x" * 43 + "="
SPACES = "spaces-SECRET-777"
PASSPHRASE = "correct horse battery staple"
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
# boto3 as objects.py uses it: the settings must arrive as given, the
# secret through the environment.
FAKE_BOTO3 = f"""import datetime, io
ITEMS = {{"people/1/avatar.png": (b"png", "image/png")}}
class _Client:
    def list_objects_v2(self, Bucket, **kw):
        return {{"Contents": [{{"Key": k, "Size": len(v[0])}} for k, v in ITEMS.items()],
                "IsTruncated": False}}
    def get_object(self, Bucket, Key):
        data, ct = ITEMS[Key]
        return {{"Body": io.BytesIO(data), "ContentLength": len(data), "ContentType": ct,
                "LastModified": datetime.datetime(2026, 10, 4, tzinfo=datetime.timezone.utc)}}
def client(name, endpoint_url, region_name, aws_access_key_id, aws_secret_access_key, config):
    with open({{log!r}}, "w") as f:
        f.write(f"{{endpoint_url}} {{aws_access_key_id}} {{aws_secret_access_key == {SPACES!r}}}\\n")
    return _Client()
"""
# The Slipway CLI: its arguments, and the passphrase from stdin, written down;
# the --out file made the way pack would (owner-only).
FAKE_SLIPWAY = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$SLIPWAY_LOG"
IFS= read -r passphrase
printf '%s' "$passphrase" > "$SLIPWAY_LOG.passphrase"
args=("$@")
for (( i=0; i<${#args[@]}; i++ )); do
  case ${args[i]} in
    --database) cp "${args[i+1]}" "$SLIPWAY_LOG.database" ;;
    --files) cp "${args[i+1]}" "$SLIPWAY_LOG.files" ;;
    --identity-env) cp "${args[i+1]}" "$SLIPWAY_LOG.identity" ;;
    --revision-file) cp "${args[i+1]}" "$SLIPWAY_LOG.revision" ;;
    --out) out=${args[i+1]} ;;
  esac
done
( umask 077; printf 'SLWSNAP1' > "$out" )
echo "Wrote $out"
"""


@pytest.fixture
def stage(tmp_path: Path) -> dict:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, text in (("docker", FAKE_DOCKER), ("slipway", FAKE_SLIPWAY)):
        (bin_dir / name).write_text(text)
        (bin_dir / name).chmod(0o755)
    lib = tmp_path / "lib"
    (lib / "boto3").mkdir(parents=True)
    (lib / "botocore").mkdir()
    (lib / "boto3" / "__init__.py").write_text(
        FAKE_BOTO3.replace("{log!r}", repr(str(tmp_path / "s3.log"))))
    (lib / "botocore" / "__init__.py").write_text("")
    (lib / "botocore" / "config.py").write_text(
        "class Config:\n    def __init__(self, **kw): pass\n")
    env_file = tmp_path / "root.env"
    env_file.write_text("# dev\n" + "".join(f"{k}={v}\n" for k, v in ENV.items()))
    tmpdir = tmp_path / "tmpdir"
    tmpdir.mkdir()
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "TMPDIR": str(tmpdir),
           "PYTHONPATH": str(lib), "DOCKER_LOG": str(tmp_path / "docker.log"),
           "SLIPWAY_LOG": str(tmp_path / "slipway.log")}
    return {"tmp": tmp_path, "env": env, "env_file": env_file, "tmpdir": tmpdir}


def _run(stage: dict, *extra: str, stdin: str = PASSPHRASE + "\n"):
    out = stage["tmp"] / "seed.slipway-snapshot"
    args = ["bash", str(SCRIPT), "--out", str(out), "--env-file", str(stage["env_file"]),
            "--python", sys.executable, *extra]
    return out, subprocess.run(args, env=stage["env"], capture_output=True, text=True,
                               cwd=stage["tmp"], input=stdin, check=False)


def _log(stage: dict, suffix: str = "") -> str:
    return Path(f"{stage['env']['SLIPWAY_LOG']}{suffix}").read_text()


def test_packs_an_encrypted_slipway_snapshot(stage: dict) -> None:
    out, result = _run(stage)
    assert result.returncode == 0, result.stderr
    args = _log(stage).splitlines()
    work = Path(args[args.index("--database") + 1]).parent
    assert args == [
        "snapshot", "pack", "--app", "serversherpa", "--app-name", "ServerSherpa",
        "--repository", "encondata/BaseCampV3", "--format", "pg-custom",
        "--database", f"{work}/database", "--revision-file", f"{work}/revision",
        "--commit", args[args.index("--commit") + 1],
        "--files", f"{work}/files", "--files-format", "serversherpa-objects-v1",
        "--identity-env", f"{work}/identity.env",
        "--identity", "SS_PASSWORD_PEPPER,SS_TOTP_ENCRYPTION_KEY",
        "--source", "mac-dev", "--passphrase-stdin", "--out", str(out)]
    assert len(args[args.index("--commit") + 1]) == 40
    # the passphrase reaches slipway on stdin, never in argv
    assert _log(stage, ".passphrase") == PASSPHRASE
    assert _log(stage, ".database") == "PGDMP-from-the-mac"
    assert _log(stage, ".revision").strip() == "0089"
    assert _log(stage, ".identity") == (f"SS_PASSWORD_PEPPER={PEPPER}\n"
                                        f"SS_TOTP_ENCRYPTION_KEY={TOTP}\n")
    # the real objects.py exported the bucket, with the secret in its environment
    assert (stage["tmp"] / "s3.log").read_text() == "http://127.0.0.1:9000 serversherpa True\n"
    with tarfile.open(f"{stage['env']['SLIPWAY_LOG']}.files") as tar:
        member = tar.getmember("people/1/avatar.png")
        assert member.pax_headers["SLIPWAY.content_type"] == "image/png"
    calls = (stage["tmp"] / "docker.log").read_text().splitlines()
    assert calls == [
        "exec serversherpa-dev-postgres-1 pg_dump -U serversherpa -d serversherpa -Fc "
        "--no-owner --no-acl",
        "exec serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa -tAc "
        "SELECT version_num FROM alembic_version"]
    for secret in (PEPPER, TOTP, SPACES, PASSPHRASE):
        assert secret not in result.stdout + result.stderr
        assert secret not in "\n".join(args)
    assert list(stage["tmpdir"].iterdir()) == []   # the work folder is gone


def test_options(stage: dict) -> None:
    out, result = _run(stage, "--source", "dev-oct", "--pg-container", "pg1",
                       "--s3-endpoint", "http://minio.local:9000")
    assert result.returncode == 0, result.stderr
    args = _log(stage).splitlines()
    assert args[args.index("--source") + 1] == "dev-oct"
    assert (stage["tmp"] / "docker.log").read_text().startswith("exec pg1 pg_dump")
    assert (stage["tmp"] / "s3.log").read_text().startswith("http://minio.local:9000 ")


def test_refuses_an_existing_file_and_missing_settings(stage: dict) -> None:
    (stage["tmp"] / "seed.slipway-snapshot").write_text("keep me")
    _, result = _run(stage)
    assert result.returncode == 1 and "already exists" in result.stderr
    assert (stage["tmp"] / "seed.slipway-snapshot").read_text() == "keep me"
    (stage["tmp"] / "seed.slipway-snapshot").unlink()
    stage["env_file"].write_text("POSTGRES_USER=serversherpa\n")
    _, result = _run(stage)
    assert result.returncode == 1
    assert "POSTGRES_DB isn't set in" in result.stderr
    assert not (stage["tmp"] / "docker.log").exists()


def test_reads_the_env_file_the_way_dotenv_does(stage: dict) -> None:
    # .env.example's lines: inline comments after the identity keys and the
    # bucket, quoted values, a CRLF line and an earlier assignment
    stage["env_file"].write_text(
        "POSTGRES_USER=serversherpa\n"
        "POSTGRES_DB='serversherpa'   # quoted, then a comment\n"
        "SS_SPACES_BUCKET=serversherpa-prod\n"
        "SS_SPACES_BUCKET=serversherpa-dev          # dev: serversherpa-dev\n"
        "SS_SPACES_ACCESS_KEY=serversherpa\r\n"
        f'SS_SPACES_SECRET_KEY="{SPACES}"\n'
        f"SS_TOTP_ENCRYPTION_KEY={TOTP}         # Fernet key; encrypts TOTP seeds at rest\n"
        f"SS_PASSWORD_PEPPER= {PEPPER}\t\t# server-side pepper applied before Argon2\n"
        "SS_TOTP_TRUST_DAYS=7\n")
    _, result = _run(stage)
    assert result.returncode == 0, result.stderr
    assert "Exporting bucket serversherpa-dev from" in result.stdout
    assert _log(stage, ".identity") == (f"SS_PASSWORD_PEPPER={PEPPER}\n"
                                        f"SS_TOTP_ENCRYPTION_KEY={TOTP}\n")
    assert (stage["tmp"] / "s3.log").read_text() == "http://127.0.0.1:9000 serversherpa True\n"
    assert (stage["tmp"] / "docker.log").read_text().splitlines()[0].endswith(
        "pg_dump -U serversherpa -d serversherpa -Fc --no-owner --no-acl")


def test_refuses_text_after_a_closing_quote(stage: dict) -> None:
    # dotenv skips a line like that and keeps the earlier assignment: packing
    # the quoted value would pack a key the API doesn't run with
    other = "ab" * 32
    stage["env_file"].write_text(
        "".join(f"{k}={v}\n" for k, v in ENV.items())
        + f'SS_PASSWORD_PEPPER="{other}"x\n')
    out, result = _run(stage)
    assert result.returncode == 1
    assert (f"SS_PASSWORD_PEPPER in {stage['env_file']} has text after its closing quote; remove it"
            in result.stderr)
    assert "isn't set" not in result.stderr and other not in result.stderr
    assert not out.exists() and not (stage["tmp"] / "docker.log").exists()


def test_a_comment_may_follow_a_closing_quote(stage: dict) -> None:
    stage["env_file"].write_text(
        "".join(f"{k}={v}\n" for k, v in ENV.items() if k != "SS_PASSWORD_PEPPER")
        + f'SS_PASSWORD_PEPPER="{PEPPER}"# pepper\n')
    _, result = _run(stage)
    assert result.returncode == 0, result.stderr
    assert _log(stage, ".identity").startswith(f"SS_PASSWORD_PEPPER={PEPPER}\n")


@pytest.mark.parametrize(("key", "value", "message"), [
    ("SS_PASSWORD_PEPPER", "CHANGEME",
     "SS_PASSWORD_PEPPER in {env} isn't a hex key (32 to 256 lowercase hex characters)"),
    ("SS_PASSWORD_PEPPER", "abc123",
     "SS_PASSWORD_PEPPER in {env} isn't a hex key"),
    ("SS_PASSWORD_PEPPER", PEPPER.upper(),
     "SS_PASSWORD_PEPPER in {env} isn't a hex key"),
    ("SS_TOTP_ENCRYPTION_KEY", "CHANGEME",
     "SS_TOTP_ENCRYPTION_KEY in {env} isn't a Fernet key (44 characters ending in =)"),
    ("SS_TOTP_ENCRYPTION_KEY", "x" * 44,
     "SS_TOTP_ENCRYPTION_KEY in {env} isn't a Fernet key"),
])
def test_refuses_identity_keys_slipway_would_refuse(stage: dict, key: str, value: str,
                                                     message: str) -> None:
    stage["env_file"].write_text(
        "".join(f"{k}={value if k == key else v}\n" for k, v in ENV.items()))
    out, result = _run(stage)
    assert result.returncode == 1
    assert message.format(env=stage["env_file"]) in result.stderr
    assert value not in result.stderr
    assert not out.exists()
    assert not (stage["tmp"] / "docker.log").exists()   # refused before the dump


def test_needs_the_slipway_cli(stage: dict) -> None:
    _, result = _run(stage, "--slipway", "no-such-slipway-cli")
    assert result.returncode == 1
    assert "no Slipway CLI (no-such-slipway-cli)" in result.stderr
    assert not (stage["tmp"] / "docker.log").exists()


@pytest.mark.skipif(importlib.util.find_spec("slipway") is None,
                    reason="needs Slipway installed (its virtualenv's Python)")
def test_the_real_slipway_cli_makes_a_file_the_passphrase_opens(stage: dict) -> None:
    from slipway.services import snapfile

    cli = Path(sys.executable).parent / "slipway"
    out, result = _run(stage, "--slipway", str(cli))
    assert result.returncode == 0, result.stderr
    assert "Upload it on Slipway's Snapshots page" in result.stdout
    assert out.stat().st_mode & 0o777 == 0o600
    with out.open("rb") as f:
        preamble = snapfile.read_preamble(f)
    key = snapfile.unwrap_key(preamble.keyblock, PASSPHRASE, preamble.header_hash)
    with out.open("rb") as f:
        contents = snapfile.validate_container(f, key)
    manifest = contents.manifest
    assert (manifest["app"], manifest["repository"], manifest["source"]) == (
        "serversherpa", "encondata/BaseCampV3", "mac-dev")
    assert manifest["database"]["format"] == "pg-custom"
    assert manifest["database"]["revision"] == "0089"
    assert manifest["files"]["format"] == "serversherpa-objects-v1"
    assert manifest["identity"]["keys"] == ["SS_PASSWORD_PEPPER", "SS_TOTP_ENCRYPTION_KEY"]
    assert PEPPER.encode() not in out.read_bytes()   # encrypted, keys included
