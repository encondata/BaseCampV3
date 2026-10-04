# Sirdar deploy phase 3a (snapshots: backend, ss-stack, script, image) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sirdar snapshots end to end on the API side: a checked bundle format, upload from the Mac seed script, Take snapshot from an environment, restore a snapshot on Reset or on a new environment's first deploy, the Backups list with Restore backup, and Roll back after a failed Update.

**Architecture:** A stdlib-only module `deploy/bundle.py` reads and writes the bundle (`.tar.gz`: manifest, keys, `db.dump`, `objects.tar`); Sirdar imports it, the playbooks copy it to the target (host `python3` packs/unpacks, the environment's api image moves objects with boto3), and `scripts/make-seed-snapshot.sh` runs it on the Mac. `deploy/snapshots.py` owns the `snapshots` rows (migration 0005) and the bundles on `SIRDAR_SNAPSHOTS_DIR`; keys exist only as `keys.enc` (Fernet, `SIRDAR_SECRETS_KEY`). Snapshot work runs through the existing pipeline as deployment modes with four new playbooks: 8 Start data services (`ss-stack data`), 9 Restore snapshot / Restore backup (`ss-stack restore`), 10 Start services (renumbered from 8) and 11 Take snapshot (dump + export + pack + ansible `fetch`).

**Tech Stack:** FastAPI, SQLAlchemy 2 async + asyncpg, Alembic (raw SQL), ansible-core 2.21.4 + ansible-runner 2.4.3, Python `tarfile`/`hashlib` (no zstd), boto3 only inside the api image and the Mac's API virtualenv, bash (`ss-stack`, the seed script), pytest on real Postgres.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Sections 2–4, with the binding decisions in `docs/superpowers/plans/2026-10-04-sirdar-phase3-context.md`. The UI is plan 3b (`docs/superpowers/plans/2026-10-04-sirdar-phase3b-ui.md`), which uses exactly the API shapes listed under "API produced for 3b" below.

## Global Constraints

- Work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Paths below are relative to it. `sirdar` is both a branch and a folder: use `--` in `git diff`/`git log` (`git log -- sirdar/`).
- Python 3.13 for Sirdar, Ruff line length 100, `asyncio_mode = "auto"` (never add `@pytest.mark.asyncio`). The repo's Ruff baseline isn't clean; new and changed files must add nothing beyond the suite's existing `F811` fixture-import pattern: `.venv/bin/ruff check --select E,F,W --ignore F811 <files>` prints `All checks passed!`.
- Migration number is **0005** (`revision = "0005"`, `down_revision = "0004"`). Checked on 2026-10-04: 0004 is the newest in every worktree (only `sirdar` has 0004) and the dev `sirdar` database is at 0004.
- `sirdar_api/deploy/bundle.py` imports only the standard library at module level and runs on Python 3.8+ (target hosts' `python3`); boto3 is imported inside the object functions only.
- Bundle: one `.tar.gz`, members in this order and nothing else: `manifest.json`, the keys (`keys.enc`, or `keys.env` only in an upload from the Mac script), `db.dump`, `objects.tar`. Manifest keys: `format` (1), `source`, `created_at` (ISO, `Z`), `alembic_revision` (digits), `bucket`, `object_count`, `object_bytes`, `members` (SHA-256 hex of each other member). Objects keep their content type in the PAX header `SIRDAR.content_type`.
- Keys: `keys.enc` = Fernet(`SIRDAR_SECRETS_KEY`) of JSON `{"SS_PASSWORD_PEPPER": …, "SS_TOTP_ENCRYPTION_KEY": …}`. A stored bundle never holds plaintext keys: an upload with `keys.env` is rewritten to `keys.enc` on arrival and the plaintext copy deleted.
- Steps (number, key, name): 1 `preflight`, 2 `bootstrap`, 3 `fetch`, 4 `render`, 5 `build`, 6 `dump`, 7 `reset`, 8 `data` "Start data services", 9 `restore` "Restore snapshot", 9 `restore_dump` "Restore backup", 10 `up` "Start services", 11 `export` "Take snapshot". Steps run in number order; `restore` and `restore_dump` never share a plan. Migration 0005 moves every stored `up` step (and `failed_step`/`start_step`) from 8 to 10.
- Plans: update = 1,2,3,4,5,6,10; update restoring a seed (first deploy of an environment created from a snapshot) = 1,2,3,4,5,8,9,10; reset = 1,2,3,4,5,7,10; reset with a snapshot = 1,2,3,4,5,7,8,9,10; restore_dump = 1,8,9,10; rollback = 1,3,4,5,8,9,10; snapshot = 1,11.
- A snapshot job (`mode = "snapshot"`) never changes the environment's `status`, `current_sha` or `image_tag`; it still holds the per-environment deploy lock.
- Restore replaces the environment's stored `SS_PASSWORD_PEPPER` and `SS_TOTP_ENCRYPTION_KEY` with the snapshot's only when step 9 succeeds; step 4 already renders them into the `.env`. Restore clears `auth_sessions` and `trusted_devices`.
- A snapshot whose `alembic_revision` is newer than the deployed commit's newest `api/migrations/versions/NNNN_*.py` is refused (in `restore.yml`, after Fetch code).
- Secrets (environment secrets, snapshot keys, `keys.enc` and its base64, SSH/sudo passwords, key text) never appear in an API response, a log line, an audit `changes`, an exception message or a `repr()`. Every playbook task that mentions `env_file_b64` or `keys_enc_b64` is `no_log: true`. Error reasons are our own copy.
- Playbooks use no `shell`/`raw` modules (the test suite enforces it) and every task has a name.
- Errors: `HTTPException(status, detail={"code": "snake_code", ...})`. Host-key errors keep the `/connect` shapes (409 `host_key_unknown`, 409 `host_key_mismatch`, 502 `connect_failed`).
- Permissions reuse `deploy`: `view` = list snapshots, list backups, read deployments; `add` = upload, take, create an environment with a snapshot, Update (incl. a seeded first deploy); `change` = delete a snapshot, Reset (with or without a snapshot), Restore backup, Roll back, and their retries. Reset, Restore backup and Roll back also need `confirm_name` equal to the environment's name. Every successful mutation writes one audit row named `deploy.<verb>`.
- Settings: `SIRDAR_SNAPSHOTS_DIR` (default `/app/snapshots`; owned by uid 10001, mode 700; holds `<id>.tar.gz` bundles and `incoming/`), `SIRDAR_SNAPSHOT_MAX_BYTES` (default `5368709120`).
- American English in all copy, comments and docs. Display copy "Canceled"; the status value stays `cancelled`.
- Never commit `sirdar/.env`. No `npm install` in this worktree.

## Working environment

- Sirdar's dev database must be running. From the main checkout: `cd /Users/jrh1812/Developer/BaseCampV3 && docker compose -f docker-compose.dev.yml up -d sirdar-db` (Postgres on 127.0.0.1:5434).
- Every Sirdar test command runs from `sirdar/api` in the worktree: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api`, then `.venv/bin/pytest -q tests/<file>`. Give this session its own test database by prefixing `SIRDAR_TEST_DB=sirdar_test_phase3a` (the conftest creates it; drop it at the end, Task 11). Never point tests at the dev `sirdar` database.
- Deploy-stack tests run from the worktree root with the main checkout's API interpreter (it has pytest and boto3): `PY=/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python` then `$PY -m pytest -c deploy/pytest.ini deploy/tests`.
- The dev `sirdar/.env` is read by `Settings`; tests override with `monkeypatch.setenv` (an env var beats the file).
- Opt-in integration tests (Task 11): `SIRDAR_RUNNER_E2E=1` (needs Docker and `sshpass`) and `SS_STACK_E2E=1` (builds every image; ports 18xxx/19xxx).

## API produced for 3b

All under `/api/deploy`. Times are ISO 8601 strings.

- `SnapshotOut` = `{id, name, origin: "upload"|"environment", source, status: "pending"|"ready"|"failed", alembic_revision: str|null, size_bytes: int|null, checksum: str|null, object_count: int|null, object_bytes: int|null, notes: str, source_created_at: str|null, created_at: str, created_by_name: str|null, deployment_id: str|null}` (`deployment_id`: the snapshot job, taken snapshots only).
- `GET /snapshots` (view) → `{snapshots: SnapshotOut[]}` newest first.
- `POST /snapshots?name=<name>&notes=<notes>` (add), body = the raw bundle (`Content-Type: application/gzip`) → 201 `SnapshotOut`. Errors: 422 `snapshot_name_invalid`; 422 `notes_too_long`; 409 `snapshot_exists`; 413 `snapshot_too_large` `{max_bytes}`; 422 `bundle_invalid` `{reason}`; 422 `snapshot_keys_unreadable`; 400 `secrets_key_missing`; 500 `snapshots_dir_unwritable`.
- `POST /environments/{name}/snapshots` (add) body `{name, notes=""}` → 201 `{snapshot: SnapshotOut (status "pending"), deployment: Deployment (mode "snapshot")}`. Errors: 404 `environment_not_found`; 409 `deploy_in_progress`; 409 `not_deployed`; 422 `snapshot_name_invalid`; 409 `snapshot_exists`; 400 `secrets_key_missing`/`target_not_configured`; host-key shapes.
- `DELETE /snapshots/{id}` (change) → 204. Errors: 404 `snapshot_not_found`; 409 `snapshot_in_use` (pending, used by a running deployment, or the seed of an environment that hasn't deployed).
- `GET /environments/{name}/backups` (view) → `{backups: [{name, size_bytes, modified_at}]}` newest first (names like `20261004T010203Z.dump`). Errors: 400 `target_not_configured`; host-key shapes; 502 `connect_failed`.
- `POST /environments` (add) accepts `snapshot_id` (mode `new` only). Errors: 404 `snapshot_not_found`; 409 `snapshot_not_ready`; 422 `snapshot_not_allowed` (adopt).
- `POST /environments/{name}/deployments` (add) body `{mode: "update"|"reset"|"restore_dump", git_ref?, confirm_name?, snapshot_id? (reset only), backup? (restore_dump only)}`. `update` on a never-deployed environment with a seed restores the seed. `reset` and `restore_dump` need change + `confirm_name`. `restore_dump` deploys the running commit. Errors add: 422 `snapshot_not_allowed`; 404 `snapshot_not_found`; 409 `snapshot_not_ready`; 422 `backup_invalid`; 409 `not_deployed`.
- `POST /deployments/{id}/rollback` (change) body `{confirm_name}` → 201 `Deployment` (mode `rollback`, `sha` = the failed deployment's `previous_sha`, `restore_dump` = its dump's file name). Errors: 409 `rollback_unavailable`; 422 `confirm_name_mismatch`; 409 `rollback_not_latest`; 409 `deploy_in_progress`.
- `POST /deployments/{id}/retry` now also retries `restore_dump` and `rollback` (change + `confirm_name`); a `snapshot` job answers 409 `not_retryable`.
- `DeploymentSummary` adds `snapshot: {id, name}|null`, `restore_dump: str|null`, `rollback_available: bool` (mode `update`, status failed/cancelled/interrupted, a `dump_path` and a `previous_sha`). `Environment` adds `seed_snapshot: {id, name}|null`. Deployment `mode` may be `update|reset|adopt|snapshot|restore_dump|rollback`.

## Where Docker-in-container isn't possible (what proves what)

The opt-in SSH e2e (Task 11, `test_snapshot_e2e.py`) runs data, restore, restore_dump and export for real over SSH against the throwaway Ubuntu 24.04 container, with the real `ss-stack` and compose files in its repo folder, the container's own `python3` packing and unpacking with `bundle.py`, ansible's `copy` of the bundle to the target and `fetch` back to Sirdar, and the backups listing over SSH. That container has no Docker daemon, so a stand-in `docker` logs each call. What only that stand-in sees is proven elsewhere:

- Real Postgres and SeaweedFS: `deploy/tests/test_stack_e2e.py::test_snapshot_commands_round_trip` (`SS_STACK_E2E=1`, Docker on the Mac) runs export.yml's exact `pg_dump -f` + `docker compose cp`, `bundle.py export-objects`/`import-objects` through the real api image on `ss-e2e`, `ss-stack restore --clear-sessions` and `ss-stack data`, then migrates to head.
- Argument lists and failure paths: `tests/test_deploy_playbooks.py` (connection local) and `deploy/tests/test_ss_stack.py` (fake docker).
- Only the live verify on the real uat VM (plan 3b, last task) covers: Docker on Linux with the SSH user's uid/gid on bind mounts, ansible `copy`/`fetch` of a bundle of hundreds of MB, 17k objects, the restored keys letting a seeded user sign in, and the reverse proxy's upload size limit.

## File map

| File | Responsibility |
|---|---|
| `sirdar/api/src/sirdar_api/deploy/bundle.py` | Bundle format: pack, verify, read head, rewrite keys, unpack, export/import objects, CLI |
| `sirdar/api/migrations/versions/0005_snapshots.py` | `snapshots`; deployment modes + `snapshot_id`, `restore_dump`; `environments.seed_snapshot_id`; `up` 8 → 10 |
| `sirdar/api/src/sirdar_api/db/models.py` | `Snapshot`; new columns |
| `sirdar/api/src/sirdar_api/config.py` | `snapshots_dir`, `snapshot_max_bytes` |
| `sirdar/api/src/sirdar_api/deploy/snapshots.py` | Snapshot rows and files: upload, take, ingest, keys, delete, JSON |
| `deploy/stack/ss-stack` | `data` and `restore` commands |
| `sirdar/api/src/sirdar_api/deploy/steps.py` | Steps 1–11, plans per mode |
| `sirdar/api/src/sirdar_api/deploy/ansible/{data,restore,restore_dump,export}.yml` | The new host steps |
| `sirdar/api/src/sirdar_api/deploy/pipeline.py` | Snapshot modes, per-step vars, keys after restore, ingest after export, failed jobs |
| `sirdar/api/src/sirdar_api/deploy/environments.py` | Create with a seed; backups over SSH |
| `sirdar/api/src/sirdar_api/deploy/serialize.py` | `snapshot`, `restore_dump`, `rollback_available`, `seed_snapshot` |
| `sirdar/api/src/sirdar_api/api/routes/deploy.py` | Snapshot, backup, restore and rollback endpoints |
| `scripts/make-seed-snapshot.sh` | Bundle from the Mac dev stack |
| `sirdar/{Dockerfile,docker-compose.yml,.env.example,install.sh,.gitignore,README.md}`, `sirdar/scripts/dev-env.sh`, `sirdar/snapshots/.gitkeep`, `deploy/stack/README.md` | Snapshots volume, settings, docs |
| `sirdar/api/tests/…` | `bundle_helpers.py`, `test_deploy_bundle.py`, `test_deploy_snapshots.py`, `test_deploy_pipeline_snapshots.py`, `test_deploy_snapshots_api.py`, `test_seed_script.py`, `test_snapshot_e2e.py`; updates to conftest, factories, fake runner, models, playbooks, pipeline, environments API and deployments API tests |
| `deploy/tests/{test_ss_stack.py,test_stack_e2e.py}` | `data`/`restore` with fake docker; the real-container round trip |

---

### Task 1: The bundle format

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/bundle.py`
- Create: `sirdar/api/tests/bundle_helpers.py`
- Test: `sirdar/api/tests/test_deploy_bundle.py`

**Interfaces:**
- Produces (module `sirdar_api.deploy.bundle`, also run as a script): constants `FORMAT = 1`, `MANIFEST`, `KEYS_ENC = "keys.enc"`, `KEYS_ENV = "keys.env"`, `KEY_MEMBERS`, `DB_DUMP = "db.dump"`, `OBJECTS = "objects.tar"`, `CONTENT_TYPE_HEADER = "SIRDAR.content_type"`, `REVISION_RE`, `UTC`, `_DAMAGED`, `_LAYOUT`; `class BundleError(Exception)` with `.reason`; `sha256_file(path) -> str`; `objects_summary(path) -> tuple[int, int]`; `check_manifest(data) -> dict`; `parse_time(value) -> datetime`; `read_head(path) -> tuple[dict, str, bytes]` (manifest, keys member name, keys bytes); `verify(path) -> dict`; `pack(out, *, source, revision, bucket, db_dump, objects_tar, keys_file, keys_member=KEYS_ENC, created_at=None) -> dict`; `rewrite_keys(src, out, keys_enc: bytes) -> dict`; `unpack(path, dest) -> dict`; `s3_client(endpoint, key_id, secret)`; `export_objects(client, bucket, out) -> tuple[int, int]`; `import_objects(client, bucket, src, workers=8) -> tuple[int, int]`; `main(argv) -> int`.
- CLI: `bundle.py pack --out F --source S --revision R --bucket B --db F --objects F (--keys-enc F | --keys-env F)`; `bundle.py verify F`; `bundle.py unpack F DEST`; `bundle.py export-objects --out F [--endpoint URL] [--key-id ID] [--bucket B]`; `bundle.py import-objects --in F [...]`. The S3 secret comes from `SNAP_S3_SECRET` or `SPACES_SECRET_KEY`; the bucket defaults to `SS_SPACES_BUCKET`, then `serversherpa`; the endpoint to `http://seaweedfs:8333`. Exit 0, or 1 with `bundle: <reason>` on stderr.
- Produces (tests): `tests/bundle_helpers.py` — `OBJECTS`, `write_objects_tar(path, objects=OBJECTS)`, `write_parts(folder, *, keys=b"KEYS-TOKEN") -> dict[str, Path]` (`db` = `b"PGDMP-fake-dump"`), `make_bundle(folder, *, name="snap.tar.gz", source="uat", revision="0089", keys_member="keys.enc", keys=b"KEYS-TOKEN") -> Path`, `class FakeS3(objects=None, *, page_size=1000, fail_on=None)` with `.objects`, `.buckets`.

- [ ] **Step 1: Write the test helpers**

Create `sirdar/api/tests/bundle_helpers.py`:

```python
"""Builders for snapshot-bundle tests: the parts of a bundle, a whole
bundle, and a dict-backed stand-in for the S3 client calls bundle.py makes."""

import io
import tarfile
import threading
from datetime import UTC, datetime
from pathlib import Path

from sirdar_api.deploy import bundle

OBJECTS = {"a/hello.txt": (b"hello", "text/plain"), "b/doc.pdf": (b"%PDF-1.7 fake", None)}


def write_objects_tar(path: Path, objects: dict = OBJECTS) -> Path:
    with tarfile.open(path, "w", format=tarfile.PAX_FORMAT) as tar:
        for key, (data, content_type) in objects.items():
            info = tarfile.TarInfo(key)
            info.size = len(data)
            if content_type:
                info.pax_headers = {bundle.CONTENT_TYPE_HEADER: content_type}
            tar.addfile(info, io.BytesIO(data))
    return path


def write_parts(folder: Path, *, keys: bytes = b"KEYS-TOKEN") -> dict[str, Path]:
    parts = {"db": folder / "db.dump", "objects": folder / "objects-part.tar",
             "keys": folder / "keys-part"}
    parts["db"].write_bytes(b"PGDMP-fake-dump")
    write_objects_tar(parts["objects"])
    parts["keys"].write_bytes(keys)
    return parts


def make_bundle(folder: Path, *, name: str = "snap.tar.gz", source: str = "uat",
                revision: str = "0089", keys_member: str = "keys.enc",
                keys: bytes = b"KEYS-TOKEN") -> Path:
    parts_dir = folder / f"parts-{name}"
    parts_dir.mkdir(exist_ok=True)
    parts = write_parts(parts_dir, keys=keys)
    out = folder / name
    bundle.pack(out, source=source, revision=revision, bucket="serversherpa",
                db_dump=parts["db"], objects_tar=parts["objects"], keys_file=parts["keys"],
                keys_member=keys_member)
    return out


class FakeS3:
    """list_objects_v2 (paged), get_object and put_object over a dict of
    key -> (bytes, content type or None)."""

    def __init__(self, objects: dict | None = None, *, page_size: int = 1000,
                 fail_on: str | None = None):
        self.objects = dict(objects or {})
        self.page_size = page_size
        self.fail_on = fail_on
        self.buckets: set[str] = set()
        self._lock = threading.Lock()

    def list_objects_v2(self, Bucket, ContinuationToken=None):  # noqa: N803
        self.buckets.add(Bucket)
        keys = sorted(self.objects)
        start = int(ContinuationToken or 0)
        page = keys[start:start + self.page_size]
        out = {"Contents": [{"Key": k, "Size": len(self.objects[k][0])} for k in page],
               "IsTruncated": start + self.page_size < len(keys)}
        if out["IsTruncated"]:
            out["NextContinuationToken"] = str(start + self.page_size)
        return out

    def get_object(self, Bucket, Key):  # noqa: N803
        if Key == self.fail_on:
            raise RuntimeError("S3 went away")
        data, content_type = self.objects[Key]
        out = {"Body": io.BytesIO(data), "ContentLength": len(data),
               "LastModified": datetime(2026, 10, 1, tzinfo=UTC)}
        if content_type:
            out["ContentType"] = content_type
        return out

    def put_object(self, Bucket, Key, Body, ContentType=None):  # noqa: N803
        with self._lock:
            self.buckets.add(Bucket)
            self.objects[Key] = (Body, ContentType)
```

- [ ] **Step 2: Write the failing test**

Create `sirdar/api/tests/test_deploy_bundle.py`:

```python
import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from datetime import UTC, datetime

import pytest

from sirdar_api.deploy import bundle
from sirdar_api.deploy.bundle import BundleError

from .bundle_helpers import FakeS3, make_bundle, write_parts


def test_pack_writes_the_members_in_order(tmp_path):
    parts = write_parts(tmp_path)
    out = tmp_path / "snap.tar.gz"
    manifest = bundle.pack(out, source="uat", revision="0089", bucket="serversherpa",
                           db_dump=parts["db"], objects_tar=parts["objects"],
                           keys_file=parts["keys"], created_at="2026-10-04T12:00:00Z")
    with tarfile.open(out, "r:gz") as tar:
        assert tar.getnames() == ["manifest.json", "keys.enc", "db.dump", "objects.tar"]
        stored = json.loads(tar.extractfile("manifest.json").read())
        assert all(m.mode == 0o600 and m.uid == 0 for m in tar.getmembers())
    assert stored == manifest
    assert manifest == {
        "format": 1, "source": "uat", "created_at": "2026-10-04T12:00:00Z",
        "alembic_revision": "0089", "bucket": "serversherpa", "object_count": 2,
        "object_bytes": len(b"hello") + len(b"%PDF-1.7 fake"),
        "members": {"keys.enc": hashlib.sha256(b"KEYS-TOKEN").hexdigest(),
                    "db.dump": hashlib.sha256(b"PGDMP-fake-dump").hexdigest(),
                    "objects.tar": bundle.sha256_file(parts["objects"])}}
    assert out.stat().st_mode & 0o777 == 0o600
    assert not (tmp_path / "snap.tar.gz.partial").exists()


def test_verify_and_read_head(tmp_path):
    out = make_bundle(tmp_path)
    assert bundle.verify(out)["source"] == "uat"
    manifest, name, data = bundle.read_head(out)
    assert (manifest["alembic_revision"], name, data) == ("0089", "keys.enc", b"KEYS-TOKEN")


def _retar(src, dest, mutate):
    """Copy a bundle member by member through mutate(name, data) -> (name, data) | None."""
    with tarfile.open(src, "r:gz") as tin, tarfile.open(dest, "w:gz") as tout:
        for m in tin.getmembers():
            got = mutate(m.name, tin.extractfile(m).read())
            if got is None:
                continue
            name, data = got
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tout.addfile(info, io.BytesIO(data))


@pytest.mark.parametrize("mutate, reason", [
    (lambda n, d: (n, b"PGDMP-tampered") if n == "db.dump" else (n, d),
     "db.dump doesn't match its checksum in the manifest."),
    (lambda n, d: None if n == "objects.tar" else (n, d), bundle._LAYOUT),
    (lambda n, d: ("extra.txt", d) if n == "keys.enc" else (n, d), bundle._LAYOUT),
    (lambda n, d: (n, json.dumps({**json.loads(d), "format": 2}).encode())
     if n == "manifest.json" else (n, d),
     "This bundle's format isn't one Sirdar reads (format 1)."),
    (lambda n, d: (n, json.dumps({**json.loads(d), "alembic_revision": "abc"}).encode())
     if n == "manifest.json" else (n, d),
     "The manifest's Alembic revision is missing or isn't a migration number."),
    (lambda n, d: (n, b"{not json") if n == "manifest.json" else (n, d),
     "manifest.json isn't valid JSON."),
])
def test_verify_refuses_a_bad_bundle(tmp_path, mutate, reason):
    good = make_bundle(tmp_path)
    bad = tmp_path / "bad.tar.gz"
    _retar(good, bad, mutate)
    with pytest.raises(BundleError) as exc:
        bundle.verify(bad)
    assert exc.value.reason == reason


def test_verify_refuses_files_that_arent_bundles(tmp_path):
    plain = tmp_path / "plain.txt"
    plain.write_text("hello")
    cut = tmp_path / "cut.tar.gz"
    cut.write_bytes(make_bundle(tmp_path).read_bytes()[:200])
    gz_not_tar = tmp_path / "x.gz"
    gz_not_tar.write_bytes(gzip.compress(b"just text, not a tar"))
    for path in (plain, cut, gz_not_tar):
        with pytest.raises(BundleError) as exc:
            bundle.verify(path)
        assert exc.value.reason in (bundle._DAMAGED, bundle._LAYOUT)


def test_rewrite_keys_swaps_plain_keys_for_the_token(tmp_path):
    src = make_bundle(tmp_path, keys_member="keys.env", keys=b"SS_PASSWORD_PEPPER=p\n")
    out = tmp_path / "out.tar.gz"
    manifest = bundle.rewrite_keys(src, out, b"ENCRYPTED")
    assert set(manifest["members"]) == {"keys.enc", "db.dump", "objects.tar"}
    assert bundle.verify(out) == manifest
    assert bundle.read_head(out)[1:] == ("keys.enc", b"ENCRYPTED")
    with tarfile.open(out, "r:gz") as tar:
        assert b"SS_PASSWORD_PEPPER" not in b"".join(
            tar.extractfile(m).read() for m in tar.getmembers())
    assert out.stat().st_mode & 0o777 == 0o600


def test_rewrite_keys_leaves_nothing_when_the_source_is_bad(tmp_path):
    good = make_bundle(tmp_path, keys_member="keys.env", keys=b"K=v\n")
    bad = tmp_path / "bad.tar.gz"
    _retar(good, bad, lambda n, d: (n, b"x" * len(d)) if n == "objects.tar" else (n, d))
    out = tmp_path / "out.tar.gz"
    with pytest.raises(BundleError):
        bundle.rewrite_keys(bad, out, b"ENCRYPTED")
    assert not out.exists()
    assert not (tmp_path / "out.tar.gz.partial").exists()


def test_unpack_writes_the_data_but_never_the_keys(tmp_path):
    src = make_bundle(tmp_path)
    dest = tmp_path / "dest"
    dest.mkdir()
    assert bundle.unpack(src, dest)["source"] == "uat"
    assert sorted(p.name for p in dest.iterdir()) == ["db.dump", "objects.tar"]
    assert (dest / "db.dump").read_bytes() == b"PGDMP-fake-dump"
    assert (dest / "db.dump").stat().st_mode & 0o777 == 0o600


def test_objects_round_trip_keeps_content_types(tmp_path):
    source = FakeS3({"a/hello.txt": (b"hello", "text/plain"),
                     "b/doc.pdf": (b"%PDF", "application/pdf"),
                     "folder/": (b"", None),
                     "c/raw": (b"\x00\x01", None)}, page_size=2)
    out = tmp_path / "objects.tar"
    assert bundle.export_objects(source, "src-bucket", out) == (3, 5 + 4 + 2)
    assert out.stat().st_mode & 0o777 == 0o600
    target = FakeS3({"a/hello.txt": (b"old", "text/plain")})
    assert bundle.import_objects(target, "dest-bucket", out, workers=2) == (3, 11)
    assert target.objects == {"a/hello.txt": (b"hello", "text/plain"),
                              "b/doc.pdf": (b"%PDF", "application/pdf"),
                              "c/raw": (b"\x00\x01", None)}
    assert target.buckets == {"dest-bucket"}
    assert source.buckets == {"src-bucket"}


def test_a_failed_export_leaves_no_partial(tmp_path):
    source = FakeS3({"a": (b"1", None)}, fail_on="a")
    with pytest.raises(RuntimeError):
        bundle.export_objects(source, "b", tmp_path / "objects.tar")
    assert list(tmp_path.iterdir()) == []


def test_cli_pack_verify_unpack(tmp_path):
    parts = write_parts(tmp_path)
    tool = bundle.__file__
    out = tmp_path / "b.tar.gz"
    run = lambda *a: subprocess.run([sys.executable, tool, *a], capture_output=True,  # noqa: E731
                                    text=True, check=False)
    packed = run("pack", "--out", str(out), "--source", "mac-dev", "--revision", "0089\n",
                 "--bucket", "serversherpa-dev", "--db", str(parts["db"]),
                 "--objects", str(parts["objects"]), "--keys-env", str(parts["keys"]))
    assert packed.returncode == 0, packed.stderr
    assert json.loads(packed.stdout)["source"] == "mac-dev"
    checked = run("verify", str(out))
    assert json.loads(checked.stdout)["members"]["keys.env"]
    dest = tmp_path / "d"
    dest.mkdir()
    assert run("unpack", str(out), str(dest)).returncode == 0
    bad = run("verify", str(parts["db"]))
    assert (bad.returncode, bad.stderr.strip()) == (1, f"bundle: {bundle._DAMAGED}")
    missing = subprocess.run([sys.executable, tool, "export-objects", "--out", "x"],
                             capture_output=True, text=True,
                             env={"PATH": "/usr/bin:/bin"}, check=False)
    assert missing.returncode == 1
    assert "SNAP_S3_SECRET" in missing.stderr


def test_the_module_needs_only_the_standard_library():
    """The target's host python3 runs pack and unpack: no third-party import
    may happen at import time."""
    code = ("import sys, runpy; runpy.run_path(sys.argv[1]); "
            "bad = [m for m in ('boto3', 'botocore', 'sirdar_api', 'sqlalchemy') "
            "if m in sys.modules]; print(bad)")
    out = subprocess.run([sys.executable, "-c", code, bundle.__file__],
                         capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "[]"


def test_created_at_defaults_to_now(tmp_path):
    parts = write_parts(tmp_path)
    manifest = bundle.pack(tmp_path / "b.tar.gz", source="uat", revision="1",
                           bucket="serversherpa", db_dump=parts["db"],
                           objects_tar=parts["objects"], keys_file=parts["keys"])
    created = datetime.fromisoformat(manifest["created_at"])
    assert abs((datetime.now(UTC) - created).total_seconds()) < 60
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_bundle.py`
Expected: FAIL — `ImportError: cannot import name 'bundle' from 'sirdar_api.deploy'` (collection error).

- [ ] **Step 4: Write the module**

Create `sirdar/api/src/sirdar_api/deploy/bundle.py`:

```python
"""Snapshot bundles. One .tar.gz holds, in this order: manifest.json, the
keys (keys.enc, Fernet-encrypted by Sirdar, or keys.env, plaintext from
scripts/make-seed-snapshot.sh until Sirdar rewrites it), db.dump (pg_dump
custom format) and objects.tar (every object of the bucket: member name =
object key, content type in a PAX header).

Standard library only at import time, and Python 3.8 or newer: Sirdar
imports this module to check and rewrite bundles, the snapshot playbooks
run it on the target (the host's python3 packs and unpacks; the
environment's api image, which has boto3, moves the objects), and the Mac
seed script runs it with the API's virtualenv. Errors are BundleError with
our own copy; nothing here prints a key or a secret."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import zlib
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

FORMAT = 1
MANIFEST = "manifest.json"
KEYS_ENC = "keys.enc"
KEYS_ENV = "keys.env"
KEY_MEMBERS = (KEYS_ENC, KEYS_ENV)
DB_DUMP = "db.dump"
OBJECTS = "objects.tar"
CONTENT_TYPE_HEADER = "SIRDAR.content_type"
REVISION_RE = re.compile(r"[0-9]{1,8}")
SOURCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
BUCKET_RE = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
MANIFEST_LIMIT = 64 * 1024
KEYS_LIMIT = 16 * 1024
CHUNK = 1024 * 1024
DEFAULT_ENDPOINT = "http://seaweedfs:8333"
DEFAULT_KEY_ID = "serversherpa"
DEFAULT_BUCKET = "serversherpa"
_LAYOUT = ("The bundle must hold manifest.json, the keys, db.dump and objects.tar, "
           "in that order, and nothing else.")
_DAMAGED = "The file isn't a complete .tar.gz bundle."
UTC = timezone.utc


class BundleError(Exception):
    """`reason` is our own copy, safe to show and log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def sha256_file(path: str | os.PathLike) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def objects_summary(path: str | os.PathLike) -> tuple[int, int]:
    """(object count, total bytes) of an objects.tar."""
    count = total = 0
    try:
        with tarfile.open(path, "r:") as tar:
            for member in tar:
                if not member.isfile():
                    raise BundleError("objects.tar holds something other than files.")
                count += 1
                total += member.size
    except tarfile.TarError:
        raise BundleError("objects.tar isn't a tar archive.") from None
    return count, total


def check_manifest(data: object) -> dict:
    """The manifest, or BundleError naming what's wrong."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise BundleError(f"This bundle's format isn't one Sirdar reads (format {FORMAT}).")
    source = data.get("source")
    if not isinstance(source, str) or not SOURCE_RE.fullmatch(source):
        raise BundleError("The manifest's source is missing or invalid.")
    revision = data.get("alembic_revision")
    if not isinstance(revision, str) or not REVISION_RE.fullmatch(revision):
        raise BundleError("The manifest's Alembic revision is missing or isn't a "
                          "migration number.")
    try:
        parse_time(data.get("created_at"))
    except (TypeError, ValueError):
        raise BundleError("The manifest's creation time is invalid.") from None
    bucket = data.get("bucket")
    if not isinstance(bucket, str) or not BUCKET_RE.fullmatch(bucket):
        raise BundleError("The manifest's bucket name is invalid.")
    for key in ("object_count", "object_bytes"):
        value = data.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise BundleError(f"The manifest's {key} is invalid.")
    members = data.get("members")
    if not isinstance(members, dict):
        raise BundleError("The manifest has no member checksums.")
    keys = [k for k in KEY_MEMBERS if k in members]
    if len(keys) != 1 or set(members) != {keys[0], DB_DUMP, OBJECTS}:
        raise BundleError(_LAYOUT)
    if not all(isinstance(v, str) and SHA256_RE.fullmatch(v) for v in members.values()):
        raise BundleError("The manifest's checksums aren't SHA-256 hex.")
    return data


def parse_time(value) -> datetime:
    """A manifest time ("2026-10-04T12:00:00Z"); fromisoformat reads a
    trailing Z only from Python 3.11."""
    if not isinstance(value, str):
        raise TypeError("not a string")
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)


def _parse_manifest(raw: bytes) -> dict:
    try:
        return check_manifest(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeDecodeError):
        raise BundleError("manifest.json isn't valid JSON.") from None


def _member(name: str, size: int, mtime: float | None = None) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = 0o600
    info.mtime = int(mtime if mtime is not None else datetime.now(UTC).timestamp())
    return info


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class _HashingReader:
    """Reads through a file object, hashing what passes."""

    def __init__(self, f):
        self._f = f
        self._digest = hashlib.sha256()

    def read(self, n: int = -1) -> bytes:
        data = self._f.read(n)
        self._digest.update(data)
        return data

    def hexdigest(self) -> str:
        return self._digest.hexdigest()


def _scan(path, *, on_manifest=None, on_keys=None, on_data=None,
          head_only: bool = False) -> tuple[dict, str, bytes]:
    """One streaming pass over a bundle: the layout and every checksum are
    checked. on_manifest(manifest), on_keys(name, data) and
    on_data(name, size, reader) see the members as they pass; on_data may
    read its member (it is drained afterwards either way). head_only stops
    after the keys (no checksum of the big members)."""
    manifest: dict | None = None
    keys_name = ""
    keys_data = b""
    seen: list[str] = []
    try:
        with tarfile.open(path, "r|gz") as tar:
            for member in tar:
                if not member.isfile():
                    raise BundleError(_LAYOUT)
                if not seen:
                    if member.name != MANIFEST or member.size > MANIFEST_LIMIT:
                        raise BundleError(_LAYOUT)
                    manifest = _parse_manifest(tar.extractfile(member).read())
                    keys_name = next(k for k in KEY_MEMBERS if k in manifest["members"])
                    seen.append(MANIFEST)
                    if on_manifest is not None:
                        on_manifest(manifest)
                    continue
                expected = (keys_name, DB_DUMP, OBJECTS)
                if len(seen) > len(expected) or member.name != expected[len(seen) - 1]:
                    raise BundleError(_LAYOUT)
                src = tar.extractfile(member)
                if member.name == keys_name:
                    if member.size > KEYS_LIMIT:
                        raise BundleError("The bundle's keys file is too large.")
                    keys_data = src.read()
                    digest = hashlib.sha256(keys_data).hexdigest()
                else:
                    reader = _HashingReader(src)
                    if on_data is not None:
                        on_data(member.name, member.size, reader)
                    while reader.read(CHUNK):
                        pass
                    digest = reader.hexdigest()
                if digest != manifest["members"][member.name]:
                    raise BundleError(f"{member.name} doesn't match its checksum in the manifest.")
                seen.append(member.name)
                if member.name == keys_name:
                    if on_keys is not None:
                        on_keys(keys_name, keys_data)
                    if head_only:
                        return manifest, keys_name, keys_data
    except BundleError:
        raise
    except (tarfile.TarError, EOFError, zlib.error, OSError):
        raise BundleError(_DAMAGED) from None
    if len(seen) != 4:
        raise BundleError(_LAYOUT)
    return manifest, keys_name, keys_data


def read_head(path) -> tuple[dict, str, bytes]:
    """(manifest, keys member name, keys bytes), reading only the first two
    members; the big members' checksums are not checked."""
    return _scan(path, head_only=True)


def verify(path) -> dict:
    """Check the layout and every checksum; the manifest."""
    return _scan(path)[0]


def _write_partial(out: Path, write) -> None:
    partial = out.with_name(out.name + ".partial")
    try:
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as raw, \
                tarfile.open(fileobj=raw, mode="w:gz", compresslevel=1,
                             format=tarfile.PAX_FORMAT) as tar:
            write(tar)
        os.replace(partial, out)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def pack(out, *, source: str, revision: str, bucket: str, db_dump, objects_tar,
         keys_file, keys_member: str = KEYS_ENC, created_at: str | None = None) -> dict:
    """Write a bundle (mode 600) from its parts; the manifest."""
    if keys_member not in KEY_MEMBERS:
        raise BundleError("The keys member must be keys.enc or keys.env.")
    if os.path.getsize(keys_file) > KEYS_LIMIT:
        raise BundleError("The keys file is too large.")
    count, total = objects_summary(objects_tar)
    manifest = check_manifest({
        "format": FORMAT, "source": source, "created_at": created_at or _now_iso(),
        "alembic_revision": revision, "bucket": bucket,
        "object_count": count, "object_bytes": total,
        "members": {keys_member: sha256_file(keys_file), DB_DUMP: sha256_file(db_dump),
                    OBJECTS: sha256_file(objects_tar)},
    })
    raw = json.dumps(manifest, indent=2).encode()

    def write(tar: tarfile.TarFile) -> None:
        tar.addfile(_member(MANIFEST, len(raw)), io.BytesIO(raw))
        for name, path in ((keys_member, keys_file), (DB_DUMP, db_dump),
                           (OBJECTS, objects_tar)):
            with open(path, "rb") as f:
                tar.addfile(_member(name, os.path.getsize(path)), f)

    _write_partial(Path(out), write)
    return manifest


def rewrite_keys(src, out, keys_enc: bytes) -> dict:
    """Copy a bundle to `out` with its keys replaced by keys_enc (as
    keys.enc), checking every checksum on the way; the new manifest. `out`
    only appears when the whole source checked out."""
    if len(keys_enc) > KEYS_LIMIT:
        raise BundleError("The keys file is too large.")
    result: dict = {}

    def write(tar: tarfile.TarFile) -> None:
        def on_manifest(manifest: dict) -> None:
            members = {KEYS_ENC: hashlib.sha256(keys_enc).hexdigest(),
                       DB_DUMP: manifest["members"][DB_DUMP],
                       OBJECTS: manifest["members"][OBJECTS]}
            new = check_manifest({**manifest, "members": members})
            raw = json.dumps(new, indent=2).encode()
            tar.addfile(_member(MANIFEST, len(raw)), io.BytesIO(raw))
            tar.addfile(_member(KEYS_ENC, len(keys_enc)), io.BytesIO(keys_enc))
            result.update(new)

        def on_data(name: str, size: int, reader) -> None:
            tar.addfile(_member(name, size), reader)

        _scan(src, on_manifest=on_manifest, on_data=on_data)

    _write_partial(Path(out), write)
    return result


def unpack(path, dest) -> dict:
    """Check a bundle and write its db.dump and objects.tar (mode 600) into
    dest; the keys are never written. The manifest."""
    dest = Path(dest)

    def on_data(name: str, size: int, reader) -> None:
        fd = os.open(dest / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            while chunk := reader.read(CHUNK):
                f.write(chunk)

    return _scan(path, on_data=on_data)[0]


# ---- objects (boto3, only where a command needs it) ----------------------------

def s3_client(endpoint: str, key_id: str, secret: str):
    import boto3
    from botocore.config import Config

    return boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                        aws_access_key_id=key_id, aws_secret_access_key=secret,
                        config=Config(s3={"addressing_style": "path"},
                                      retries={"max_attempts": 5, "mode": "standard"}))


def export_objects(client, bucket: str, out) -> tuple[int, int]:
    """Every object of the bucket into a tar at `out` (written whole or not
    at all); (count, bytes). Zero-byte "folder/" markers are skipped."""
    out = Path(out)
    partial = out.with_name(out.name + ".partial")
    count = total = 0
    try:
        with tarfile.open(partial, "w", format=tarfile.PAX_FORMAT) as tar:
            token = None
            while True:
                kwargs = {"Bucket": bucket}
                if token:
                    kwargs["ContinuationToken"] = token
                page = client.list_objects_v2(**kwargs)
                for item in page.get("Contents", []):
                    key = item["Key"]
                    if key.endswith("/") and not item.get("Size"):
                        continue
                    obj = client.get_object(Bucket=bucket, Key=key)
                    info = _member(key, int(obj["ContentLength"]),
                                   obj["LastModified"].timestamp())
                    if obj.get("ContentType"):
                        info.pax_headers = {CONTENT_TYPE_HEADER: obj["ContentType"]}
                    tar.addfile(info, obj["Body"])
                    count += 1
                    total += info.size
                if not page.get("IsTruncated"):
                    break
                token = page["NextContinuationToken"]
        os.chmod(partial, 0o600)
        os.replace(partial, out)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return count, total


def import_objects(client, bucket: str, src, workers: int = 8) -> tuple[int, int]:
    """Upload every member of an objects.tar into the bucket (content type
    kept); (count, bytes). Existing objects with the same key are replaced."""
    count = total = 0
    try:
        with tarfile.open(src, "r:") as tar, ThreadPoolExecutor(workers) as pool:
            pending: set = set()
            for member in tar:
                if not member.isfile():
                    raise BundleError("objects.tar holds something other than files.")
                kwargs = {"Bucket": bucket, "Key": member.name,
                          "Body": tar.extractfile(member).read()}
                content_type = member.pax_headers.get(CONTENT_TYPE_HEADER)
                if content_type:
                    kwargs["ContentType"] = content_type
                pending.add(pool.submit(client.put_object, **kwargs))
                count += 1
                total += member.size
                if len(pending) >= workers * 2:
                    done, pending = wait(pending, return_when=FIRST_COMPLETED)
                    for future in done:
                        future.result()
            for future in pending:
                future.result()
    except tarfile.TarError:
        raise BundleError("objects.tar isn't a tar archive.") from None
    return count, total


# ---- command line ------------------------------------------------------------

def _s3_from_args(args):
    secret = os.environ.get("SNAP_S3_SECRET") or os.environ.get("SPACES_SECRET_KEY")
    if not secret:
        raise BundleError("Set SNAP_S3_SECRET (or SPACES_SECRET_KEY) to the bucket's secret key.")
    bucket = args.bucket or os.environ.get("SS_SPACES_BUCKET") or DEFAULT_BUCKET
    return s3_client(args.endpoint, args.key_id, secret), bucket


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bundle.py", description="Sirdar snapshot bundles")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pack")
    p.add_argument("--out", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--revision", required=True)
    p.add_argument("--bucket", required=True)
    p.add_argument("--db", required=True)
    p.add_argument("--objects", required=True)
    keys = p.add_mutually_exclusive_group(required=True)
    keys.add_argument("--keys-enc")
    keys.add_argument("--keys-env")
    v = sub.add_parser("verify")
    v.add_argument("bundle")
    u = sub.add_parser("unpack")
    u.add_argument("bundle")
    u.add_argument("dest")
    for name in ("export-objects", "import-objects"):
        o = sub.add_parser(name)
        o.add_argument("--out" if name == "export-objects" else "--in", dest="path",
                       required=True)
        o.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
        o.add_argument("--key-id", default=DEFAULT_KEY_ID)
        o.add_argument("--bucket", default="")
    args = parser.parse_args(argv)
    try:
        if args.command == "pack":
            manifest = pack(args.out, source=args.source, revision=args.revision.strip(),
                            bucket=args.bucket, db_dump=args.db, objects_tar=args.objects,
                            keys_file=args.keys_enc or args.keys_env,
                            keys_member=KEYS_ENC if args.keys_enc else KEYS_ENV)
            print(json.dumps({k: v for k, v in manifest.items() if k != "members"}))
        elif args.command == "verify":
            print(json.dumps(verify(args.bundle)))
        elif args.command == "unpack":
            print(json.dumps(unpack(args.bundle, args.dest)))
        else:
            client, bucket = _s3_from_args(args)
            run = export_objects if args.command == "export-objects" else import_objects
            count, total = run(client, bucket, args.path)
            print(json.dumps({"objects": count, "bytes": total}))
    except BundleError as e:
        print(f"bundle: {e.reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_bundle.py`
Expected: `17 passed`.

Then check the module on the oldest Python a target may have (macOS ships 3.9 at `/usr/bin/python3`):

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar
t=$(mktemp -d) && printf PGDMP > $t/db && printf K > $t/k
/usr/bin/python3 -c "import io,sys,tarfile; t=tarfile.open(sys.argv[1],'w'); i=tarfile.TarInfo('a'); i.size=1; t.addfile(i, io.BytesIO(b'x')); t.close()" $t/o.tar
/usr/bin/python3 sirdar/api/src/sirdar_api/deploy/bundle.py pack --out $t/b.tar.gz --source uat --revision 0089 --bucket serversherpa --db $t/db --objects $t/o.tar --keys-enc $t/k
mkdir $t/d && /usr/bin/python3 sirdar/api/src/sirdar_api/deploy/bundle.py unpack $t/b.tar.gz $t/d >/dev/null && ls $t/d; rm -rf $t
```

Expected: a JSON line with `"source": "uat"`, then `db.dump` and `objects.tar`.

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/bundle.py tests/bundle_helpers.py tests/test_deploy_bundle.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/bundle.py sirdar/api/tests/bundle_helpers.py sirdar/api/tests/test_deploy_bundle.py
git commit -m "feat(sirdar): snapshot bundle format (pack, verify, rewrite keys, unpack, objects)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `All checks passed!`, then one commit.

---

### Task 2: Migration 0005 and the models

**Files:**
- Create: `sirdar/api/migrations/versions/0005_snapshots.py`
- Modify: `sirdar/api/src/sirdar_api/db/models.py`
- Modify: `sirdar/api/tests/conftest.py` (`SIRDAR_TABLES`)
- Test: `sirdar/api/tests/test_deploy_models.py`

**Interfaces:**
- Produces: table `snapshots` (`id`, `name` UNIQUE as `snapshots_name_key`, `origin` upload|environment, `source`, `status` pending|ready|failed default ready, `alembic_revision`, `size_bytes`, `checksum`, `object_count`, `object_bytes`, `notes` default `''`, `bundle_file`, `source_created_at`, `created_by`, `created_at`; check `snapshots_ready_complete`: a ready row has `bundle_file`, `alembic_revision`, `size_bytes`, `checksum`); `deployments.mode` also `snapshot|restore_dump|rollback`; `deployments.snapshot_id` (FK, ON DELETE SET NULL); `deployments.restore_dump` text; `environments.seed_snapshot_id` (FK, ON DELETE SET NULL).
- Produces (ORM): `class Snapshot(Base)` with those columns; `Deployment.snapshot_id: uuid | None`, `Deployment.restore_dump: str | None`; `Environment.seed_snapshot_id: uuid | None`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_models.py`, replace:

```python
import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
)
```

with:

```python
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
    Snapshot,
)

from .conftest import API_DIR, TEST_DB, _psycopg_url
```

Append to the end of `sirdar/api/tests/test_deploy_models.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: FAIL — `ImportError: cannot import name 'Snapshot' from 'sirdar_api.db.models'`.

- [ ] **Step 3: Write the migration**

Create `sirdar/api/migrations/versions/0005_snapshots.py`:

```python
"""Deploy phase 3: snapshots, the deployment modes that use them, and the
spec's step numbers (Start services moves from 8 to 10 so that 8, start
data services, and 9, restore, run before it).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-04
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE snapshots (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL UNIQUE,
          origin text NOT NULL CHECK (origin IN ('upload', 'environment')),
          source text NOT NULL,
          status text NOT NULL DEFAULT 'ready'
            CHECK (status IN ('pending', 'ready', 'failed')),
          alembic_revision text,
          size_bytes bigint,
          checksum text,
          object_count integer,
          object_bytes bigint,
          notes text NOT NULL DEFAULT '',
          bundle_file text,
          source_created_at timestamptz,
          created_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT snapshots_ready_complete CHECK (status <> 'ready' OR (
            bundle_file IS NOT NULL AND alembic_revision IS NOT NULL
            AND size_bytes IS NOT NULL AND checksum IS NOT NULL))
        );
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback')),
          ADD COLUMN snapshot_id uuid REFERENCES snapshots(id) ON DELETE SET NULL,
          ADD COLUMN restore_dump text;
        ALTER TABLE environments
          ADD COLUMN seed_snapshot_id uuid REFERENCES snapshots(id) ON DELETE SET NULL;
        -- Before phase 3 step 8 was always "up" (Start services).
        UPDATE deployment_steps SET number = 10 WHERE key = 'up' AND number = 8;
        UPDATE deployments SET failed_step = 10 WHERE failed_step = 8;
        UPDATE deployments SET start_step = 10 WHERE start_step = 8;
    """)


def downgrade() -> None:
    op.execute("""
        DELETE FROM deployments WHERE mode IN ('snapshot', 'restore_dump', 'rollback');
        DELETE FROM deployment_steps WHERE key IN ('data', 'restore', 'restore_dump', 'export');
        UPDATE deployment_steps SET number = 8 WHERE key = 'up' AND number = 10;
        UPDATE deployments SET failed_step = 8 WHERE failed_step = 10;
        UPDATE deployments SET start_step = 8 WHERE start_step = 10;
        ALTER TABLE environments DROP COLUMN seed_snapshot_id;
        ALTER TABLE deployments
          DROP COLUMN restore_dump,
          DROP COLUMN snapshot_id,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN ('update', 'reset', 'adopt'));
        DROP TABLE snapshots;
    """)
```

- [ ] **Step 4: Update the models and the test truncate list**

In `sirdar/api/src/sirdar_api/db/models.py`, replace:

```python
"""Sirdar's own tables (migrations 0001–0004).
```

with:

```python
"""Sirdar's own tables (migrations 0001–0005).
```

In `sirdar/api/src/sirdar_api/db/models.py`, replace:

```python
    log_level: Mapped[str] = mapped_column(server_default=text("'INFO'"))
    created_by: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

with:

```python
    log_level: Mapped[str] = mapped_column(server_default=text("'INFO'"))
    # The snapshot the first deploy restores (migration 0005); kept afterwards.
    seed_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("snapshots.id", ondelete="SET NULL"))
    created_by: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

In `sirdar/api/src/sirdar_api/db/models.py`, replace:

```python
    mode: Mapped[str]                              # update | reset | adopt
```

with:

```python
    # update | reset | adopt | snapshot | restore_dump | rollback
    mode: Mapped[str]
```

In `sirdar/api/src/sirdar_api/db/models.py`, replace:

```python
    dump_path: Mapped[str | None]
    previous_sha: Mapped[str | None]
```

with:

```python
    dump_path: Mapped[str | None]
    # The snapshot a reset or first deploy restores, or the one a snapshot
    # job takes (migration 0005).
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("snapshots.id", ondelete="SET NULL"))
    # restore_dump / rollback: the backup's file name in <env-dir>/backups.
    restore_dump: Mapped[str | None]
    previous_sha: Mapped[str | None]
```

Append to the end of `sirdar/api/src/sirdar_api/db/models.py`:

```python
class Snapshot(Base):
    """A snapshot bundle on SIRDAR_SNAPSHOTS_DIR (migration 0005). A pending
    row belongs to a running "snapshot" deployment; ready rows have a
    bundle; failed rows are what a failed snapshot job left."""

    __tablename__ = "snapshots"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(unique=True)
    origin: Mapped[str]                            # upload | environment
    source: Mapped[str]                            # manifest source / environment name
    status: Mapped[str] = mapped_column(server_default=text("'ready'"))
    alembic_revision: Mapped[str | None]
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    checksum: Mapped[str | None]                   # SHA-256 of the bundle file
    object_count: Mapped[int | None] = mapped_column(Integer)
    object_bytes: Mapped[int | None] = mapped_column(BigInteger)
    notes: Mapped[str] = mapped_column(server_default=text("''"))
    bundle_file: Mapped[str | None]                # file name in SIRDAR_SNAPSHOTS_DIR
    source_created_at: Mapped[datetime | None]
    created_by: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

In `sirdar/api/tests/conftest.py`, replace:

```python
                 "deployment_steps")
```

with:

```python
                 "deployment_steps, snapshots")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_models.py`
Expected: `14 passed`. (The conftest migrates the test database to 0005 at session start; the last test downgrades to 0004 and back.)

- [ ] **Step 6: Commit**

```bash
git add sirdar/api/migrations/versions/0005_snapshots.py sirdar/api/src/sirdar_api/db/models.py sirdar/api/tests/conftest.py sirdar/api/tests/test_deploy_models.py
git commit -m "feat(sirdar): migration 0005 — snapshots, snapshot deployment modes, Start services is step 10

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Snapshot storage, keys and settings

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/snapshots.py`
- Modify: `sirdar/api/src/sirdar_api/config.py`
- Modify: `sirdar/api/tests/deploy_factories.py` (fixture `snapshots_dir`)
- Test: `sirdar/api/tests/test_deploy_snapshots.py`

**Interfaces:**
- Consumes: Task 1 `bundle.*`; Task 2 `Snapshot`, `Deployment.snapshot_id`, `Environment.seed_snapshot_id`; `vault.encrypt/decrypt/is_configured`, `envfile.parse_env/unsafe_value/PLACEHOLDER`.
- Produces: `Settings.snapshots_dir: str = "/app/snapshots"`, `Settings.snapshot_max_bytes: int = 5 * 1024 ** 3`.
- Produces (module `sirdar_api.deploy.snapshots`): `KEY_NAMES = ("SS_PASSWORD_PEPPER", "SS_TOTP_ENCRYPTION_KEY")`, `NAME_RE`, `NOTES_LIMIT = 2000`, `BUNDLE_TOOL: str` (absolute path of bundle.py), `_KEYS_INVALID`; `class SnapshotError(Exception)` with `.code`, `.extra`, property `.reason`; `root(settings) -> Path`; `incoming_dir(settings) -> Path`; `bundle_path(settings, snap) -> Path`; `fetched_path(settings, snapshot_id) -> Path`; `ensure_dirs(settings)`; `discard_fetched(settings, snapshot_id | None)`; `check_name(name) -> str`; `check_notes(notes) -> str`; `encrypt_keys(settings, keys: dict) -> bytes`; `decrypt_keys(settings, token: bytes) -> dict[str, str]`; `read_keys(settings, snap) -> dict[str, str]` (sync); `@dataclass Stored(manifest, bundle_file, size_bytes, checksum)`; `store_bundle(settings, src: Path, snapshot_id) -> Stored` (sync); `async receive_upload(db, settings, *, name, notes, chunks, content_length, actor_id) -> Snapshot`; `async begin_take(db, settings, env, *, name, notes, actor_id) -> Snapshot`; `ingest_fetched(settings, snapshot_id) -> Stored` (sync); `mark_ready(snap, stored)`; `async in_use(db, snap) -> bool`; `async delete(db, settings, snap) -> Path | None` (the caller unlinks the returned file after committing); `async ready_snapshot(db, snapshot_id) -> Snapshot`; `async list_all(db)`; `async snapshot_out(db, snap) -> dict`; `async snapshot_ref(db, snapshot_id) -> dict | None`.
- Error codes: `snapshot_name_invalid`, `notes_too_long`, `secrets_key_missing`, `snapshot_too_large` (`max_bytes`), `snapshot_exists`, `bundle_invalid` (`reason`), `snapshots_dir_unwritable`, `snapshot_keys_unreadable`, `snapshot_file_missing`, `not_deployed`, `snapshot_in_use`, `snapshot_not_found`, `snapshot_not_ready`.
- Produces (tests): fixture `snapshots_dir(monkeypatch, tmp_path, secrets_key)` in `deploy_factories.py` → the folder (`tmp_path / "snapshots"`).

- [ ] **Step 1: Add the fixture**

In `sirdar/api/tests/deploy_factories.py`, replace:

```python
@pytest.fixture
def fake_runner(monkeypatch):
```

with:

```python
@pytest.fixture
def snapshots_dir(monkeypatch, tmp_path, secrets_key):
    """SIRDAR_SNAPSHOTS_DIR in this test's tmp folder (and a secrets key)."""
    folder = tmp_path / "snapshots"
    monkeypatch.setenv("SIRDAR_SNAPSHOTS_DIR", str(folder))
    get_settings.cache_clear()
    yield folder
    get_settings.cache_clear()


@pytest.fixture
def fake_runner(monkeypatch):
```

- [ ] **Step 2: Write the failing test**

Create `sirdar/api/tests/test_deploy_snapshots.py`:

```python
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_snapshots.py`
Expected: FAIL — `ImportError: cannot import name 'snapshots' from 'sirdar_api.deploy'`.

- [ ] **Step 4: Add the settings**

In `sirdar/api/src/sirdar_api/config.py`, replace:

```python
    # What targets clone and fetch ServerSherpa from.
    deploy_repo_url: str = "https://github.com/encondata/BaseCampV3.git"
```

with:

```python
    # What targets clone and fetch ServerSherpa from.
    deploy_repo_url: str = "https://github.com/encondata/BaseCampV3.git"
    # Snapshot bundles (phase 3): one .tar.gz per snapshot, and incoming/ for
    # uploads and fetches in progress. Owned by uid 10001, mode 700.
    snapshots_dir: str = "/app/snapshots"
    # The largest snapshot upload Sirdar accepts, in bytes (default 5 GiB).
    snapshot_max_bytes: int = Field(default=5 * 1024 ** 3, gt=0)
```

- [ ] **Step 5: Write the module**

Create `sirdar/api/src/sirdar_api/deploy/snapshots.py`:

```python
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


def store_bundle(settings: Settings, src: Path, snapshot_id: uuid.UUID) -> Stored:
    """Check `src` (every checksum) and keep it as <id>.tar.gz with
    encrypted keys; `src` is gone afterwards either way. Sync."""
    dest = root(settings) / f"{snapshot_id}.tar.gz"
    try:
        _, name, data = bundle.read_head(src)
        if name == bundle.KEYS_ENV:
            text = data.decode("utf-8", errors="replace")
            token = encrypt_keys(settings, _valid_keys(envfile.parse_env(text)))
            manifest = bundle.rewrite_keys(src, dest, token)
        else:
            decrypt_keys(settings, data)
            manifest = bundle.verify(src)
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
                     notes: str | None, actor_id) -> Snapshot:
    """The pending row a Take snapshot job fills in."""
    name, notes = check_name(name), check_notes(notes)
    if not vault.is_configured(settings):
        raise SnapshotError("secrets_key_missing")
    if env.current_sha is None or env.image_tag is None:
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


async def delete(db: AsyncSession, settings: Settings, snap: Snapshot) -> Path | None:
    """Delete the row; the bundle file to remove once the caller has
    committed (None when there is none)."""
    if await in_use(db, snap):
        raise SnapshotError("snapshot_in_use")
    path = root(settings) / snap.bundle_file if snap.bundle_file else None
    await db.delete(snap)
    await db.flush()
    return path


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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_snapshots.py tests/test_scaffold.py`
Expected: all passed (`test_deploy_snapshots.py`: 15).

- [ ] **Step 7: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/snapshots.py src/sirdar_api/config.py tests/test_deploy_snapshots.py tests/deploy_factories.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/snapshots.py sirdar/api/src/sirdar_api/config.py sirdar/api/tests/deploy_factories.py sirdar/api/tests/test_deploy_snapshots.py
git commit -m "feat(sirdar): snapshot storage — upload checks, keys.enc only, take/ingest, in-use rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `ss-stack data` and `ss-stack restore`

**Files:**
- Modify: `deploy/stack/ss-stack`
- Modify: `deploy/stack/README.md`
- Test: `deploy/tests/test_ss_stack.py`
- Test (opt-in, run in Task 11): `deploy/tests/test_stack_e2e.py`

**Interfaces:**
- Produces: `ss-stack data <env-dir>` (network, db up --wait, storage up --wait); `ss-stack restore <env-dir> <file.dump> [--clear-sessions]` (network; stop status, web, api; db up --wait; `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`; `pg_restore --exit-on-error --no-owner --no-acl` from the file on stdin; with `--clear-sessions`, delete `auth_sessions` and `trusted_devices` when those tables exist; prints `restored <file>`). Exit 2 with usage on bad arguments; `no such dump file: <path>`, `pg_restore failed`, `couldn't empty the database`, `couldn't clear the sessions` on errors. Task 5's `data.yml` detects support with `grep -q "^  data)" ss-stack`.

- [ ] **Step 1: Write the failing tests**

In `deploy/tests/test_ss_stack.py`, replace:

```python
    printf 'PGDMP-fake' ;;
esac
```

with:

```python
    printf 'PGDMP-fake' ;;
  *pg_restore*)
    cat > "$DOCKER_LOG.stdin"
    [[ -n "${FAKE_FAIL_PG_RESTORE:-}" ]] && exit 1 ;;
esac
```

In `deploy/tests/test_ss_stack.py`, replace:

```python
    assert "ss-stack build" in out.stdout + out.stderr
```

with:

```python
    assert "ss-stack build" in out.stdout + out.stderr
    assert "ss-stack restore <env-dir> <file.dump> [--clear-sessions]" in out.stdout + out.stderr
```

Append to the end of `deploy/tests/test_ss_stack.py`:

```python
WAIT = "up -d --wait --wait-timeout 300 --remove-orphans"
PSQL = "exec -T postgres psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 -q"
CLEAR = ("DO $$ BEGIN IF to_regclass('public.auth_sessions') IS NOT NULL THEN DELETE FROM "
         "auth_sessions; END IF; IF to_regclass('public.trusted_devices') IS NOT NULL THEN "
         "DELETE FROM trusted_devices; END IF; END $$;")


def test_data_starts_only_the_database_and_storage(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "data", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == ["network inspect ss-uat", "network create ss-uat",
                           dc(env_dir, "db", WAIT), dc(env_dir, "storage", WAIT)]


def test_data_refuses_placeholder_secrets(env_dir: Path, fake: dict[str, str]) -> None:
    (env_dir / ".env").write_text(ENV_EXAMPLE.read_text())
    out = run(fake, "data", str(env_dir))
    assert out.returncode != 0 and calls(fake) == []


def _dump(tmp_path: Path) -> Path:
    dump = tmp_path / "20261004T010203Z.dump"
    dump.write_bytes(b"PGDMP-restore-me")
    return dump


def test_restore_stops_writers_empties_the_schema_and_restores(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "restore", str(env_dir), str(dump),
              "--clear-sessions")
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == f"restored {dump}"
    assert calls(fake) == [
        "network inspect ss-uat",
        dc(env_dir, "status", "stop"), dc(env_dir, "web", "stop"), dc(env_dir, "api", "stop"),
        dc(env_dir, "db", WAIT),
        dc(env_dir, "db", f"{PSQL} -c DROP SCHEMA public CASCADE; CREATE SCHEMA public;"),
        dc(env_dir, "db", "exec -T postgres pg_restore --exit-on-error --no-owner --no-acl "
                          "-U serversherpa -d serversherpa"),
        dc(env_dir, "db", f"{PSQL} -c {CLEAR}"),
    ]
    assert Path(fake["DOCKER_LOG"] + ".stdin").read_bytes() == b"PGDMP-restore-me"


def test_restore_keeps_sessions_unless_asked(env_dir: Path, fake: dict[str, str],
                                             tmp_path: Path) -> None:
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "restore", str(env_dir), str(_dump(tmp_path)))
    assert out.returncode == 0, out.stderr
    assert not any("auth_sessions" in c for c in calls(fake))


def test_restore_reports_a_failed_pg_restore(env_dir: Path, fake: dict[str, str],
                                             tmp_path: Path) -> None:
    out = run({**fake, "FAKE_FAIL_PG_RESTORE": "1"}, "restore", str(env_dir),
              str(_dump(tmp_path)), "--clear-sessions")
    assert out.returncode != 0
    assert "pg_restore failed" in out.stderr
    assert not any("auth_sessions" in c for c in calls(fake))


@pytest.mark.parametrize("args, code, message", [
    (["/no/such.dump"], 1, "no such dump file: /no/such.dump"),
    ([], 2, "ss-stack build"),
    (["DUMP", "--everything"], 2, "ss-stack build"),
])
def test_restore_arguments(env_dir: Path, fake: dict[str, str], tmp_path: Path,
                           args: list[str], code: int, message: str) -> None:
    args = [str(_dump(tmp_path)) if a == "DUMP" else a for a in args]
    out = run(fake, "restore", str(env_dir), *args)
    assert out.returncode == code
    assert message in out.stdout + out.stderr
    assert calls(fake) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from the worktree root): `PY=/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python; $PY -m pytest -q -c deploy/pytest.ini deploy/tests/test_ss_stack.py`
Expected: FAIL — the usage test and the new `data`/`restore` tests fail (usage printed, exit 2).

- [ ] **Step 3: Implement the commands**

In `deploy/stack/ss-stack`, replace:

```bash
#   ss-stack dump  <env-dir>              pg_dump into <env-dir>/backups (keeps STACK_KEEP_DUMPS)
#
```

with:

```bash
#   ss-stack dump  <env-dir>              pg_dump into <env-dir>/backups (keeps STACK_KEEP_DUMPS)
#   ss-stack data  <env-dir>              start only the database and storage, waiting on health
#   ss-stack restore <env-dir> <file.dump> [--clear-sessions]
#                                         stop the app stacks, empty the database, pg_restore the
#                                         dump; --clear-sessions also signs everyone out
#
```

In `deploy/stack/ss-stack`, replace:

```bash
usage() { sed -n '4,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }
```

with:

```bash
usage() { sed -n '4,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }
```

In `deploy/stack/ss-stack`, replace:

```bash
refuse_placeholders() {
```

with:

```bash
ensure_network() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
}

# A restored copy's sessions and remembered browsers belong to the source.
CLEAR_SESSIONS="DO \$\$ BEGIN IF to_regclass('public.auth_sessions') IS NOT NULL THEN DELETE FROM auth_sessions; END IF; IF to_regclass('public.trusted_devices') IS NOT NULL THEN DELETE FROM trusted_devices; END IF; END \$\$;"

refuse_placeholders() {
```

In `deploy/stack/ss-stack`, replace:

```bash
    refuse_placeholders
    docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
    dc db up -d "${WAIT[@]}"
```

with:

```bash
    refuse_placeholders
    ensure_network
    dc db up -d "${WAIT[@]}"
```

In `deploy/stack/ss-stack`, replace:

```bash
  ps)
    [[ $# -eq 0 ]] || usage
```

with:

```bash
  data)
    [[ $# -eq 0 ]] || usage
    refuse_placeholders
    ensure_network
    dc db up -d "${WAIT[@]}"
    dc storage up -d "${WAIT[@]}"
    ;;
  restore)
    [[ $# -eq 1 || $# -eq 2 ]] || usage
    dump=$1
    clear=""
    if [[ $# -eq 2 ]]; then
      [[ $2 == --clear-sessions ]] || usage
      clear=1
    fi
    [[ -f $dump && -r $dump ]] || die "no such dump file: $dump"
    refuse_placeholders
    ensure_network
    # nothing may write while the database is replaced: stop the writers
    # (stopping a stack that isn't running is a no-op), keep the database up
    for s in status web api; do dc "$s" stop </dev/null; done
    dc db up -d "${WAIT[@]}" </dev/null
    psql=(exec -T postgres psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 -q)
    # an empty schema, never pg_restore --clean: tables a newer migration
    # created aren't in the dump, and --clean would leave them behind
    dc db "${psql[@]}" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' </dev/null \
      || die "couldn't empty the database"
    dc db exec -T postgres pg_restore --exit-on-error --no-owner --no-acl \
      -U serversherpa -d serversherpa < "$dump" || die "pg_restore failed"
    if [[ -n $clear ]]; then
      dc db "${psql[@]}" -c "$CLEAR_SESSIONS" </dev/null || die "couldn't clear the sessions"
    fi
    echo "restored $dump"
    ;;
  ps)
    [[ $# -eq 0 ]] || usage
```

- [ ] **Step 4: Add the real-container round trip (opt-in, run in Task 11)**

In `deploy/tests/test_stack_e2e.py`, replace:

```python
import base64
import os
import secrets
import subprocess
```

with:

```python
import base64
import json
import os
import secrets
import shutil
import subprocess
```

In `deploy/tests/test_stack_e2e.py`, replace:

```python
# last in the file: it stops and restarts the api, web and status stacks
```

with:

```python
# it stops and restarts the api, web and status stacks
```

Append to the end of `deploy/tests/test_stack_e2e.py`:

```python
BUNDLE_TOOL = REPO / "sirdar" / "api" / "src" / "sirdar_api" / "deploy" / "bundle.py"


def _spaces(env_dir: Path):
    import boto3
    from botocore.config import Config
    secret = dict(l.split("=", 1) for l in (env_dir / ".env").read_text().splitlines()
                  if "=" in l)["SPACES_SECRET_KEY"]
    return boto3.client("s3", endpoint_url=f"http://127.0.0.1:{PORTS['SPACES']}",
                        region_name="us-east-1", aws_access_key_id="serversherpa",
                        aws_secret_access_key=secret,
                        config=Config(s3={"addressing_style": "path"}))


def _bundle_tool(env_dir: Path, mount: str, *args: str) -> subprocess.CompletedProcess[str]:
    """bundle.py in a one-off api container on ss-e2e, the way Sirdar's
    export.yml and restore.yml run it."""
    return subprocess.run(
        ["docker", "run", "--rm", "--network", "ss-e2e", "--env-file", str(env_dir / ".env"),
         "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp", "-v", mount,
         "serversherpa-api:e2e", "python", "/work/bundle.py", *args],
        capture_output=True, text=True, timeout=600)


# last in the file: it replaces the database and restarts the app stacks
def test_snapshot_commands_round_trip(env_dir: Path, tmp_path: Path) -> None:
    """The real-container half of Sirdar's Take snapshot and Restore snapshot
    steps: export.yml's pg_dump inside the db container and `compose cp`,
    bundle.py's object export and import through the api image on ss-e2e,
    and `ss-stack restore --clear-sessions` and `ss-stack data`."""
    work = tmp_path / "work"
    work.mkdir()
    shutil.copy(BUNDLE_TOOL, work / "bundle.py")
    (work / "bundle.py").chmod(0o644)
    s3 = _spaces(env_dir)
    s3.put_object(Bucket="serversherpa", Key="snap/probe.txt", Body=b"snapshot me",
                  ContentType="text/plain")

    in_container = "/tmp/sirdar-snapshot.dump"
    for args in (("exec", "-T", "postgres", "pg_dump", "-U", "serversherpa", "-d",
                  "serversherpa", "-Fc", "--no-owner", "--no-acl", "-f", in_container),
                 ("cp", f"postgres:{in_container}", str(work / "db.dump")),
                 ("exec", "-T", "postgres", "rm", "-f", in_container)):
        out = compose(env_dir, "db", *args)
        assert out.returncode == 0, out.stderr
    assert (work / "db.dump").read_bytes()[:5] == b"PGDMP"
    exported = _bundle_tool(env_dir, f"{work}:/work", "export-objects", "--out",
                            "/work/objects.tar")
    assert exported.returncode == 0, exported.stderr
    assert json.loads(exported.stdout)["objects"] >= 1

    assert psql(env_dir, "CREATE TABLE snapshot_probe (id int)").returncode == 0
    s3.delete_object(Bucket="serversherpa", Key="snap/probe.txt")
    restored = ss("restore", str(env_dir), str(work / "db.dump"), "--clear-sessions")
    assert restored.returncode == 0, restored.stdout[-2000:] + restored.stderr[-2000:]
    probe = psql(env_dir, "SELECT to_regclass('public.snapshot_probe') IS NULL")
    assert probe.stdout.strip() == "t", "a table the dump never held survived the restore"
    assert psql(env_dir, "SELECT count(*) FROM auth_sessions").stdout.strip() == "0"

    imported = _bundle_tool(env_dir, f"{work}:/work:ro", "import-objects", "--in",
                            "/work/objects.tar")
    assert imported.returncode == 0, imported.stderr
    obj = s3.get_object(Bucket="serversherpa", Key="snap/probe.txt")
    assert (obj["Body"].read(), obj["ContentType"]) == (b"snapshot me", "text/plain")

    data = ss("data", str(env_dir))
    assert data.returncode == 0, data.stderr[-2000:]
    up = ss("up", str(env_dir))
    assert up.returncode == 0, up.stdout[-4000:] + up.stderr[-4000:]
    current = compose(env_dir, "api", "exec", "-T", "-w", "/app/api", "api", "alembic", "current")
    assert "(head)" in current.stdout
```

- [ ] **Step 5: Document the commands**

In `deploy/stack/README.md`, replace:

```markdown
3. Set `STACK_IMAGE_TAG` in `/opt/serversherpa/uat/.env` back to the previous SHA.
4. `./ss-stack up /opt/serversherpa/uat`
```

with:

```markdown
3. Set `STACK_IMAGE_TAG` in `/opt/serversherpa/uat/.env` back to the previous SHA.
4. `./ss-stack up /opt/serversherpa/uat`

With an `ss-stack` from Sirdar deploy phase 3 on, steps 1 and 2 are one
command (it also starts the database if it is down):
`./ss-stack restore /opt/serversherpa/uat /opt/serversherpa/uat/backups/<file>.dump`.
`./ss-stack data /opt/serversherpa/uat` starts only the database and storage.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `PY=/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python; $PY -m pytest -q -c deploy/pytest.ini deploy/tests && $PY -m py_compile deploy/tests/test_stack_e2e.py && bash -n deploy/stack/ss-stack && echo ok`
Expected: `65 passed, 28 deselected`, then `ok`.

- [ ] **Step 7: Commit**

```bash
git add deploy/stack/ss-stack deploy/stack/README.md deploy/tests/test_ss_stack.py deploy/tests/test_stack_e2e.py
git commit -m "feat(deploy): ss-stack data and restore (writers stopped, empty schema, optional session clear)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Steps 1–11, the plans and the four new playbooks

**Files:**
- Modify (whole file): `sirdar/api/src/sirdar_api/deploy/steps.py`
- Create: `sirdar/api/src/sirdar_api/deploy/ansible/data.yml`, `restore.yml`, `restore_dump.yml`, `export.yml`
- Modify: `sirdar/api/src/sirdar_api/deploy/ansible/up.yml` (comment only)
- Test: `sirdar/api/tests/test_deploy_playbooks.py`, `sirdar/api/tests/test_deploy_pipeline.py` (Start services is step 10)

**Interfaces:**
- Consumes: Task 1 `bundle.py` (copied to the target; `make_bundle` in tests); Task 4 `ss-stack data` / `ss-stack restore`.
- Produces: `steps.MODES = ("update", "reset", "snapshot", "restore_dump", "rollback")`, `StepDef(number, key, name, playbook, timeout)` (no `modes` field any more), `STEPS` (12 entries, numbers 1–11 with two 9s), `STEPS_BY_KEY`, `plan_for(mode, *, restore=False) -> list[StepDef]` (ValueError for a pair with no plan).
- Playbook variables (all also get the common `env_name`, `env_dir`, `ss_stack`, `repo_url`, `sha`, `min_disk_gb`, `min_memory_mb` from the pipeline):
  - `data.yml`: none.
  - `restore.yml`: `bundle_path` (on Sirdar), `bundle_tool` (on Sirdar), `snapshot_revision`, `api_image`, optional `snapshot_python` (default `python3`). Work folder `<env-dir>/restore-work`, always removed.
  - `restore_dump.yml`: `dump_name` (a file in `<env-dir>/backups`).
  - `export.yml`: `snapshot_dest` (on Sirdar), `bundle_tool`, `keys_enc_b64` (no_log), `api_image`, `spaces_bucket`, optional `snapshot_python`. Work folder `<env-dir>/snapshot-work`, always removed, and the in-container dump `/tmp/sirdar-snapshot.dump` too.

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_playbooks.py`, replace:

```python
def test_plans():
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert [s.number for s in steps.plan_for("update")] == [1, 2, 3, 4, 5, 6, 8]
    assert [s.key for s in steps.plan_for("reset")] == [
        "preflight", "bootstrap", "fetch", "render", "build", "reset", "up"]
    with pytest.raises(ValueError):
        steps.plan_for("adopt")
    assert steps.STEPS_BY_KEY["up"].timeout >= 30 * 60
    assert steps.STEPS_BY_KEY["build"].timeout >= 60 * 60
    assert steps.STEPS_BY_KEY["up"].name == "Start services"
```

with:

```python
def _keys(mode, restore=False):
    return [s.key for s in steps.plan_for(mode, restore=restore)]


def test_plans():
    assert [s.number for s in steps.STEPS] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11]
    assert [s.number for s in steps.plan_for("update")] == [1, 2, 3, 4, 5, 6, 10]
    build = ["preflight", "bootstrap", "fetch", "render", "build"]
    assert _keys("update", True) == [*build, "data", "restore", "up"]
    assert _keys("reset") == [*build, "reset", "up"]
    assert _keys("reset", True) == [*build, "reset", "data", "restore", "up"]
    assert _keys("restore_dump") == ["preflight", "data", "restore_dump", "up"]
    assert _keys("rollback") == ["preflight", "fetch", "render", "build", "data",
                                 "restore_dump", "up"]
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
```

In `sirdar/api/tests/test_deploy_playbooks.py`, replace:

```python
        if "env_file_b64" in yaml.safe_dump(task) and "block" not in task:
            assert task.get("no_log") is True, f"{step.playbook}: {task['name']} needs no_log"
```

with:

```python
        text = yaml.safe_dump(task)
        if ("env_file_b64" in text or "keys_enc_b64" in text) and "block" not in task:
            assert task.get("no_log") is True, f"{step.playbook}: {task['name']} needs no_log"
```

In `sirdar/api/tests/test_deploy_playbooks.py`, replace:

```python
import json
import os
```

with:

```python
import base64
import json
import os
```

In `sirdar/api/tests/test_deploy_playbooks.py`, replace:

```python
from sirdar_api.deploy import steps
from sirdar_api.deploy.steps import PLAYBOOK_DIR
```

with:

```python
from sirdar_api.deploy import bundle, steps
from sirdar_api.deploy.steps import PLAYBOOK_DIR

from .bundle_helpers import make_bundle
```

Append to the end of `sirdar/api/tests/test_deploy_playbooks.py`:

```python
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
```

In `sirdar/api/tests/test_deploy_pipeline.py`, replace:

```python
        (5, "succeeded"), (6, "succeeded"), (8, "succeeded")]
```

with:

```python
        (5, "succeeded"), (6, "succeeded"), (10, "succeeded")]
```

In `sirdar/api/tests/test_deploy_pipeline.py`, replace:

```python
    assert dep.error == "Step 8 (Start services) timed out after 45 minutes."
```

with:

```python
    assert dep.error == "Step 10 (Start services) timed out after 45 minutes."
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_playbooks.py`
Expected: FAIL — `test_plans` (`TypeError: plan_for() got an unexpected keyword argument 'restore'`), `test_every_playbook_belongs_to_a_step`, and the new playbook tests (ansible-playbook can't find `data.yml`, `restore.yml`, …).

- [ ] **Step 3: Rewrite the step registry**

Replace the whole of `sirdar/api/src/sirdar_api/deploy/steps.py` with:

```python
"""The deploy steps (spec Section 2) and the plan each mode runs.

Numbers follow the spec's order: 8 starts the data services, 9 restores
data and 10 ("Start services": `ss-stack up` runs migrate, then the app)
covers spec steps 10–11. Restore snapshot and Restore backup share number
9 and never meet in one plan. Take snapshot (11) is a job of its own.
DNS, proxy and smoke tests (12–14) are phase 4."""

from dataclasses import dataclass
from pathlib import Path

PLAYBOOK_DIR = Path(__file__).resolve().parent / "ansible"
MODES = ("update", "reset", "snapshot", "restore_dump", "rollback")


@dataclass(frozen=True)
class StepDef:
    number: int
    key: str
    name: str
    playbook: str
    timeout: int                 # seconds for the whole playbook run


STEPS: tuple[StepDef, ...] = (
    StepDef(1, "preflight", "Preflight", "preflight.yml", 5 * 60),
    StepDef(2, "bootstrap", "Bootstrap", "bootstrap.yml", 30 * 60),
    StepDef(3, "fetch", "Fetch code", "fetch.yml", 15 * 60),
    StepDef(4, "render", "Render config", "render.yml", 5 * 60),
    StepDef(5, "build", "Build images", "build.yml", 90 * 60),
    StepDef(6, "dump", "Pre-deploy dump", "dump.yml", 30 * 60),
    StepDef(7, "reset", "Reset data", "reset.yml", 15 * 60),
    StepDef(8, "data", "Start data services", "data.yml", 15 * 60),
    StepDef(9, "restore", "Restore snapshot", "restore.yml", 120 * 60),
    StepDef(9, "restore_dump", "Restore backup", "restore_dump.yml", 60 * 60),
    StepDef(10, "up", "Start services", "up.yml", 45 * 60),
    StepDef(11, "export", "Take snapshot", "export.yml", 120 * 60),
)
STEPS_BY_KEY = {s.key: s for s in STEPS}

_BUILD = ("preflight", "bootstrap", "fetch", "render", "build")
# (mode, restores a snapshot) -> step keys, in order.
_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_BUILD, "dump", "up"),
    # the first deploy of an environment created from a snapshot
    ("update", True): (*_BUILD, "data", "restore", "up"),
    ("reset", False): (*_BUILD, "reset", "up"),
    ("reset", True): (*_BUILD, "reset", "data", "restore", "up"),
    ("restore_dump", False): ("preflight", "data", "restore_dump", "up"),
    # the previous commit, with the failed deployment's pre-deploy dump
    ("rollback", False): ("preflight", "fetch", "render", "build", "data", "restore_dump", "up"),
    ("snapshot", False): ("preflight", "export"),
}


def plan_for(mode: str, *, restore: bool = False) -> list[StepDef]:
    try:
        keys = _PLANS[(mode, restore)]
    except KeyError:
        raise ValueError(f"no deploy plan for mode {mode!r} (restore={restore})") from None
    return [STEPS_BY_KEY[k] for k in keys]
```

- [ ] **Step 4: Write the playbooks**

Create `sirdar/api/src/sirdar_api/deploy/ansible/data.yml`:

```yaml
# Step 8 — Start data services: the database and storage only (ss-stack
# data), so a restore can run before migrate and the app start. A checkout
# from before phase 3 has no data command: say so instead of printing
# ss-stack's usage.
- name: Start data services
  hosts: target
  gather_facts: false
  tasks:
    - name: Does this checkout's ss-stack have the data command?
      ansible.builtin.command:
        argv: [grep, -q, "^  data)", "{{ ss_stack }}"]
      register: knows_data
      changed_when: false
      failed_when: false

    - name: Stop when it doesn't
      ansible.builtin.fail:
        msg: >-
          This commit's ss-stack predates snapshots (it has no data command),
          so it can't restore. Deploy a newer commit.
      when: knows_data.rc != 0

    - name: ss-stack data
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", data, "{{ env_dir }}"]
```

Create `sirdar/api/src/sirdar_api/deploy/ansible/restore.yml`:

```yaml
# Step 9 — Restore snapshot (Reset with a snapshot, or the first deploy of
# an environment created from one). Refuses a snapshot whose database is at
# a newer migration than this commit has. Copies the bundle from Sirdar,
# checks every checksum while unpacking (the keys stay packed), restores the
# database with ss-stack restore (writers stopped, empty schema, sessions
# cleared) and uploads the objects into the environment's bucket through a
# one-off container of the api image Build images made. The snapshot's
# pepper and TOTP key are already in the .env that Render config wrote.
- name: Restore snapshot
  hosts: target
  gather_facts: false
  vars:
    work: "{{ env_dir }}/restore-work"
    bundle_python: "{{ snapshot_python | default('python3') }}"
  tasks:
    - name: This commit's migrations
      ansible.builtin.find:
        paths: "{{ env_dir }}/repo/api/migrations/versions"
        patterns: ["^[0-9]+_.*[.]py$"]
        use_regex: true
      register: migrations

    - name: This commit's newest migration
      ansible.builtin.set_fact:
        code_head: >-
          {{ migrations.files | map(attribute='path') | map('basename')
             | map('regex_search', '^[0-9]+') | map('int') | max }}
      when: migrations.files | length > 0

    - name: The snapshot isn't newer than the code
      ansible.builtin.assert:
        that:
          - migrations.files | length > 0
          - snapshot_revision | int <= code_head | int
        fail_msg: >-
          This snapshot's database is at migration {{ snapshot_revision }}, newer than
          this commit's newest migration ({{ code_head | default('none') }}). Deploy a
          newer commit, or pick another snapshot.
        quiet: true

    - name: Restore
      block:
        - name: Empty work folder
          ansible.builtin.file:
            path: "{{ work }}"
            state: absent

        - name: Work folder
          ansible.builtin.file:
            path: "{{ work }}"
            state: directory
            mode: "0700"

        - name: Bundle tool
          ansible.builtin.copy:
            src: "{{ bundle_tool }}"
            dest: "{{ work }}/bundle.py"
            mode: "0644"

        - name: Copy the snapshot from Sirdar
          ansible.builtin.copy:
            src: "{{ bundle_path }}"
            dest: "{{ work }}/bundle.tar.gz"
            mode: "0600"

        - name: Check and unpack it
          ansible.builtin.command:
            argv: ["{{ bundle_python }}", "{{ work }}/bundle.py", unpack, "{{ work }}/bundle.tar.gz",
                   "{{ work }}"]

        - name: Drop the packed copy
          ansible.builtin.file:
            path: "{{ work }}/bundle.tar.gz"
            state: absent

        - name: ss-stack restore
          ansible.builtin.command:
            argv: ["{{ ss_stack }}", restore, "{{ env_dir }}", "{{ work }}/db.dump",
                   --clear-sessions]

        - name: Who runs the upload
          ansible.builtin.command:
            argv: [id, -u]
          register: uid
          changed_when: false

        - name: Their group
          ansible.builtin.command:
            argv: [id, -g]
          register: gid
          changed_when: false

        - name: Upload the objects
          ansible.builtin.command:
            argv: [docker, run, --rm, --network, "ss-{{ env_name }}",
                   --env-file, "{{ env_dir }}/.env", --user, "{{ uid.stdout }}:{{ gid.stdout }}",
                   -e, HOME=/tmp, -v, "{{ work }}:/work:ro", "{{ api_image }}",
                   python, /work/bundle.py, import-objects, --in, /work/objects.tar]
      always:
        - name: Remove the work folder
          ansible.builtin.file:
            path: "{{ work }}"
            state: absent
```

Create `sirdar/api/src/sirdar_api/deploy/ansible/restore_dump.yml`:

```yaml
# Step 9 — Restore backup (Restore backup and Roll back): ss-stack restore
# stops the app stacks and puts one of the environment's own pre-deploy
# dumps back into an empty schema. Objects are not rolled back. Sessions
# stay: the dump comes from this environment, with its own keys.
- name: Restore backup
  hosts: target
  gather_facts: false
  tasks:
    - name: Look for the backup
      ansible.builtin.stat:
        path: "{{ env_dir }}/backups/{{ dump_name }}"
      register: backup

    - name: The backup exists
      ansible.builtin.assert:
        that: backup.stat.exists and backup.stat.isreg
        fail_msg: "There's no backup {{ dump_name }} in {{ env_dir }}/backups."
        quiet: true

    - name: ss-stack restore
      ansible.builtin.command:
        argv: ["{{ ss_stack }}", restore, "{{ env_dir }}", "{{ env_dir }}/backups/{{ dump_name }}"]
```

Create `sirdar/api/src/sirdar_api/deploy/ansible/export.yml`:

```yaml
# Step 11 — Take snapshot. Dumps the database (inside its container, then
# copied out), exports every object of the bucket through a one-off
# container of the environment's api image, packs both with the keys Sirdar
# sent (keys.enc, already encrypted with SIRDAR_SECRETS_KEY) and fetches the
# bundle to Sirdar, which checks it after this step. Uses docker compose
# with the stack's db compose file, never ss-stack, so it works on any
# checkout. The work folder and the in-container dump go however it ends.
- name: Take snapshot
  hosts: target
  gather_facts: false
  vars:
    work: "{{ env_dir }}/snapshot-work"
    bundle_python: "{{ snapshot_python | default('python3') }}"
    container_dump: /tmp/sirdar-snapshot.dump
    db_compose: [docker, compose, --env-file, "{{ env_dir }}/.env",
                 -f, "{{ env_dir }}/repo/deploy/stack/db/compose.yml"]
  tasks:
    - name: Export and fetch
      block:
        - name: Empty work folder
          ansible.builtin.file:
            path: "{{ work }}"
            state: absent

        - name: Work folder
          ansible.builtin.file:
            path: "{{ work }}"
            state: directory
            mode: "0700"

        - name: Bundle tool
          ansible.builtin.copy:
            src: "{{ bundle_tool }}"
            dest: "{{ work }}/bundle.py"
            mode: "0644"

        - name: Keys
          ansible.builtin.copy:
            content: "{{ keys_enc_b64 | b64decode }}"
            dest: "{{ work }}/keys.enc"
            mode: "0600"
          no_log: true

        - name: The database's migration
          ansible.builtin.command:
            argv: "{{ db_compose + ['exec', '-T', 'postgres', 'psql', '-U', 'serversherpa',
                   '-d', 'serversherpa', '-tAc', 'SELECT version_num FROM alembic_version'] }}"
          register: revision
          changed_when: false

        - name: pg_dump inside the database container
          ansible.builtin.command:
            argv: "{{ db_compose + ['exec', '-T', 'postgres', 'pg_dump', '-U', 'serversherpa',
                   '-d', 'serversherpa', '-Fc', '--no-owner', '--no-acl',
                   '-f', container_dump] }}"

        - name: Copy the dump out
          ansible.builtin.command:
            argv: "{{ db_compose + ['cp', 'postgres:' + container_dump, work + '/db.dump'] }}"

        - name: Who runs the export
          ansible.builtin.command:
            argv: [id, -u]
          register: uid
          changed_when: false

        - name: Their group
          ansible.builtin.command:
            argv: [id, -g]
          register: gid
          changed_when: false

        - name: Export the objects
          ansible.builtin.command:
            argv: [docker, run, --rm, --network, "ss-{{ env_name }}",
                   --env-file, "{{ env_dir }}/.env", --user, "{{ uid.stdout }}:{{ gid.stdout }}",
                   -e, HOME=/tmp, -v, "{{ work }}:/work", "{{ api_image }}",
                   python, /work/bundle.py, export-objects, --out, /work/objects.tar]

        - name: Pack the bundle
          ansible.builtin.command:
            argv: ["{{ bundle_python }}", "{{ work }}/bundle.py", pack, --out, "{{ work }}/bundle.tar.gz",
                   --source, "{{ env_name }}", --revision, "{{ revision.stdout | trim }}",
                   --bucket, "{{ spaces_bucket }}", --db, "{{ work }}/db.dump",
                   --objects, "{{ work }}/objects.tar", --keys-enc, "{{ work }}/keys.enc"]

        - name: Fetch the bundle to Sirdar
          ansible.builtin.fetch:
            src: "{{ work }}/bundle.tar.gz"
            dest: "{{ snapshot_dest }}"
            flat: true
      always:
        - name: Remove the dump from the database container
          ansible.builtin.command:
            argv: "{{ db_compose + ['exec', '-T', 'postgres', 'rm', '-f', container_dump] }}"
          changed_when: false
          failed_when: false

        - name: Remove the work folder
          ansible.builtin.file:
            path: "{{ work }}"
            state: absent
```

In `sirdar/api/src/sirdar_api/deploy/ansible/up.yml`, replace:

```yaml
# Step 8 — Start services: ss-stack up starts db, storage, the migrate job,
```

with:

```yaml
# Step 10 — Start services: ss-stack up starts db, storage, the migrate job,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_playbooks.py tests/test_deploy_runner.py tests/test_deploy_pipeline.py tests/test_deploy_deployments_api.py`
Expected: all passed (`test_deploy_playbooks.py`: 40). The pipeline and API keep working with the new numbers: `create_deployment` still calls `plan_for(mode)`.

- [ ] **Step 6: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/steps.py sirdar/api/src/sirdar_api/deploy/ansible sirdar/api/tests/test_deploy_playbooks.py sirdar/api/tests/test_deploy_pipeline.py
git commit -m "feat(sirdar): steps 1-11 and the snapshot playbooks (data, restore, restore_dump, export)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The pipeline runs the snapshot modes

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py`
- Modify: `sirdar/api/tests/fake_runner.py` (`effects`)
- Test: `sirdar/api/tests/test_deploy_pipeline_snapshots.py`

**Interfaces:**
- Consumes: Task 3 `snapshots.read_keys`, `bundle_path`, `fetched_path`, `ensure_dirs`, `encrypt_keys`, `ingest_fetched`, `mark_ready`, `discard_fetched`, `KEY_NAMES`, `BUNDLE_TOOL`, `SnapshotError.reason`; Task 5 `plan_for(mode, restore=...)`, `StepDef`.
- Produces: `pipeline.restores(mode, snapshot_id) -> bool`; `pipeline.plan_of(dep) -> list[StepDef]`; `create_deployment(db, env, *, mode, git_ref, sha, actor_id, start_step=1, retry_of=None, snapshot_id=None, restore_dump=None)` (a `snapshot` job leaves `env.status` alone); `_Context.step_vars`, `_Context.snapshot_keys`; after `restore` succeeds the environment's `SS_PASSWORD_PEPPER`/`SS_TOTP_ENCRYPTION_KEY` rows hold the snapshot's; after `export` succeeds the fetched bundle is checked and the snapshot becomes `ready` (a bad or missing bundle fails step 11 with `Step 11 (Take snapshot) failed: <reason>`); a failed, cancelled or interrupted snapshot job marks its snapshot `failed` and deletes the half-fetched file; a successful snapshot job leaves the environment's status and commit alone.
- Produces (tests): `FakeRunner.effects: dict[str, Callable[[RunRequest], None]]`, run after a step's gate, before it answers.

- [ ] **Step 1: Fake runner effects**

In `sirdar/api/tests/fake_runner.py`, replace:

```python
from canned results (default: success), with optional output, errors and
gates (an Event the step waits on, to test the lock and cancel)."""
```

with:

```python
from canned results (default: success), with optional output, errors,
gates (an Event the step waits on, to test the lock and cancel) and
effects (a function of the request, run before answering: what the real
playbook would leave behind, such as a fetched snapshot bundle)."""
```

In `sirdar/api/tests/fake_runner.py`, replace:

```python
        self.gates: dict[str, asyncio.Event] = {}
```

with:

```python
        self.gates: dict[str, asyncio.Event] = {}
        self.effects: dict = {}
```

In `sirdar/api/tests/fake_runner.py`, replace:

```python
        if request.step in self.gates:
            await self.gates[request.step].wait()
```

with:

```python
        if request.step in self.gates:
            await self.gates[request.step].wait()
        if request.step in self.effects:
            self.effects[request.step](request)
```

- [ ] **Step 2: Write the failing test**

Create `sirdar/api/tests/test_deploy_pipeline_snapshots.py`:

```python
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
    assert restore.extravars["bundle_path"] == str(snapshots.bundle_path(get_settings(), snap))
    assert restore.extravars["bundle_tool"] == snapshots.BUNDLE_TOOL
    assert restore.extravars["snapshot_revision"] == "0089"
    assert restore.extravars["api_image"] == "serversherpa-api:e73b99ca"
    assert steps[7].log == "pepper [redacted]\n"
    for key, value in SNAP_KEYS.items():
        assert await _secret(db, env.id, key) == value
    assert await _secret(db, env.id, "SS_JWT_SECRET") == ENV_SECRETS["SS_JWT_SECRET"]


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
    assert fake_runner.steps() == [*BUILD, "data", "restore", "up"]
    assert dep.status == "succeeded"


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
    assert fake_runner.steps() == ["preflight", "data", "restore_dump", "up"]
    request = next(r for r in fake_runner.requests if r.step == "restore_dump")
    assert request.extravars["dump_name"] == "20261004T010203Z.dump"
    assert (dep.status, e.current_sha) == ("succeeded", OLD)

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
    assert [s.key for s in pipeline.plan_of(dep)] == ["preflight", "data", "restore_dump",
                                                      "up"]
    assert pipeline.restores("reset", dep.id) and not pipeline.restores("snapshot", dep.id)
    assert not pipeline.restores("reset", None)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_pipeline_snapshots.py`
Expected: FAIL — most tests with `TypeError: create_deployment() got an unexpected keyword argument 'snapshot_id'`; `test_plan_of` with `AttributeError: module 'sirdar_api.deploy.pipeline' has no attribute 'plan_of'`-style errors.

- [ ] **Step 4: Implement**

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
"""Deployment pipeline (spec Section 2: steps 1–8 here; DNS, proxy and smoke
tests come in phase 4).
```

with:

```python
"""Deployment pipeline (spec Section 2: steps 1–11 here; DNS, proxy and smoke
tests come in phase 4). Besides Update and Reset it runs the snapshot
modes: Reset (or a first deploy) that restores a snapshot, Restore backup,
Roll back, and Take snapshot, a job that leaves the environment as it is.
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
)
from sirdar_api.deploy import ConnectFailed, envfile, known_hosts, ssh, targets, vault
```

with:

```python
from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    Snapshot,
)
from sirdar_api.deploy import ConnectFailed, envfile, known_hosts, snapshots, ssh, targets, vault
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
from sirdar_api.deploy.steps import STEPS_BY_KEY, plan_for
```

with:

```python
from sirdar_api.deploy.steps import STEPS_BY_KEY, StepDef, plan_for
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
def _now() -> datetime:
    return datetime.now(UTC)


# ---- records -----------------------------------------------------------------

async def create_deployment(db: AsyncSession, env: Environment, *, mode: str, git_ref: str,
                            sha: str, actor_id: uuid.UUID | None, start_step: int = 1,
                            retry_of: uuid.UUID | None = None) -> Deployment:
    """Add a running deployment and its step rows. The caller commits, then
    calls launch(). Raises DeployInProgress (only the insert is rolled back,
    through a savepoint: the caller's session and objects stay usable), or
    ValueError when start_step isn't a step of this mode's plan."""
    plan = plan_for(mode)
    if start_step not in {step.number for step in plan}:
        raise ValueError(f"start_step {start_step} isn't a step of the {mode} plan")
    dep = Deployment(environment_id=env.id, mode=mode, git_ref=git_ref, sha=sha,
                     status="running", start_step=start_step, retry_of=retry_of,
                     previous_sha=env.current_sha, actor_id=actor_id)
```

with:

```python
def _now() -> datetime:
    return datetime.now(UTC)


def restores(mode: str, snapshot_id: uuid.UUID | None) -> bool:
    """Whether a deployment restores a snapshot (Reset with one, or the first
    deploy of an environment created from one). A snapshot job also points
    at a snapshot, but takes it."""
    return snapshot_id is not None and mode in ("update", "reset")


def plan_of(dep: Deployment) -> list[StepDef]:
    return plan_for(dep.mode, restore=restores(dep.mode, dep.snapshot_id))


# ---- records -----------------------------------------------------------------

async def create_deployment(db: AsyncSession, env: Environment, *, mode: str, git_ref: str,
                            sha: str, actor_id: uuid.UUID | None, start_step: int = 1,
                            retry_of: uuid.UUID | None = None,
                            snapshot_id: uuid.UUID | None = None,
                            restore_dump: str | None = None) -> Deployment:
    """Add a running deployment and its step rows. The caller commits, then
    calls launch(). Raises DeployInProgress (only the insert is rolled back,
    through a savepoint: the caller's session and objects stay usable), or
    ValueError when start_step isn't a step of this mode's plan. A snapshot
    job leaves the environment's status alone."""
    plan = plan_for(mode, restore=restores(mode, snapshot_id))
    if start_step not in {step.number for step in plan}:
        raise ValueError(f"start_step {start_step} isn't a step of the {mode} plan")
    dep = Deployment(environment_id=env.id, mode=mode, git_ref=git_ref, sha=sha,
                     status="running", start_step=start_step, retry_of=retry_of,
                     previous_sha=env.current_sha, actor_id=actor_id,
                     snapshot_id=snapshot_id, restore_dump=restore_dump)
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
    for step in plan:
        db.add(DeploymentStep(deployment_id=dep.id, number=step.number, key=step.key,
                              name=step.name,
                              status="skipped" if step.number < start_step else "pending"))
    env.status = "deploying"
    env.updated_at = _now()
    await db.flush()
    return dep
```

with:

```python
    for step in plan:
        db.add(DeploymentStep(deployment_id=dep.id, number=step.number, key=step.key,
                              name=step.name,
                              status="skipped" if step.number < start_step else "pending"))
    if mode != "snapshot":
        env.status = "deploying"
        env.updated_at = _now()
    await db.flush()
    return dep
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
        await s.execute(update(Environment)
                        .where(Environment.id.in_(select(Deployment.environment_id)
                                                  .where(Deployment.id.in_(ids))),
                               Environment.status == "deploying")
                        .values(status="failed", updated_at=now))
        await s.execute(update(Deployment).where(Deployment.id.in_(ids))
                        .values(status="interrupted", finished_at=now, error=INTERRUPTED))
        await s.commit()
        return len(ids)
```

with:

```python
        await s.execute(update(Environment)
                        .where(Environment.id.in_(select(Deployment.environment_id)
                                                  .where(Deployment.id.in_(ids))),
                               Environment.status == "deploying")
                        .values(status="failed", updated_at=now))
        taken = list(await s.scalars(select(Deployment.snapshot_id).where(
            Deployment.id.in_(ids), Deployment.mode == "snapshot",
            Deployment.snapshot_id.is_not(None))))
        if taken:
            await s.execute(update(Snapshot).where(Snapshot.id.in_(taken),
                                                   Snapshot.status == "pending")
                            .values(status="failed"))
        await s.execute(update(Deployment).where(Deployment.id.in_(ids))
                        .values(status="interrupted", finished_at=now, error=INTERRUPTED))
        await s.commit()
    settings = get_settings()
    for snapshot_id in taken:
        snapshots.discard_fetched(settings, snapshot_id)
    return len(ids)
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
    """End a deployment that didn't succeed, in a fresh session (the run's own
    session may be mid-transaction or cancelled)."""
    now = _now()
    async with get_sessionmaker()() as s:
```

with:

```python
    """End a deployment that didn't succeed, in a fresh session (the run's own
    session may be mid-transaction or cancelled). A snapshot job's pending
    snapshot becomes failed (and its half-fetched bundle goes); any other
    mode leaves the environment failed."""
    now = _now()
    taken: uuid.UUID | None = None
    async with get_sessionmaker()() as s:
        mode, snapshot_id = (await s.execute(
            select(Deployment.mode, Deployment.snapshot_id)
            .where(Deployment.id == deployment_id))).one()
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
        await s.execute(update(Deployment).where(Deployment.id == deployment_id)
                        .values(status=dep_status, finished_at=now, error=error,
                                failed_step=failed_step))
        await s.execute(update(Environment).where(Environment.id == env_id)
                        .values(status="failed", updated_at=now))
        await s.commit()
```

with:

```python
        await s.execute(update(Deployment).where(Deployment.id == deployment_id)
                        .values(status=dep_status, finished_at=now, error=error,
                                failed_step=failed_step))
        if mode == "snapshot":
            taken = snapshot_id
            if snapshot_id is not None:
                await s.execute(update(Snapshot).where(Snapshot.id == snapshot_id,
                                                       Snapshot.status == "pending")
                                .values(status="failed"))
        else:
            await s.execute(update(Environment).where(Environment.id == env_id)
                            .values(status="failed", updated_at=now))
        await s.commit()
    snapshots.discard_fetched(get_settings(), taken)
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
@dataclass(frozen=True)
class _Context:
    target: RunTarget
    common: dict = field(repr=False)
    env_file_b64: str = field(repr=False)
    redactor: Redactor = field(repr=False)
    # An environment that has deployed before has a database worth keeping:
    # its pre-deploy dump must happen (dump.yml fails rather than skip it).
    dump_required: bool = False

    def vars_for(self, step_key: str) -> dict:
        if step_key == "render":
            return {**self.common, "env_file_b64": self.env_file_b64}
        if step_key == "dump":
            return {**self.common, "dump_required": self.dump_required}
        return dict(self.common)
```

with:

```python
@dataclass(frozen=True)
class _Context:
    target: RunTarget
    common: dict = field(repr=False)
    env_file_b64: str = field(repr=False)
    redactor: Redactor = field(repr=False)
    # An environment that has deployed before has a database worth keeping:
    # its pre-deploy dump must happen (dump.yml fails rather than skip it).
    dump_required: bool = False
    # Extra vars of the snapshot steps (restore, restore_dump, export).
    step_vars: dict = field(default_factory=dict, repr=False)
    # The restored snapshot's pepper and TOTP key: stored as the
    # environment's own once Restore snapshot succeeds.
    snapshot_keys: dict = field(default_factory=dict, repr=False)

    def vars_for(self, step_key: str) -> dict:
        if step_key == "render":
            return {**self.common, "env_file_b64": self.env_file_b64}
        if step_key == "dump":
            return {**self.common, "dump_required": self.dump_required}
        return {**self.common, **self.step_vars.get(step_key, {})}
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
    secrets = await _load_secrets(db, env.id, settings)
    rows = await db.scalars(select(EnvironmentService)
```

with:

```python
    secrets = await _load_secrets(db, env.id, settings)
    step_vars, snapshot_keys, extra_secrets = await _snapshot_vars(db, env, dep, settings,
                                                                   secrets)
    secrets = {**secrets, **snapshot_keys}
    rows = await db.scalars(select(EnvironmentService)
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
    redactor = Redactor(_redaction_values([*secrets.values(), env_b64, cfg.password,
                                           cfg.passphrase, cfg.sudo_password, private_key]))
    return _Context(target=target, common=common, env_file_b64=env_b64, redactor=redactor,
                    dump_required=env.current_sha is not None)
```

with:

```python
    redactor = Redactor(_redaction_values([*secrets.values(), env_b64, cfg.password,
                                           cfg.passphrase, cfg.sudo_password, private_key,
                                           *extra_secrets]))
    return _Context(target=target, common=common, env_file_b64=env_b64, redactor=redactor,
                    dump_required=env.current_sha is not None, step_vars=step_vars,
                    snapshot_keys=snapshot_keys)


async def _snapshot_vars(db: AsyncSession, env: Environment, dep: Deployment,
                         settings: Settings, secrets: dict[str, str]
                         ) -> tuple[dict, dict[str, str], list[str]]:
    """(per-step vars, the restored snapshot's keys, more values to redact)."""
    step_vars: dict[str, dict] = {}
    keys: dict[str, str] = {}
    extra: list[str] = []
    snap = await db.get(Snapshot, dep.snapshot_id) if dep.snapshot_id else None
    try:
        if restores(dep.mode, dep.snapshot_id):
            if snap is None or snap.status != "ready":
                raise PrepareError("The snapshot this deployment restores is gone. Start a "
                                   "new deployment.")
            keys = await asyncio.to_thread(snapshots.read_keys, settings, snap)
            step_vars["restore"] = {
                "bundle_path": str(snapshots.bundle_path(settings, snap)),
                "bundle_tool": snapshots.BUNDLE_TOOL,
                "snapshot_revision": snap.alembic_revision,
                "api_image": f"serversherpa-api:{envfile.image_tag(dep.sha)}"}
        if dep.mode == "snapshot":
            if snap is None or snap.status != "pending":
                raise PrepareError("This snapshot job's record is gone. Take the snapshot "
                                   "again.")
            await asyncio.to_thread(snapshots.ensure_dirs, settings)
            token = snapshots.encrypt_keys(settings, secrets)
            token_b64 = base64.b64encode(token).decode()
            extra += [token.decode(), token_b64]
            step_vars["export"] = {
                "snapshot_dest": str(snapshots.fetched_path(settings, snap.id)),
                "bundle_tool": snapshots.BUNDLE_TOOL, "keys_enc_b64": token_b64,
                "api_image": f"serversherpa-api:{env.image_tag}",
                "spaces_bucket": env.spaces_bucket}
    except snapshots.SnapshotError as e:
        raise PrepareError(e.reason) from None
    if dep.restore_dump:
        step_vars["restore_dump"] = {"dump_name": dep.restore_dump}
    return step_vars, keys, extra


async def _keep_snapshot_keys(db: AsyncSession, env_id: uuid.UUID, settings: Settings,
                              keys: dict[str, str]) -> None:
    """After a restore the environment runs on the snapshot's pepper and TOTP
    key: store them as its own, so later deploys render them."""
    for key, value in keys.items():
        row = await db.get(EnvironmentSecret, (env_id, key))
        if row is None:
            db.add(EnvironmentSecret(environment_id=env_id, key=key,
                                     value_enc=vault.encrypt(settings, value)))
        else:
            row.value_enc, row.updated_at = vault.encrypt(settings, value), _now()
```

In `sirdar/api/src/sirdar_api/deploy/pipeline.py`, replace:

```python
                    step.status, step.finished_at = "succeeded", _now()
                    if step.key == "dump":
                        dep.dump_path = result.data.get("dump_path") or None
                    await db.commit()
            current = None
            now = _now()
            dep.status, dep.finished_at = "succeeded", now
            env.current_sha, env.image_tag = dep.sha, envfile.image_tag(dep.sha)
            env.status, env.updated_at = "ready", now
            await db.commit()
```

with:

```python
                    step.status, step.finished_at = "succeeded", _now()
                    if step.key == "dump":
                        dep.dump_path = result.data.get("dump_path") or None
                    elif step.key == "restore":
                        await _keep_snapshot_keys(db, env.id, settings, ctx.snapshot_keys)
                    elif step.key == "export":
                        try:
                            stored = await asyncio.to_thread(snapshots.ingest_fetched,
                                                             settings, dep.snapshot_id)
                        except snapshots.SnapshotError as e:
                            reason = f"Step {step.number} ({step.name}) failed: {e.reason}"
                            await db.rollback()
                            await _close(deployment_id, env_id, current, step_status="failed",
                                         dep_status="failed", error=reason,
                                         failed_step=current, append_log=reason + "\n")
                            return
                        snapshots.mark_ready(await db.get(Snapshot, dep.snapshot_id), stored)
                    await db.commit()
            current = None
            now = _now()
            dep.status, dep.finished_at = "succeeded", now
            if dep.mode != "snapshot":
                env.current_sha, env.image_tag = dep.sha, envfile.image_tag(dep.sha)
                env.status, env.updated_at = "ready", now
            await db.commit()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_pipeline.py tests/test_deploy_pipeline_snapshots.py tests/test_deploy_playbooks.py`
Expected: all passed (`test_deploy_pipeline.py` 32, `test_deploy_pipeline_snapshots.py` 11, `test_deploy_playbooks.py` 40).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/pipeline.py tests/fake_runner.py tests/test_deploy_pipeline_snapshots.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/tests/fake_runner.py sirdar/api/tests/test_deploy_pipeline_snapshots.py
git commit -m "feat(sirdar): pipeline runs restore, restore backup, rollback and snapshot jobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Snapshot endpoints, seeded environments and Reset with a snapshot

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/serialize.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Modify: `sirdar/api/tests/test_deploy_environments_api.py` (`ENV_KEYS`), `sirdar/api/tests/test_deploy_deployments_api.py` (`plan_for` stand-in)
- Test: `sirdar/api/tests/test_deploy_snapshots_api.py`

**Interfaces:**
- Consumes: Task 3 (`receive_upload`, `begin_take`, `delete`, `ready_snapshot`, `snapshot_out`, `snapshot_ref`, `list_all`, `NOTES_LIMIT`, `SnapshotError`); Task 6 (`create_deployment(..., snapshot_id=, restore_dump=)`, `restores`).
- Produces: `serialize.rollback_available(dep) -> bool`; deployment JSON gains `snapshot`, `restore_dump`, `rollback_available`; environment JSON gains `seed_snapshot`; `environments.create_new(..., snapshot_id=None)` (EnvError `snapshot_not_found` / `snapshot_not_ready`); routes `GET /snapshots`, `POST /snapshots`, `POST /environments/{name}/snapshots`, `DELETE /snapshots/{id}`; `POST /environments` accepts `snapshot_id`; `POST /environments/{name}/deployments` accepts `snapshot_id` with `mode: "reset"` and restores the seed on a never-deployed environment's Update; retry of a snapshot-restoring deployment re-checks the snapshot. Helpers `_snapshot_http(e)`, `_pinned(db, cfg)`; `_launch(..., snapshot=None, restore_dump=None)` adds `snapshot` / `backup` to the audit `changes`. Shapes as in "API produced for 3b".

- [ ] **Step 1: Write the failing tests**

In `sirdar/api/tests/test_deploy_environments_api.py`, replace:

```python
            "log_level", "services", "secrets_set", "last_deployment", "created_at",
            "updated_at"}
```

with:

```python
            "log_level", "services", "secrets_set", "seed_snapshot", "last_deployment",
            "created_at", "updated_at"}
```

In `sirdar/api/tests/test_deploy_deployments_api.py`, replace:

```python
    monkeypatch.setattr(deploy_routes, "plan_for", lambda mode: steps.plan_for("reset"))
```

with:

```python
    monkeypatch.setattr(deploy_routes, "plan_for", lambda mode, **kw: steps.plan_for("reset"))
```

Create `sirdar/api/tests/test_deploy_snapshots_api.py`:

```python
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
    assert [s["key"] for s in first["steps"]] == [*BUILD, "data", "restore", "up"]
    assert first["snapshot"]["name"] == "dev-2026-10-04"
    await _finish(first)
    second = (await client.post(url, headers=h, json={})).json()
    assert [s["key"] for s in second["steps"]] == [*BUILD, "dump", "up"]
    assert second["snapshot"] is None
    await _finish(second)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_snapshots_api.py tests/test_deploy_environments_api.py`
Expected: FAIL — the snapshot routes answer 404/405, and the environment JSON has no `seed_snapshot`.

- [ ] **Step 3: Serialize and environments**

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, replace:

```python
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, User
from sirdar_api.deploy import envfile
from sirdar_api.deploy.environments import secret_keys_of, services_of
```

with:

```python
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, User
from sirdar_api.deploy import envfile, snapshots
from sirdar_api.deploy.environments import secret_keys_of, services_of
```

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, replace:

```python
async def deployment_summary(db: AsyncSession, dep: Deployment) -> dict:
    return {"id": str(dep.id), "mode": dep.mode, "git_ref": dep.git_ref, "sha": dep.sha,
            "status": dep.status, "start_step": dep.start_step,
            "retry_of": str(dep.retry_of) if dep.retry_of else None,
            "failed_step": dep.failed_step, "dump_path": dep.dump_path,
            "previous_sha": dep.previous_sha, "error": dep.error,
```

with:

```python
def rollback_available(dep: Deployment) -> bool:
    """A stopped Update with a pre-deploy dump and a commit to go back to
    (spec: Roll back after a failure in steps 6–11). The route also wants it
    to be the environment's latest deployment."""
    return (dep.mode == "update" and dep.status in ("failed", "cancelled", "interrupted")
            and bool(dep.dump_path) and bool(dep.previous_sha))


async def deployment_summary(db: AsyncSession, dep: Deployment) -> dict:
    return {"id": str(dep.id), "mode": dep.mode, "git_ref": dep.git_ref, "sha": dep.sha,
            "status": dep.status, "start_step": dep.start_step,
            "retry_of": str(dep.retry_of) if dep.retry_of else None,
            "failed_step": dep.failed_step, "dump_path": dep.dump_path,
            "snapshot": await snapshots.snapshot_ref(db, dep.snapshot_id),
            "restore_dump": dep.restore_dump, "rollback_available": rollback_available(dep),
            "previous_sha": dep.previous_sha, "error": dep.error,
```

In `sirdar/api/src/sirdar_api/deploy/serialize.py`, replace:

```python
        "secrets_set": {k: k in keys for k in envfile.OPTIONAL_SECRETS},
```

with:

```python
        "secrets_set": {k: k in keys for k in envfile.OPTIONAL_SECRETS},
        "seed_snapshot": await snapshots.snapshot_ref(db, env.seed_snapshot_id),
```

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
import ipaddress
import re
import shlex
from dataclasses import dataclass
```

with:

```python
import ipaddress
import re
import shlex
import uuid
from dataclasses import dataclass
```

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
from sirdar_api.db.models import Deployment, Environment, EnvironmentSecret, EnvironmentService
```

with:

```python
from sirdar_api.db.models import (
    Deployment,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    Snapshot,
)
```

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
                  image_tag: str | None, secrets: dict[str, str],
                  actor_id) -> Environment:
    env = Environment(name=name, type=type_, target_id=target_id, base_domain=domain,
                      git_ref=git_ref, current_sha=current_sha, image_tag=image_tag,
                      status=status, proxy_ip=proxy_ip, bind_ip=bind_ip,
                      keep_dumps=keep_dumps, spaces_bucket=spaces_bucket,
                      log_level=log_level, created_by=actor_id)
```

with:

```python
                  image_tag: str | None, secrets: dict[str, str],
                  actor_id, seed_snapshot_id: uuid.UUID | None = None) -> Environment:
    env = Environment(name=name, type=type_, target_id=target_id, base_domain=domain,
                      git_ref=git_ref, current_sha=current_sha, image_tag=image_tag,
                      status=status, proxy_ip=proxy_ip, bind_ip=bind_ip,
                      keep_dumps=keep_dumps, spaces_bucket=spaces_bucket,
                      log_level=log_level, created_by=actor_id,
                      seed_snapshot_id=seed_snapshot_id)
```

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
                     ports: dict[str, int] | None = None, actor_id=None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets."""
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
```

with:

```python
                     ports: dict[str, int] | None = None, actor_id=None,
                     snapshot_id: uuid.UUID | None = None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets. With a
    snapshot, its first deploy restores that snapshot (and its keys)."""
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
    if snapshot_id is not None:
        snap = await db.get(Snapshot, snapshot_id)
        if snap is None:
            raise EnvError("snapshot_not_found")
        if snap.status != "ready":
            raise EnvError("snapshot_not_ready")
```

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
        secrets=vault.generate_env_secrets(), actor_id=actor_id)
```

with:

```python
        secrets=vault.generate_env_secrets(), actor_id=actor_id, seed_snapshot_id=snapshot_id)
```

- [ ] **Step 4: Routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, SshKnownHost
```

with:

```python
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, Snapshot, SshKnownHost
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    pipeline,
    serialize,
    ssh,
    targets,
    vault,
)
```

with:

```python
    pipeline,
    serialize,
    snapshots,
    ssh,
    targets,
    vault,
)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
_ENV_STATUS = {"environment_exists": 409, "deploy_in_progress": 409,
               "secrets_key_missing": 400, "target_not_configured": 400}
```

with:

```python
_ENV_STATUS = {"environment_exists": 409, "deploy_in_progress": 409,
               "secrets_key_missing": 400, "target_not_configured": 400,
               "snapshot_not_found": 404, "snapshot_not_ready": 409}
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    bind_ip: str = Field(default="0.0.0.0", max_length=45)
    ports: dict[str, int] = Field(default_factory=dict)


class ServicePatch(BaseModel):
```

with:

```python
    bind_ip: str = Field(default="0.0.0.0", max_length=45)
    ports: dict[str, int] = Field(default_factory=dict)
    # mode "new" only: the first deploy restores this snapshot
    snapshot_id: uuid.UUID | None = None


class ServicePatch(BaseModel):
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    settings = get_settings()
    actor_id = actor.user.person_id
    report = None
    try:
        if body.mode == "new":
            env = await environments.create_new(
                db, settings, name=body.name, type_=body.type, target_id=body.target,
                git_ref=body.git_ref, base_domain=body.base_domain, proxy_ip=body.proxy_ip,
                bind_ip=body.bind_ip, ports=body.ports, actor_id=actor_id)
```

with:

```python
    settings = get_settings()
    actor_id = actor.user.person_id
    report = None
    if body.mode == "adopt" and body.snapshot_id is not None:
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    try:
        if body.mode == "new":
            env = await environments.create_new(
                db, settings, name=body.name, type_=body.type, target_id=body.target,
                git_ref=body.git_ref, base_domain=body.base_domain, proxy_ip=body.proxy_ip,
                bind_ip=body.bind_ip, ports=body.ports, actor_id=actor_id,
                snapshot_id=body.snapshot_id)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    if report is None:
        audit(db, actor_id=actor_id, action="deploy.environment_create",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes={"name": env.name, "type": env.type, "target": env.target_id,
                       "base_domain": env.base_domain, "git_ref": env.git_ref,
                       "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip})
```

with:

```python
    if report is None:
        changes = {"name": env.name, "type": env.type, "target": env.target_id,
                   "base_domain": env.base_domain, "git_ref": env.git_ref,
                   "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip}
        seed = await snapshots.snapshot_ref(db, env.seed_snapshot_id)
        if seed is not None:
            changes["seed_snapshot"] = seed["name"]
        audit(db, actor_id=actor_id, action="deploy.environment_create",
              entity_type="environment", entity_id=env.name, ip=client_ip(request),
              changes=changes)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
class DeploymentIn(BaseModel):
    mode: Literal["update", "reset"] = "update"
    git_ref: str | None = Field(default=None, max_length=200)
    # Reset only: must equal the environment's name exactly.
    confirm_name: str | None = Field(default=None, max_length=64)
```

with:

```python
class DeploymentIn(BaseModel):
    mode: Literal["update", "reset"] = "update"
    git_ref: str | None = Field(default=None, max_length=200)
    # Reset only: must equal the environment's name exactly.
    confirm_name: str | None = Field(default=None, max_length=64)
    # Reset only: restore this snapshot after the reset.
    snapshot_id: uuid.UUID | None = None
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    if mode == "reset" and not actor.access.can("deploy", "change"):
        raise _forbidden()
```

with:

```python
    if mode == "reset" and not actor.access.can("deploy", "change"):
        raise _forbidden()


def _snapshot_http(e: snapshots.SnapshotError) -> HTTPException:
    status = {"snapshot_not_found": 404, "snapshot_not_ready": 409, "snapshot_exists": 409,
              "snapshot_in_use": 409, "not_deployed": 409, "secrets_key_missing": 400,
              "snapshot_too_large": 413, "snapshots_dir_unwritable": 500}.get(e.code, 422)
    return HTTPException(status_code=status, detail={"code": e.code, **e.extra})
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
async def _launch(db, env: Environment, request: Request, actor: AuthContext, *, action: str,
                  mode: str, git_ref: str, sha: str, start_step: int = 1,
                  retry_of: uuid.UUID | None = None) -> dict:
    env_name = env.name           # read now: a lock conflict rolls the session back
    try:
        dep = await pipeline.create_deployment(db, env, mode=mode, git_ref=git_ref, sha=sha,
                                               actor_id=actor.user.person_id,
                                               start_step=start_step, retry_of=retry_of)
```

with:

```python
async def _launch(db, env: Environment, request: Request, actor: AuthContext, *, action: str,
                  mode: str, git_ref: str, sha: str, start_step: int = 1,
                  retry_of: uuid.UUID | None = None, snapshot: Snapshot | None = None,
                  restore_dump: str | None = None) -> dict:
    env_name = env.name           # read now: a lock conflict rolls the session back
    snapshot_id = snapshot.id if snapshot is not None else None
    snapshot_name = snapshot.name if snapshot is not None else None
    try:
        dep = await pipeline.create_deployment(db, env, mode=mode, git_ref=git_ref, sha=sha,
                                               actor_id=actor.user.person_id,
                                               start_step=start_step, retry_of=retry_of,
                                               snapshot_id=snapshot_id,
                                               restore_dump=restore_dump)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    if retry_of is not None:
        changes |= {"retry_of": str(retry_of), "from_step": start_step}
```

with:

```python
    if retry_of is not None:
        changes |= {"retry_of": str(retry_of), "from_step": start_step}
    if snapshot_name is not None:
        changes["snapshot"] = snapshot_name
    if restore_dump is not None:
        changes["backup"] = restore_dump
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
@router.post("/environments/{name}/deployments", status_code=201)
async def start_deployment(name: str, body: DeploymentIn, request: Request, db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    _require_mode(actor, body.mode)
    env = await _environment(db, name)
    if body.mode == "reset" and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = _deploy_target(env)
    ref = body.git_ref or env.git_ref
```

with:

```python
async def _pinned(db, cfg: SshTargetConfig) -> None:
    try:
        await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None


@router.post("/environments/{name}/deployments", status_code=201)
async def start_deployment(name: str, body: DeploymentIn, request: Request, db: DbSession,
                           actor: AuthContext = require_permission("deploy", "add")):
    _require_mode(actor, body.mode)
    env = await _environment(db, name)
    if body.mode == "reset" and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if body.snapshot_id is not None and body.mode != "reset":
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = _deploy_target(env)
    snapshot_id = body.snapshot_id
    if body.mode == "update" and env.current_sha is None:
        snapshot_id = env.seed_snapshot_id          # the first deploy restores the seed
    snapshot = None
    if snapshot_id is not None:
        try:
            snapshot = await snapshots.ready_snapshot(db, snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    ref = body.git_ref or env.git_ref
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode=body.mode, git_ref=ref, sha=sha)
```

with:

```python
    return await _launch(db, env, request, actor, action="deploy.deployment_start",
                         mode=body.mode, git_ref=ref, sha=sha, snapshot=snapshot)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    from_step = body.from_step or stopped
    if from_step not in [s.number for s in plan_for(dep.mode)] or from_step > stopped:
        raise HTTPException(status_code=422, detail={"code": "from_step_invalid"})
    cfg = _deploy_target(env)
    try:
        await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
    return await _launch(db, env, request, actor, action="deploy.deployment_retry",
                         mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         start_step=from_step, retry_of=dep.id)
```

with:

```python
    from_step = body.from_step or stopped
    plan = plan_for(dep.mode, restore=pipeline.restores(dep.mode, dep.snapshot_id))
    if from_step not in [s.number for s in plan] or from_step > stopped:
        raise HTTPException(status_code=422, detail={"code": "from_step_invalid"})
    snapshot = None
    if pipeline.restores(dep.mode, dep.snapshot_id):
        try:
            snapshot = await snapshots.ready_snapshot(db, dep.snapshot_id)
        except snapshots.SnapshotError as e:
            raise _snapshot_http(e) from None
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    return await _launch(db, env, request, actor, action="deploy.deployment_retry",
                         mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump)


# ---- snapshots -------------------------------------------------------------------

class TakeSnapshotIn(BaseModel):
    name: str = Field(max_length=64)
    notes: str = Field(default="", max_length=snapshots.NOTES_LIMIT)


@router.get("/snapshots")
async def list_snapshots(db: DbSession,
                         actor: AuthContext = require_permission("deploy", "view")):
    return {"snapshots": [await snapshots.snapshot_out(db, s)
                          for s in await snapshots.list_all(db)]}


@router.post("/snapshots", status_code=201)
async def upload_snapshot(request: Request, db: DbSession,
                          name: str = Query(max_length=64),
                          notes: str = Query(default="", max_length=snapshots.NOTES_LIMIT),
                          actor: AuthContext = require_permission("deploy", "add")):
    """The body is the bundle itself (application/gzip), streamed to disk."""
    raw_length = request.headers.get("content-length")
    length = int(raw_length) if raw_length and raw_length.isdecimal() else None
    try:
        snap = await snapshots.receive_upload(
            db, get_settings(), name=name, notes=notes, chunks=request.stream(),
            content_length=length, actor_id=actor.user.person_id)
    except snapshots.SnapshotError as e:
        await db.rollback()
        raise _snapshot_http(e) from None
    audit(db, actor_id=actor.user.person_id, action="deploy.snapshot_upload",
          entity_type="snapshot", entity_id=snap.name, ip=client_ip(request),
          changes={"name": snap.name, "source": snap.source,
                   "alembic_revision": snap.alembic_revision, "size_bytes": snap.size_bytes,
                   "checksum": snap.checksum})
    await db.commit()
    await db.refresh(snap)
    return await snapshots.snapshot_out(db, snap)


@router.post("/environments/{name}/snapshots", status_code=201)
async def take_snapshot(name: str, body: TakeSnapshotIn, request: Request, db: DbSession,
                        actor: AuthContext = require_permission("deploy", "add")):
    env = await _environment(db, name)
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    try:
        snap = await snapshots.begin_take(db, get_settings(), env, name=body.name,
                                          notes=body.notes, actor_id=actor.user.person_id)
    except snapshots.SnapshotError as e:
        await db.rollback()
        raise _snapshot_http(e) from None
    dep = await _launch(db, env, request, actor, action="deploy.snapshot_take",
                        mode="snapshot", git_ref=env.git_ref, sha=env.current_sha,
                        snapshot=snap)
    await db.refresh(snap)
    return {"snapshot": await snapshots.snapshot_out(db, snap), "deployment": dep}


@router.delete("/snapshots/{snapshot_id}", status_code=204)
async def delete_snapshot(snapshot_id: uuid.UUID, request: Request, db: DbSession,
                          actor: AuthContext = require_permission("deploy", "change")):
    snap = await db.get(Snapshot, snapshot_id)
    if snap is None:
        raise HTTPException(status_code=404, detail={"code": "snapshot_not_found"})
    name = snap.name
    try:
        bundle_file = await snapshots.delete(db, get_settings(), snap)
    except snapshots.SnapshotError as e:
        await db.rollback()
        raise _snapshot_http(e) from None
    audit(db, actor_id=actor.user.person_id, action="deploy.snapshot_delete",
          entity_type="snapshot", entity_id=name, ip=client_ip(request),
          changes={"name": name})
    await db.commit()
    if bundle_file is not None:              # only once the row is gone for good
        await asyncio.to_thread(bundle_file.unlink, True)
    return Response(status_code=204)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_snapshots_api.py tests/test_deploy_environments_api.py tests/test_deploy_deployments_api.py tests/test_dashboard_api.py`
Expected: all passed (`test_deploy_snapshots_api.py`: 7).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/serialize.py src/sirdar_api/deploy/environments.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_snapshots_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/serialize.py sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_snapshots_api.py sirdar/api/tests/test_deploy_environments_api.py sirdar/api/tests/test_deploy_deployments_api.py
git commit -m "feat(sirdar): snapshot endpoints (upload, take, list, delete), seeded environments, Reset with a snapshot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Backups, Restore backup, Roll back and the new retries

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py`
- Test: `sirdar/api/tests/test_deploy_restore_api.py`

**Interfaces:**
- Consumes: Task 7 (`_pinned`, `_launch(..., restore_dump=)`, `serialize.rollback_available`, the `ready` fixture and `_audits`/`_finish`/`START` in `test_deploy_snapshots_api.py`); `ssh.run_command`.
- Produces: `environments.BACKUP_RE` (`[0-9]{8}T[0-9]{6}Z\.dump`), `environments.backups_command(name) -> str` (`find <env-dir>/backups -maxdepth 1 -type f -name '*.dump' -printf '%f\t%s\t%T@\n' 2>/dev/null || true`), `async environments.list_backups(db, cfg, env) -> list[dict]`; routes `GET /environments/{name}/backups`, `POST /deployments/{id}/rollback`; `DeploymentIn.mode` adds `restore_dump` with `backup`; `GATED_MODES = ("reset", "restore_dump", "rollback")`, `RETRY_MODES = ("update", "reset", "restore_dump", "rollback")`.

- [ ] **Step 1: Write the failing test**

Create `sirdar/api/tests/test_deploy_restore_api.py`:

```python
"""Backups, Restore backup, Roll back and the retry rules of the new modes (phase 3)."""

import uuid

from sirdar_api.deploy import environments
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
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
from .test_deploy_deployments_api import OLD, _headers_without_change
from .test_deploy_snapshots_api import START, _audits, _finish, ready  # noqa: F401

BACKUP = "20261004T010203Z.dump"


async def test_rollback_needs_change(client, db, ready, leak_guard):
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.post(f"/api/deploy/deployments/{uuid.uuid4()}/rollback", headers=admin,
                             json={})
    assert resp.status_code == 403


async def test_backups_listing(client, db, ready, ssh_server, leak_guard):
    ssh_server.overrides[environments.backups_command("uat")] = (
        "20261003T120000Z.dump\t1048576\t1759492800.5\n"
        f"{BACKUP}\t2097152\t1759539723.0\n"
        "notes.txt\t10\t1759539723.0\n"
        "20261004T999999Z.dump.partial\t5\t1\n")
    h = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.get("/api/deploy/environments/uat/backups", headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"backups": [
        {"name": BACKUP, "size_bytes": 2097152, "modified_at": "2025-10-04T01:02:03+00:00"},
        {"name": "20261003T120000Z.dump", "size_bytes": 1048576,
         "modified_at": "2025-10-03T12:00:00.500000+00:00"}]}


async def test_backups_on_an_untrusted_host(client, db, deploy_env, ssh_server, snapshots_dir,
                                            leak_guard):
    _ssh_env(deploy_env, ssh_server)
    await make_environment(db)
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/environments/uat/backups", headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "host_key_unknown"


async def test_restore_a_backup(client, db, ready, fake_runner, leak_guard):
    adder = await _headers_without_change(client, db)
    body = {"mode": "restore_dump", "backup": BACKUP, "confirm_name": "uat"}
    resp = await client.post(START, headers=adder, json=body)
    assert resp.status_code == 403
    h = await auth_headers(client, db)
    for bad, code in (({**body, "confirm_name": "UAT"}, "confirm_name_mismatch"),
                      ({**body, "backup": "../.env"}, "backup_invalid"),
                      ({"mode": "restore_dump", "confirm_name": "uat"}, "backup_invalid"),
                      ({"mode": "update", "backup": BACKUP}, "backup_invalid")):
        resp = await client.post(START, headers=h, json=bad)
        assert (resp.status_code, resp.json()) == (422, {"detail": {"code": code}}), bad
    resp = await client.post(START, headers=h, json=body)
    assert resp.status_code == 201, resp.text
    dep = resp.json()
    assert (dep["mode"], dep["sha"], dep["restore_dump"]) == ("restore_dump", OLD, BACKUP)
    assert [s["key"] for s in dep["steps"]] == ["preflight", "data", "restore_dump", "up"]
    await _finish(dep)
    request = next(r for r in fake_runner.requests if r.step == "restore_dump")
    assert request.extravars["dump_name"] == BACKUP
    assert await _audits(db, "deploy.deployment_start") == [
        {"environment": "uat", "mode": "restore_dump", "git_ref": OLD, "sha": OLD,
         "backup": BACKUP}]


async def test_restore_needs_a_deployed_environment(client, db, ready, leak_guard):
    await make_environment(db, name="fresh")
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/fresh/deployments", headers=h,
                             json={"mode": "restore_dump", "backup": BACKUP,
                                   "confirm_name": "fresh"})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_deployed"}})


async def test_roll_back_a_failed_update(client, db, ready, fake_runner, leak_guard):
    fake_runner.results["dump"] = RunResult(
        status="successful", rc=0, data={"dump_path": f"/opt/serversherpa/uat/backups/{BACKUP}"})
    fake_runner.results["up"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    failed = (await client.post(START, headers=h, json={})).json()
    await _finish(failed)
    got = (await client.get(f"/api/deploy/deployments/{failed['id']}", headers=h)).json()
    assert (got["status"], got["failed_step"], got["rollback_available"]) == ("failed", 10, True)

    url = f"/api/deploy/deployments/{failed['id']}/rollback"
    resp = await client.post(url, headers=h, json={"confirm_name": "nope"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "confirm_name_mismatch"}})
    fake_runner.results.pop("up")
    resp = await client.post(url, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    back = resp.json()
    assert (back["mode"], back["sha"], back["git_ref"], back["restore_dump"]) == (
        "rollback", OLD, OLD, BACKUP)
    assert [s["key"] for s in back["steps"]] == ["preflight", "fetch", "render", "build",
                                                 "data", "restore_dump", "up"]
    await _finish(back)
    env = (await client.get("/api/deploy/environments/uat", headers=h)).json()
    assert (env["status"], env["current_sha"]) == ("ready", OLD)
    again = await client.post(url, headers=h, json={"confirm_name": "uat"})
    assert (again.status_code, again.json()) == (409, {"detail": {"code": "rollback_not_latest"}})
    assert await _audits(db, "deploy.deployment_rollback") == [
        {"environment": "uat", "mode": "rollback", "git_ref": OLD, "sha": OLD,
         "backup": BACKUP}]


async def test_no_rollback_without_a_dump(client, db, ready, fake_runner, leak_guard):
    fake_runner.results["build"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    failed = (await client.post(START, headers=h, json={})).json()
    await _finish(failed)
    got = (await client.get(f"/api/deploy/deployments/{failed['id']}", headers=h)).json()
    assert got["rollback_available"] is False
    resp = await client.post(f"/api/deploy/deployments/{failed['id']}/rollback", headers=h,
                             json={"confirm_name": "uat"})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "rollback_unavailable"}})


async def test_retry_rules_for_the_new_modes(client, db, ready, fake_runner, tmp_path,
                                             leak_guard):
    fake_runner.results["restore_dump"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    dep = (await client.post(START, headers=h, json={
        "mode": "restore_dump", "backup": BACKUP, "confirm_name": "uat"})).json()
    await _finish(dep)
    retry = f"/api/deploy/deployments/{dep['id']}/retry"
    resp = await client.post(retry, headers=h, json={})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "confirm_name_mismatch"}})
    fake_runner.results.pop("restore_dump")
    resp = await client.post(retry, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    again = resp.json()
    assert (again["start_step"], again["restore_dump"]) == (9, BACKUP)
    await _finish(again)

    resp = await client.post("/api/deploy/environments/uat/snapshots", headers=h,
                             json={"name": "never-arrives"})
    job = resp.json()["deployment"]
    await _finish(job)                         # no bundle arrives: the job fails
    resp = await client.post(f"/api/deploy/deployments/{job['id']}/retry", headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_retryable"}})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_restore_api.py`
Expected: FAIL — 8 failed, 1 error (`environments` has no `backups_command`; the backups and rollback routes don't exist; `restore_dump` isn't a mode).

- [ ] **Step 3: Backups over SSH**

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
_NO_ANSWER = "The target didn't answer in time."
```

with:

```python
_NO_ANSWER = "The target didn't answer in time."
# The names `ss-stack dump` gives pre-deploy dumps (UTC timestamps).
BACKUP_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z\.dump")
```

In `sirdar/api/src/sirdar_api/deploy/environments.py`, replace:

```python
    if changed:
        env.updated_at = _now()
    await db.flush()
    return changed
```

with:

```python
    if changed:
        env.updated_at = _now()
    await db.flush()
    return changed


# ---- backups (pre-deploy dumps on the target) -----------------------------------

def backups_command(name: str) -> str:
    folder = shlex.quote(envfile.env_dir(name) + "/backups")
    return (f"find {folder} -maxdepth 1 -type f -name '*.dump' "
            "-printf '%f\\t%s\\t%T@\\n' 2>/dev/null || true")


async def list_backups(db: AsyncSession, cfg: SshTargetConfig, env: Environment) -> list[dict]:
    """The environment's pre-deploy dumps, newest first: name, size, time.
    Lines that aren't `ss-stack dump` files are ignored."""
    result = await ssh.run_command(cfg, db, backups_command(env.name))
    if result.exit_status is None:
        raise ConnectFailed(_NO_ANSWER)
    rows: list[dict] = []
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not BACKUP_RE.fullmatch(parts[0]) or not parts[1].isdecimal():
            continue
        try:
            modified = datetime.fromtimestamp(float(parts[2]), UTC)
        except (ValueError, OverflowError):
            continue
        rows.append({"name": parts[0], "size_bytes": int(parts[1]), "modified_at": modified})
    return sorted(rows, key=lambda r: r["name"], reverse=True)
```

- [ ] **Step 4: Routes**

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
from datetime import datetime
from typing import Literal
```

with:

```python
from datetime import datetime
from pathlib import PurePosixPath
from typing import Literal
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
class DeploymentIn(BaseModel):
    mode: Literal["update", "reset"] = "update"
    git_ref: str | None = Field(default=None, max_length=200)
    # Reset only: must equal the environment's name exactly.
    confirm_name: str | None = Field(default=None, max_length=64)
    # Reset only: restore this snapshot after the reset.
    snapshot_id: uuid.UUID | None = None
```

with:

```python
class DeploymentIn(BaseModel):
    mode: Literal["update", "reset", "restore_dump"] = "update"
    git_ref: str | None = Field(default=None, max_length=200)
    # Reset and Restore backup: must equal the environment's name exactly.
    confirm_name: str | None = Field(default=None, max_length=64)
    # Reset only: restore this snapshot after the reset.
    snapshot_id: uuid.UUID | None = None
    # Restore backup only: a file name from GET /environments/{name}/backups.
    backup: str | None = Field(default=None, max_length=64)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
class RetryIn(BaseModel):
    from_step: int | None = Field(default=None, ge=1, le=99)
    confirm_name: str | None = Field(default=None, max_length=64)


def _forbidden() -> HTTPException:
    return HTTPException(status_code=403, detail={"code": "forbidden"})


def _require_mode(actor: AuthContext, mode: str) -> None:
    """Update needs deploy:add (the route's guard); Reset also needs change."""
    if mode == "reset" and not actor.access.can("deploy", "change"):
        raise _forbidden()
```

with:

```python
class RetryIn(BaseModel):
    from_step: int | None = Field(default=None, ge=1, le=99)
    confirm_name: str | None = Field(default=None, max_length=64)


class RollbackIn(BaseModel):
    confirm_name: str | None = Field(default=None, max_length=64)


# Modes that replace data: deploy:change and the environment's name typed back.
GATED_MODES = ("reset", "restore_dump", "rollback")
RETRY_MODES = ("update", "reset", "restore_dump", "rollback")


def _forbidden() -> HTTPException:
    return HTTPException(status_code=403, detail={"code": "forbidden"})


def _require_mode(actor: AuthContext, mode: str) -> None:
    """Update needs deploy:add (the route's guard); the modes that replace
    data also need change."""
    if mode in GATED_MODES and not actor.access.can("deploy", "change"):
        raise _forbidden()
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    if body.mode == "reset" and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if body.snapshot_id is not None and body.mode != "reset":
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = _deploy_target(env)
```

with:

```python
    if body.mode in GATED_MODES and body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    if body.snapshot_id is not None and body.mode != "reset":
        raise HTTPException(status_code=422, detail={"code": "snapshot_not_allowed"})
    if (body.backup is not None) != (body.mode == "restore_dump"):
        raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
    if await environments.is_deploying(db, env.id):
        raise HTTPException(status_code=409, detail={"code": "deploy_in_progress"})
    cfg = _deploy_target(env)
    if body.mode == "restore_dump":
        if not environments.BACKUP_RE.fullmatch(body.backup):
            raise HTTPException(status_code=422, detail={"code": "backup_invalid"})
        if env.current_sha is None:
            raise HTTPException(status_code=409, detail={"code": "not_deployed"})
        await _pinned(db, cfg)
        return await _launch(db, env, request, actor, action="deploy.deployment_start",
                             mode="restore_dump", git_ref=env.current_sha,
                             sha=env.current_sha, restore_dump=body.backup)
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
    if dep.status not in pipeline.RETRYABLE_STATUSES or dep.mode not in ("update", "reset"):
        raise HTTPException(status_code=409, detail={"code": "not_retryable"})
    env = await db.get(Environment, dep.environment_id)
    if dep.mode == "reset" and body.confirm_name != env.name:
```

with:

```python
    if dep.status not in pipeline.RETRYABLE_STATUSES or dep.mode not in RETRY_MODES:
        raise HTTPException(status_code=409, detail={"code": "not_retryable"})
    env = await db.get(Environment, dep.environment_id)
    if dep.mode in GATED_MODES and body.confirm_name != env.name:
```

In `sirdar/api/src/sirdar_api/api/routes/deploy.py`, replace:

```python
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump)
```

with:

```python
                         start_step=from_step, retry_of=dep.id, snapshot=snapshot,
                         restore_dump=dep.restore_dump)


@router.post("/deployments/{deployment_id}/rollback", status_code=201)
async def rollback_deployment(deployment_id: uuid.UUID, body: RollbackIn, request: Request,
                              db: DbSession,
                              actor: AuthContext = require_permission("deploy", "change")):
    """Spec: after a failed Update, deploy the previous commit again and put
    its pre-deploy dump back. Objects are not rolled back."""
    dep = await _deployment(db, deployment_id)
    if not serialize.rollback_available(dep):
        raise HTTPException(status_code=409, detail={"code": "rollback_unavailable"})
    env = await db.get(Environment, dep.environment_id)
    if body.confirm_name != env.name:
        raise HTTPException(status_code=422, detail={"code": "confirm_name_mismatch"})
    latest = await serialize.latest_deployment(db, env.id)
    if latest is None or latest.id != dep.id:
        raise HTTPException(status_code=409, detail={"code": "rollback_not_latest"})
    dump = PurePosixPath(dep.dump_path).name
    if not environments.BACKUP_RE.fullmatch(dump):
        raise HTTPException(status_code=409, detail={"code": "rollback_unavailable"})
    cfg = _deploy_target(env)
    await _pinned(db, cfg)
    return await _launch(db, env, request, actor, action="deploy.deployment_rollback",
                         mode="rollback", git_ref=dep.previous_sha, sha=dep.previous_sha,
                         restore_dump=dump)


@router.get("/environments/{name}/backups")
async def list_backups(name: str, db: DbSession,
                       actor: AuthContext = require_permission("deploy", "view")):
    """The environment's pre-deploy dumps, read over SSH (newest first)."""
    env = await _environment(db, name)
    cfg = targets.ssh_config_for(env.target_id, get_settings())
    if cfg is None:
        raise HTTPException(status_code=400, detail={"code": "target_not_configured"})
    try:
        rows = await environments.list_backups(db, cfg, env)
    except _SSH_ERRORS as e:
        raise _ssh_http(e) from None
    return {"backups": rows}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_deploy_restore_api.py tests/test_deploy_snapshots_api.py tests/test_deploy_deployments_api.py`
Expected: all passed (`test_deploy_restore_api.py`: 8).

- [ ] **Step 6: Lint and commit**

```bash
cd sirdar/api && .venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/environments.py src/sirdar_api/api/routes/deploy.py tests/test_deploy_restore_api.py
cd ../.. && git add sirdar/api/src/sirdar_api/deploy/environments.py sirdar/api/src/sirdar_api/api/routes/deploy.py sirdar/api/tests/test_deploy_restore_api.py
git commit -m "feat(sirdar): backups list, Restore backup, Roll back, retries of the data-replacing modes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The Mac seed script

**Files:**
- Create: `scripts/make-seed-snapshot.sh` (mode 755)
- Test: `sirdar/api/tests/test_seed_script.py`

**Interfaces:**
- Consumes: Task 1 CLI (`export-objects` with `SNAP_S3_SECRET`, `pack --keys-env`).
- Produces: `scripts/make-seed-snapshot.sh [--out FILE] [--source NAME] [--env-file FILE] [--pg-container NAME] [--s3-endpoint URL] [--python PATH]` (defaults: `./seed-<UTC>.tar.gz`, `mac-dev`, `<repo>/.env`, `serversherpa-dev-postgres-1`, `http://127.0.0.1:9000`, `<repo>/api/.venv/bin/python`). Reads `POSTGRES_USER`, `POSTGRES_DB`, `SS_SPACES_BUCKET`, `SS_SPACES_ACCESS_KEY`, `SS_SPACES_SECRET_KEY`, `SS_PASSWORD_PEPPER`, `SS_TOTP_ENCRYPTION_KEY` from the env file; writes a bundle (mode 600) whose keys are `keys.env`; prints the path, size, SHA-256, source, migration and object counts, never a secret.

- [ ] **Step 1: Write the failing test**

Create `sirdar/api/tests/test_seed_script.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_seed_script.py`
Expected: FAIL — `bash: …/scripts/make-seed-snapshot.sh: No such file or directory` (exit 127).

- [ ] **Step 3: Write the script**

Create `scripts/make-seed-snapshot.sh`:

```bash
#!/usr/bin/env bash
# make-seed-snapshot.sh — build a Sirdar snapshot bundle from the Mac dev
# stack (docker-compose.dev.yml): the dev Postgres, every object of the dev
# bucket and the repo .env's SS_PASSWORD_PEPPER and SS_TOTP_ENCRYPTION_KEY.
#
#   scripts/make-seed-snapshot.sh [--out FILE] [--source NAME] [--env-file FILE]
#       [--pg-container NAME] [--s3-endpoint URL] [--python PATH]
#
# Defaults: --out ./seed-<UTC time>.tar.gz, --source mac-dev, --env-file <repo>/.env,
# --pg-container serversherpa-dev-postgres-1, --s3-endpoint http://127.0.0.1:9000,
# --python <repo>/api/.venv/bin/python (it needs boto3).
#
# Upload the file on Sirdar's Deploy page (Snapshots, Upload), then delete it:
# until Sirdar encrypts them, its keys.env holds the two keys in plaintext.
set -euo pipefail
umask 077

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOOL="$REPO/sirdar/api/src/sirdar_api/deploy/bundle.py"
OUT="seed-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
SOURCE=mac-dev
ENV_FILE="$REPO/.env"
PG=serversherpa-dev-postgres-1
ENDPOINT=http://127.0.0.1:9000
PY="$REPO/api/.venv/bin/python"

die() { echo "make-seed-snapshot: $*" >&2; exit 1; }
usage() { sed -n '4,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  [[ $1 == -h || $1 == --help ]] && usage
  [[ $# -ge 2 ]] || usage
  case $1 in
    --out) OUT=$2 ;;
    --source) SOURCE=$2 ;;
    --env-file) ENV_FILE=$2 ;;
    --pg-container) PG=$2 ;;
    --s3-endpoint) ENDPOINT=$2 ;;
    --python) PY=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[[ -f $ENV_FILE ]] || die "no env file at $ENV_FILE (pass --env-file)"
[[ -x $PY ]] || die "no Python at $PY (pass --python)"
[[ ! -e $OUT ]] || die "$OUT already exists"

# One value from the env file: last assignment wins, surrounding quotes dropped.
get() {
  local v
  v=$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}
for key in POSTGRES_USER POSTGRES_DB SS_SPACES_BUCKET SS_SPACES_ACCESS_KEY \
           SS_SPACES_SECRET_KEY SS_PASSWORD_PEPPER SS_TOTP_ENCRYPTION_KEY; do
  [[ -n $(get "$key") ]] || die "$key isn't set in $ENV_FILE"
done
PGUSER=$(get POSTGRES_USER)
PGDB=$(get POSTGRES_DB)
BUCKET=$(get SS_SPACES_BUCKET)

work=$(mktemp -d "${TMPDIR:-/tmp}/seed-snapshot.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> Dumping $PGDB from $PG"
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" -Fc --no-owner --no-acl \
  > "$work/db.dump" </dev/null || die "pg_dump failed"
revision=$(docker exec "$PG" psql -U "$PGUSER" -d "$PGDB" -tAc \
  'SELECT version_num FROM alembic_version' </dev/null) || die "couldn't read the migration"
revision=${revision//[[:space:]]/}

echo "==> Exporting bucket $BUCKET from $ENDPOINT"
SNAP_S3_SECRET=$(get SS_SPACES_SECRET_KEY) "$PY" "$TOOL" export-objects \
  --out "$work/objects.tar" --endpoint "$ENDPOINT" --key-id "$(get SS_SPACES_ACCESS_KEY)" \
  --bucket "$BUCKET" > "$work/objects.json" || die "the object export failed"

printf 'SS_PASSWORD_PEPPER=%s\nSS_TOTP_ENCRYPTION_KEY=%s\n' \
  "$(get SS_PASSWORD_PEPPER)" "$(get SS_TOTP_ENCRYPTION_KEY)" > "$work/keys.env"

echo "==> Packing $OUT"
"$PY" "$TOOL" pack --out "$OUT" --source "$SOURCE" --revision "$revision" --bucket "$BUCKET" \
  --db "$work/db.dump" --objects "$work/objects.tar" --keys-env "$work/keys.env" \
  > "$work/manifest.json" || die "packing failed"

"$PY" - "$OUT" "$work/manifest.json" <<'PY'
import hashlib, json, os, sys
out, manifest = sys.argv[1], json.load(open(sys.argv[2]))
digest = hashlib.sha256()
with open(out, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        digest.update(chunk)
print(f"""
Snapshot bundle: {os.path.abspath(out)}
  size       {os.path.getsize(out):,} bytes
  sha256     {digest.hexdigest()}
  source     {manifest['source']}
  migration  {manifest['alembic_revision']}
  objects    {manifest['object_count']:,} ({manifest['object_bytes']:,} bytes) from {manifest['bucket']}

It holds the dev password pepper and TOTP key in plaintext until Sirdar takes
it. Upload it on Sirdar's Deploy page (Snapshots, Upload), then delete it.""")
PY
```

Then: `chmod 755 scripts/make-seed-snapshot.sh`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_seed_script.py && bash -n ../../scripts/make-seed-snapshot.sh && echo ok`
Expected: `4 passed`, then `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/make-seed-snapshot.sh sirdar/api/tests/test_seed_script.py
git commit -m "feat(scripts): make-seed-snapshot.sh — a Sirdar snapshot bundle from the Mac dev stack

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Image, compose, installer and docs

**Files:**
- Modify: `sirdar/Dockerfile`, `sirdar/docker-compose.yml`, `sirdar/.env.example`, `sirdar/.gitignore`, `sirdar/scripts/dev-env.sh`, `sirdar/install.sh` (`ensure_private_dir`, `ensure_snapshots_dir`, summary, `main`), `sirdar/README.md`
- Create: `sirdar/snapshots/.gitkeep`

**Interfaces:**
- Produces: an image with `SIRDAR_SNAPSHOTS_DIR=/app/snapshots` and `/app/snapshots` owned by uid 10001 (mode 700); compose mounts `./snapshots` there; the installer creates `<dir>/sirdar/snapshots` (uid 10001, 700) on every run; `dev-env.sh` writes `SIRDAR_SNAPSHOTS_DIR=$PWD/snapshots`.

- [ ] **Step 1: Packaging and installer**

In `sirdar/Dockerfile`, replace:

```dockerfile
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static \
    HOME=/home/sirdar SIRDAR_RUNNER_DIR=/app/runner
```

with:

```dockerfile
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static \
    HOME=/home/sirdar SIRDAR_RUNNER_DIR=/app/runner SIRDAR_SNAPSHOTS_DIR=/app/snapshots
```

In `sirdar/Dockerfile`, replace:

```dockerfile
# uid 10001 gets a home (ssh and Ansible keep small state under $HOME) and the
# runner folder (compose mounts sirdar/runner over it). The chown is explicit:
```

with:

```dockerfile
# uid 10001 gets a home (ssh and Ansible keep small state under $HOME), the
# runner folder and the snapshots folder (compose mounts sirdar/runner and
# sirdar/snapshots over them). The chown is explicit:
```

In `sirdar/Dockerfile`, replace:

```dockerfile
 && install -d -o sirdar -g sirdar -m 700 /app/runner
```

with:

```dockerfile
 && install -d -o sirdar -g sirdar -m 700 /app/runner /app/snapshots
```

In `sirdar/docker-compose.yml`, replace:

```yaml
      # Deploy runs: one private Ansible folder per step, deleted afterwards.
      SIRDAR_RUNNER_DIR: /app/runner
```

with:

```yaml
      # Deploy runs: one private Ansible folder per step, deleted afterwards.
      SIRDAR_RUNNER_DIR: /app/runner
      # Snapshot bundles (database, files and encrypted sign-in keys).
      SIRDAR_SNAPSHOTS_DIR: /app/snapshots
```

In `sirdar/docker-compose.yml`, replace:

```yaml
      - ./runner:/app/runner
```

with:

```yaml
      - ./runner:/app/runner
      # Snapshot bundles hold whole databases: owned by uid 10001, mode 700
      # (the installer sets that up). Back this folder up if you need them.
      - ./snapshots:/app/snapshots
```

In `sirdar/.env.example`, replace:

```text
# Where targets clone ServerSherpa from (an https:// git URL).
# SIRDAR_DEPLOY_REPO_URL=https://github.com/encondata/BaseCampV3.git
```

with:

```text
# Where targets clone ServerSherpa from (an https:// git URL).
# SIRDAR_DEPLOY_REPO_URL=https://github.com/encondata/BaseCampV3.git
# Largest snapshot upload accepted, in bytes (default 5 GiB). A reverse proxy
# in front must allow bodies this large too (Nginx Proxy Manager: the proxy
# host's Advanced tab, client_max_body_size 6g;).
# SIRDAR_SNAPSHOT_MAX_BYTES=5368709120
```

In `sirdar/.gitignore`, replace:

```text
runner/*
!runner/.gitkeep
```

with:

```text
runner/*
!runner/.gitkeep
snapshots/*
!snapshots/.gitkeep
```

In `sirdar/scripts/dev-env.sh`, replace:

```bash
SIRDAR_RUNNER_DIR=$PWD/runner
EOT
```

with:

```bash
SIRDAR_RUNNER_DIR=$PWD/runner
SIRDAR_SNAPSHOTS_DIR=$PWD/snapshots
EOT
```

In `sirdar/install.sh`, replace:

```bash
# Deploy steps run Ansible in <dir>/sirdar/runner (mounted at /app/runner):
# one private folder per run, holding that run's secrets until it ends. The
# folder must belong to the container user (uid 10001) and nobody else (700).
ensure_runner_dir() {  # ensure_runner_dir DIR
  local d="$1" ok=1
```

with:

```bash
# Deploy steps run Ansible in <dir>/sirdar/runner (mounted at /app/runner):
# one private folder per run, holding that run's secrets until it ends.
# Snapshot bundles live in <dir>/sirdar/snapshots (/app/snapshots): whole
# databases. Both must belong to the container user (uid 10001) and nobody
# else (700).
ensure_runner_dir() {  # ensure_runner_dir DIR
  ensure_private_dir "$1" "deployments will fail"
}
ensure_snapshots_dir() {  # ensure_snapshots_dir DIR
  ensure_private_dir "$1" "snapshots can't be uploaded or taken"
}
ensure_private_dir() {  # ensure_private_dir DIR WHAT-FAILS
  local d="$1" ok=1
```

In `sirdar/install.sh`, replace:

```bash
    warn "couldn't give $d to uid 10001, so deployments will fail until it is. Run: sudo chown 10001:10001 '$d' && sudo chmod 700 '$d'"
```

with:

```bash
    warn "couldn't give $d to uid 10001, so $2 until it is. Run: sudo chown 10001:10001 '$d' && sudo chmod 700 '$d'"
```

In `sirdar/install.sh`, replace:

```bash
  Deploy runs:  $DIR/sirdar/runner   (SIRDAR_SECRETS_KEY is in .env: back it up)
```

with:

```bash
  Deploy runs:  $DIR/sirdar/runner   (SIRDAR_SECRETS_KEY is in .env: back it up)
  Snapshots:    $DIR/sirdar/snapshots   (whole databases: keep them private)
```

In `sirdar/install.sh`, replace:

```bash
  ensure_runner_dir "$DIR/sirdar/runner"
```

with:

```bash
  ensure_runner_dir "$DIR/sirdar/runner"
  ensure_snapshots_dir "$DIR/sirdar/snapshots"
```

Create the empty file `sirdar/snapshots/.gitkeep`.

- [ ] **Step 2: README**

In `sirdar/README.md`, replace:

```markdown
**Steps.** 1 Preflight · 2 Bootstrap · 3 Fetch code · 4 Render config ·
5 Build images · 6 Pre-deploy dump (Update) · 7 Reset data (Reset) ·
8 Start services. The first failure stops the deployment; retry re-runs
from the failed step. One deployment per environment at a time. Reset
deletes the environment's data: it needs `deploy:change` and the
environment's name typed back (`confirm_name`).
```

with:

```markdown
**Steps.** 1 Preflight · 2 Bootstrap · 3 Fetch code · 4 Render config ·
5 Build images · 6 Pre-deploy dump (Update) · 7 Reset data (Reset) ·
8 Start data services · 9 Restore snapshot or Restore backup ·
10 Start services (migrate, then the app) · 11 Take snapshot (a job of its
own). The first failure stops the deployment; retry re-runs from the failed
step. One deployment per environment at a time. Reset, Restore backup and
Roll back replace data: they need `deploy:change` and the environment's name
typed back (`confirm_name`).
```

In `sirdar/README.md`, replace:

```markdown
| `POST /deployments/{id}/retry` | `deploy:add`; a Reset deployment also `deploy:change` |
```

with:

```markdown
| `POST /deployments/{id}/retry` | `deploy:add`; a Reset, Restore backup or Roll back deployment also `deploy:change` |
| `POST /environments` with `snapshot_id` (mode `new`) | `deploy:add` |
| `POST /environments/{name}/deployments` (`mode`: `restore_dump`, `backup`) | `deploy:add` and `deploy:change` |
| `GET /environments/{name}/backups` | `deploy:view` |
| `POST /deployments/{id}/rollback` | `deploy:change` |
| `GET /snapshots` | `deploy:view` |
| `POST /snapshots?name=…&notes=…` (body: the bundle) | `deploy:add` |
| `POST /environments/{name}/snapshots` (take one) | `deploy:add` |
| `DELETE /snapshots/{id}` | `deploy:change` |

**Snapshots.** A snapshot is one `.tar.gz`: `manifest.json`, `keys.enc` (the
source's `SS_PASSWORD_PEPPER` and `SS_TOTP_ENCRYPTION_KEY`, encrypted with
`SIRDAR_SECRETS_KEY`), `db.dump` (`pg_dump -Fc`) and `objects.tar` (every
object of the bucket, content types kept). Bundles live in
`sirdar/snapshots/` (mounted at `/app/snapshots`, owned by uid 10001, mode
700; the installer creates it) and are never served to browsers. Make one
from the Mac dev stack with `scripts/make-seed-snapshot.sh` and upload it on
the Deploy page, or take one from a deployed environment. A new environment
can start from a snapshot (its first deploy restores it) and Reset data can
restore one. Restoring replaces the environment's pepper and TOTP key with
the snapshot's, so its users sign in with their own passwords and 2FA, and
signs everyone out. A snapshot whose database is at a newer migration than
the commit being deployed is refused. Uploads are capped at
`SIRDAR_SNAPSHOT_MAX_BYTES` (default 5 GiB); a reverse proxy in front must
accept bodies that large too.

**Backups and rollback.** Each Update's pre-deploy dump stays in
`<env-dir>/backups` (the newest `keep_dumps`). Restore backup puts one back
into an empty database, then migrates and starts the app. Roll back (offered
after a failed Update) deploys the previous commit and restores that
Update's dump. Uploaded files are never rolled back.
```

- [ ] **Step 3: Verify the installer functions**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar
bash -n sirdar/install.sh && echo syntax-ok
tmp=$(mktemp -d)
SIRDAR_INSTALL_LIB=1 bash -c '. sirdar/install.sh; as_root() { echo "as_root $*"; }; ensure_snapshots_dir "$1/snapshots"; ensure_runner_dir "$1/runner"' _ "$tmp"
stat -f %Lp "$tmp/snapshots" 2>/dev/null || stat -c %a "$tmp/snapshots"
rm -rf "$tmp"
command -v shellcheck >/dev/null && shellcheck sirdar/install.sh && echo shellcheck-ok
```

Expected: `syntax-ok`; `as_root chown 10001:10001 <tmp>/snapshots`; `as_root chown 10001:10001 <tmp>/runner`; `700`; and `shellcheck-ok` when shellcheck is installed.

- [ ] **Step 4: Verify compose and the image**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar
SIRDAR_DB_PASSWORD=x docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env.example config | grep -E 'SIRDAR_SNAPSHOTS_DIR|target: /app/snapshots'
docker build -f sirdar/Dockerfile -t sirdar-phase3a .
docker run --rm --entrypoint sh sirdar-phase3a -c 'stat -c "%U %a" /app/snapshots; echo $SIRDAR_SNAPSHOTS_DIR; python -c "import sirdar_api.deploy.bundle as b, sirdar_api.deploy.steps as s; print(b.FORMAT, [x.playbook for x in s.STEPS][-4:])"; ls /usr/local/lib/python3.13/site-packages/sirdar_api/deploy/ansible'
docker image rm sirdar-phase3a
```

Expected: `SIRDAR_SNAPSHOTS_DIR: /app/snapshots` and `target: /app/snapshots`; the build succeeds; the run prints `sirdar 700`, `/app/snapshots`, `1 ['restore.yml', 'restore_dump.yml', 'up.yml', 'export.yml']` and lists the 12 playbooks (`bootstrap.yml build.yml data.yml dump.yml export.yml fetch.yml preflight.yml render.yml reset.yml restore.yml restore_dump.yml up.yml`).

- [ ] **Step 5: Commit**

```bash
git add sirdar/Dockerfile sirdar/docker-compose.yml sirdar/.env.example sirdar/.gitignore sirdar/scripts/dev-env.sh sirdar/install.sh sirdar/README.md sirdar/snapshots/.gitkeep
git commit -m "feat(sirdar): snapshots volume (image, compose, installer), settings and docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End to end — real SSH, real containers, the full suites

The controller runs this task (it builds Docker images and touches no remote host). Nothing here reaches the real uat VM; that is plan 3b's live verify.

**Files:**
- Test (opt-in): `sirdar/api/tests/test_snapshot_e2e.py`
- Runs: `deploy/tests/test_stack_e2e.py` (from Task 4)

**Interfaces:**
- Consumes: everything above; `test_runner_e2e.py`'s module fixture `target` and helpers `_exec`, `_pinned`, `USER`, `PASSWORD`, `ENV_DIR`.

- [ ] **Step 1: Write the real-SSH test**

Create `sirdar/api/tests/test_snapshot_e2e.py`:

```python
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
```

- [ ] **Step 2: Run it (Docker and sshpass needed)**

Run: `cd sirdar/api && SIRDAR_RUNNER_E2E=1 SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q tests/test_snapshot_e2e.py tests/test_runner_e2e.py`
Expected: `9 passed` (about a minute the first time; ansible-runner's `forkpty()` DeprecationWarnings are expected).

- [ ] **Step 3: Run the real-container round trip**

Run (from the worktree root; builds every image, takes several minutes, ports 18xxx/19xxx): `PY=/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python; SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -s`
Expected: every e2e test passes, `test_snapshot_commands_round_trip` last. Afterwards `docker ps -a --filter name=ss-e2e -q` and `docker volume ls -q --filter name=ss-e2e` print nothing.

- [ ] **Step 4: Full suites and lint**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/sirdar/api
SIRDAR_TEST_DB=sirdar_test_phase3a .venv/bin/pytest -q
.venv/bin/ruff check --select E,F,W --ignore F811 src/sirdar_api/deploy/bundle.py src/sirdar_api/deploy/snapshots.py src/sirdar_api/deploy/steps.py src/sirdar_api/deploy/pipeline.py src/sirdar_api/deploy/environments.py src/sirdar_api/deploy/serialize.py src/sirdar_api/api/routes/deploy.py src/sirdar_api/config.py src/sirdar_api/db/models.py migrations/versions/0005_snapshots.py tests/bundle_helpers.py tests/test_deploy_bundle.py tests/test_deploy_snapshots.py tests/test_deploy_pipeline_snapshots.py tests/test_deploy_snapshots_api.py tests/test_deploy_restore_api.py tests/test_seed_script.py tests/test_snapshot_e2e.py
cd ../.. && PY=/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python && $PY -m pytest -q -c deploy/pytest.ini deploy/tests
npm --prefix sirdar/web test
```

Expected: the API suite passes with only the opt-in e2e tests skipped (9 skipped); Ruff prints `All checks passed!`; the deploy suite prints `65 passed, 28 deselected`; the web suite still passes (3a changes no web code, but `testData.ts` there still shows step 8 — 3b Task 1 moves it).

- [ ] **Step 5: Clean up the test database**

```bash
docker exec serversherpa-dev-sirdar-db-1 psql -U sirdar -d postgres -c 'DROP DATABASE IF EXISTS sirdar_test_phase3a' -c 'DROP DATABASE IF EXISTS sirdar_test_phase3a_source'
docker exec serversherpa-dev-sirdar-db-1 psql -U sirdar -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'sirdar_test%'"
```

Expected: `DROP DATABASE` twice; the list shows only databases other sessions use (never `sirdar_test_phase3a*`). Drop any other `sirdar_test_*` database a subagent of this plan created.

- [ ] **Step 6: Record the outcome**

No commit unless a step above found a bug (then fix it in a TDD step on the owning task's files, re-run that task's tests and this task, and commit as `fix(sirdar): …`). Report the e2e results to Jimmy: what ran for real over SSH, what ran against real Postgres/SeaweedFS, and that the uat VM live verify (3b) is still to come.
