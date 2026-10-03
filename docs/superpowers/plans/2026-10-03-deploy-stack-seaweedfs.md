# Deploy stack — swap MinIO for SeaweedFS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the storage stack's MinIO (whose community images can no longer be pulled anywhere) with SeaweedFS, so a fresh host can bring up a whole environment again.

**Architecture:** `deploy/stack/storage/compose.yml` runs `chrislusf/seaweedfs:4.48` in `weed mini` mode (master + volume + filer + S3 gateway in one process). It pre-creates the bucket with `-bucket=` and takes fixed S3 keys from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, so the `minio-init` job and its `ss-stack up` step go away. The API keeps the same `SS_SPACES_*` settings; only the secret's env name changes.

**Tech Stack:** Docker Compose, SeaweedFS 4.48, mailpit v1.31.4, bash, pytest.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` (Section 1, stack 2 "storage").

## Global Constraints

- Storage image: `chrislusf/seaweedfs:4.48` (pinned). Mailpit image: `axllent/mailpit:v1.31.4` (pinned; replaces `:latest`).
- Storage service name: `seaweedfs`. Command: `mini -dir=/data -bucket=${SS_SPACES_BUCKET:-serversherpa} -admin.ui=false`.
- S3 keys: access key id `serversherpa` (fixed, as today), secret from env key `SPACES_SECRET_KEY` (replaces `MINIO_ROOT_PASSWORD` everywhere). Passed to SeaweedFS as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`; to the API as `SS_SPACES_ACCESS_KEY` / `SS_SPACES_SECRET_KEY`.
- SeaweedFS S3 listens on container port 8333; published as `${STACK_BIND_IP:-0.0.0.0}:${STACK_SPACES_PORT:-9000}:8333`. No other SeaweedFS port is published (master 9333, filer 8888, volume, WebDAV, admin stay internal).
- Data volume: `seaweeddata:/data`.
- Healthcheck: `["CMD", "wget", "-qO-", "http://127.0.0.1:8333/healthz"]`.
- No storage init job; the only `jobs`-profile service left is `migrate`.
- `ss-stack up` order becomes: network → db → storage → `api run --rm migrate` → api → web → status.
- Verified on 2026-10-03 against seaweedfs 4.48: env-var admin identity works and wrong secrets get `SignatureDoesNotMatch`; `-bucket=` creates the bucket; presigned GET/PUT, 5 MB multipart and CORS preflight for `https://portal.uat.serversherpa.com` work; anonymous GET is 403; `/healthz` is 200; the image is Alpine with wget.
- American English. Scripts stay bash 3.2-compatible. Comment density matches the existing compose files.

## Working environment

Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/deploy-stack` (branch `deploy-stack`). `PY=/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python`. Fast suite: `$PY -m pytest -c deploy/pytest.ini deploy/tests -q`. E2E: `SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -q -s` (env `e2e`, ports 18xxx/19000; never touch Docker objects not named `ss-e2e*`). Run everything in the foreground.

---

### Task 1: SeaweedFS storage stack

**Files:**
- Modify: `deploy/stack/storage/compose.yml`
- Modify: `deploy/stack/api/compose.yml` (only `SS_SPACES_SECRET_KEY`)
- Modify: `deploy/stack/env.example` (`MINIO_ROOT_PASSWORD` → `SPACES_SECRET_KEY`, comment updated)
- Modify: `deploy/stack/ss-stack` (drop the `minio-init` step)
- Modify: `deploy/stack/README.md` (stack table, NPM `spaces` note, rollback warning wording: "object storage" not "MinIO")
- Modify: `deploy/tests/test_stack_config.py`, `deploy/tests/test_ss_stack.py`, `deploy/tests/test_stack_e2e.py`

**Interfaces:**
- Produces: storage stack services exactly `{seaweedfs, mailpit}`; env key `SPACES_SECRET_KEY`; `ss-stack up` call sequence without `run --rm minio-init`.

- [ ] **Step 1: Update the tests first**

In `deploy/tests/test_stack_config.py`:
- `test_default_published_ports`: expected map uses `"seaweedfs": [9000]` instead of `"minio": [9000]`.
- `test_one_shot_jobs_live_in_the_jobs_profile`: parametrize only `("api", "migrate")`.
- `test_env_example_secrets_are_placeholders`: `"SPACES_SECRET_KEY"` instead of `"MINIO_ROOT_PASSWORD"`.
- Add:

```python
def test_storage_runs_seaweedfs_and_mailpit_pinned() -> None:
    services = rendered("storage")["services"]
    assert set(services) == {"seaweedfs", "mailpit"}
    sw = services["seaweedfs"]
    assert sw["image"] == "chrislusf/seaweedfs:4.48"
    assert sw["command"] == ["mini", "-dir=/data", "-bucket=serversherpa", "-admin.ui=false"]
    assert sw["environment"]["AWS_ACCESS_KEY_ID"] == "serversherpa"
    assert [(p["target"], int(p["published"])) for p in sw["ports"]] == [(8333, 9000)]
    assert services["mailpit"]["image"] == "axllent/mailpit:v1.31.4"


def test_api_and_storage_share_the_spaces_secret() -> None:
    api_env = rendered("api")["services"]["api"]["environment"]
    sw_env = rendered("storage")["services"]["seaweedfs"]["environment"]
    assert api_env["SS_SPACES_ACCESS_KEY"] == sw_env["AWS_ACCESS_KEY_ID"] == "serversherpa"
    assert api_env["SS_SPACES_SECRET_KEY"] == sw_env["AWS_SECRET_ACCESS_KEY"] == "CHANGEME"
```

(`rendered()` renders `command` as a list; if Compose renders the string command differently, write the compose `command:` as a YAML list so the assertion holds — never loosen it.)

In `deploy/tests/test_ss_stack.py`, `test_up_starts_stacks_in_dependency_order`: remove the `dc(env_dir, "storage", "run --rm minio-init")` line from the expected sequence.

In `deploy/tests/test_stack_e2e.py`:
- the generated env line `MINIO_ROOT_PASSWORD=...` becomes `SPACES_SECRET_KEY=...`;
- `OWNERS["SPACES"]` becomes `("storage", "seaweedfs")`;
- the SPACES endpoint path becomes `/healthz`;
- add one e2e test proving the API's credentials work end to end:

```python
def test_spaces_accepts_the_stack_credentials(env_dir: Path) -> None:
    import boto3
    from botocore.config import Config
    secret = dict(l.split("=", 1) for l in (env_dir / ".env").read_text().splitlines()
                  if "=" in l)["SPACES_SECRET_KEY"]
    s3 = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{PORTS['SPACES']}",
                      region_name="us-east-1", aws_access_key_id="serversherpa",
                      aws_secret_access_key=secret,
                      config=Config(s3={"addressing_style": "path"}))
    s3.put_object(Bucket="serversherpa", Key="e2e/probe.txt", Body=b"ok")
    url = s3.generate_presigned_url("get_object", ExpiresIn=60,
                                    Params={"Bucket": "serversherpa", "Key": "e2e/probe.txt"})
    with urllib.request.urlopen(url, timeout=5) as resp:
        assert resp.read() == b"ok"
```

(add `import urllib.request` at the top if it isn't imported).

- [ ] **Step 2: Run the fast suite — expect failures**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests -q`
Expected: FAIL on the storage/ports/jobs/env/sequence tests (MinIO still in place).

- [ ] **Step 3: Rewrite `deploy/stack/storage/compose.yml`**

```yaml
# Object storage ("spaces") and the environment's mail catcher. SeaweedFS
# runs in `weed mini` mode — master, volume, filer and the S3 gateway in
# one process — creates the bucket itself (-bucket=) and takes fixed S3
# keys from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, so there is no init
# job. Only its S3 port is published (for NPM, spaces.<domain>). MinIO
# was dropped: its community images can no longer be pulled. Prod uses
# DigitalOcean Spaces through the same SS_SPACES_* settings.
# SMTP never leaves the box: the API sends to mailpit:1025 and testers
# read mail at the mailpit UI.
name: ss-${STACK_ENV:?set STACK_ENV}-storage

services:
  seaweedfs:
    image: chrislusf/seaweedfs:4.48
    command: ["mini", "-dir=/data", "-bucket=${SS_SPACES_BUCKET:-serversherpa}", "-admin.ui=false"]
    environment:
      AWS_ACCESS_KEY_ID: serversherpa
      AWS_SECRET_ACCESS_KEY: ${SPACES_SECRET_KEY:?set SPACES_SECRET_KEY}
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_SPACES_PORT:-9000}:8333"
    volumes:
      - seaweeddata:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8333/healthz"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped

  mailpit:
    image: axllent/mailpit:v1.31.4
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: "1"
      MP_SMTP_AUTH_ALLOW_INSECURE: "1"
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_MAILPIT_PORT:-8025}:8025"
    healthcheck:
      test: ["CMD", "/mailpit", "readyz"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  seaweeddata:

networks:
  default:
    name: ss-${STACK_ENV}
    external: true
```

- [ ] **Step 4: The rest of the swap**

- `deploy/stack/api/compose.yml`: `SS_SPACES_SECRET_KEY: ${SPACES_SECRET_KEY:?set SPACES_SECRET_KEY}`.
- `deploy/stack/env.example`: replace the `MINIO_ROOT_PASSWORD` block with

```dotenv
# hex; the S3 secret for the environment's SeaweedFS (key id: serversherpa)
SPACES_SECRET_KEY=CHANGEME
```

- `deploy/stack/ss-stack`: delete the `dc storage run --rm minio-init` line (and any comment that mentions minio-init).
- `deploy/stack/README.md`: stack table row → `| \`storage\` | seaweedfs, mailpit | 9000 (spaces), 8025 (mailpit UI) |`; the NPM `spaces` note → "(large uploads go straight to SeaweedFS)"; the rollback warning → "files in object storage (SeaweedFS) are not rolled back". Add one line under step 3 (Settings): an existing environment whose `.env` still has `MINIO_ROOT_PASSWORD` must rename it to `SPACES_SECRET_KEY`.
- `grep -rn -i minio deploy/` must return nothing afterwards except the explanatory "MinIO was dropped" comment in `storage/compose.yml`.

- [ ] **Step 5: Run the fast suite — expect green**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests -q`
Expected: PASS.

- [ ] **Step 6: Run the e2e**

Run: `SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -q -s`
Expected: PASS (12 tests), and afterwards `docker ps -a`, `docker volume ls`, `docker network ls` show nothing named `ss-e2e*`.

- [ ] **Step 7: Commit**

```bash
git add deploy
git commit -m "feat(deploy): SeaweedFS replaces MinIO in the storage stack; mailpit pinned"
```
