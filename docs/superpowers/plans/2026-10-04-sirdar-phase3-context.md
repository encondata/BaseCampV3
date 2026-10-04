# Sirdar deploy phase 3 (snapshots) — context and decisions

Spec: `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md`
(Section 3 "Snapshots", Section 2 steps 6/7/9 and rollback, Section 4 Snapshots
tab / Backups tab / New environment Data step). Phase 2 is merged and live
(main b9df7c6d): read the phase 2a/2b plans and, above all, the real code.

## What exists now (phase 2)

- Environments, deployments, steps, encrypted per-env secrets
  (`deploy/vault.py`, `SIRDAR_SECRETS_KEY`), runner (`deploy/runner.py`,
  ansible-runner, unsafe-wrapped extravars, allowlisted env, private run dirs),
  pipeline (`deploy/pipeline.py`), steps + playbooks (`deploy/steps.py`,
  `deploy/ansible/*.yml`), routes (`api/routes/deploy.py`), web UI under
  `sirdar/web/src/pages/environments/*` and `pages/Deploy.tsx`.
- Step numbers: 1 preflight, 2 bootstrap, 3 fetch, 4 render, 5 build,
  6 pre-deploy dump (update; required once `current_sha` is set), 7 reset data
  (reset: `ss-stack down --volumes`), 8 start services (`ss-stack up` = db →
  storage → migrate → api → web → status).
- Each `deployments` row records the pre-deploy dump path (`dump_path`) and
  the SHA it deployed.
- Live: env `uat` on 10.10.48.63 adopted and deployed by Sirdar on Tower.

## Lessons from the hand-built uat seed (2026-10-03) — the procedure that worked

1. DB: `pg_dump -Fc --no-owner --no-acl` from the source Postgres.
2. Objects: list + download every object of the source bucket over the S3 API
   (boto3, path-style); 17,603 objects / 526 MB for dev.
3. Restore on the target:
   - stop api/web/status stacks (`docker compose … stop`), keep db+storage up;
   - `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then
     `pg_restore --exit-on-error --no-owner` (never `--clean`);
   - objects uploaded into the env's SeaweedFS bucket by a one-off container
     of the env's own api image on the env's Docker network
     (`docker run --rm --network ss-<env> … serversherpa-api:<tag> python …`),
     endpoint `http://seaweedfs:8333`, key id `serversherpa`, secret
     `SPACES_SECRET_KEY` from the env;
   - after restore: `DELETE FROM auth_sessions; DELETE FROM trusted_devices;`
     (copied sessions are meaningless);
   - the env's `SS_PASSWORD_PEPPER` + `SS_TOTP_ENCRYPTION_KEY` must be replaced
     with the snapshot's, or every password and 2FA breaks;
   - then migrate + start (`ss-stack up`).
4. Gotchas: `docker compose` inside `ssh … bash -s <<heredoc` eats the rest of
   the script from stdin (always `</dev/null`); macOS tar adds xattr headers
   (`COPYFILE_DISABLE=1`, harmless warnings on Linux); `/opt/serversherpa` is
   root-owned (only `<env>/` belongs to the SSH user); every DB storage key
   (attachments, wiki_page_assets, report_runs, people.avatar_key,
   clients.logo_key, label_fonts, import_jobs.file_key, db_backups) was
   present after the copy — a good verification query.

## Decisions (controller defaults; flag only if a reviewer finds them wrong)

- **Bundle**: a single `.tar.gz` (Python `tarfile`; no zstd dependency on
  targets or in the image — deliberate deviation from the spec's `.tar.zst`)
  containing `manifest.json` (format version, source, created, alembic
  revision, bucket, object count, total bytes, sha256 of each member),
  `db.dump` (pg_dump custom format), `objects.tar` (bucket objects, key =
  path), `keys.enc` (pepper + TOTP key, Fernet-encrypted with
  `SIRDAR_SECRETS_KEY`).
- **Storage**: Sirdar volume `./snapshots:/app/snapshots`
  (`SIRDAR_SNAPSHOTS_DIR`, owned 10001, mode 700), `snapshots` table rows
  (spec Section 3). Bundles are never served raw to browsers.
- **Upload**: streaming multipart upload to `POST /api/deploy/snapshots`
  (no full read into memory), size cap setting (default 5 GiB), checksum +
  manifest validation before the row is created; temp file then atomic move.
- **Mac script** `scripts/make-seed-snapshot.sh` (repo root `scripts/`) builds
  the same bundle from the local dev stack (dev Postgres container + MinIO /
  local S3 + root `.env` pepper/TOTP key). The keys.enc needs the Sirdar
  `SIRDAR_SECRETS_KEY` — so the script writes keys **unencrypted into a
  separate `keys.env` inside the bundle only when given `--plain-keys`**, and
  the upload endpoint encrypts them on arrival and rewrites the bundle; OR the
  script takes the Sirdar key via an env var. Planner: pick the safer one
  (prefer: upload endpoint accepts a bundle whose keys are in `keys.env`,
  encrypts them into `keys.enc` server-side, never stores plaintext keys).
- **Take snapshot from an environment**: a pipeline-style job (own record in
  `deployments` with mode `snapshot`, or a separate jobs table — planner
  decides) that runs a playbook on the target: pg_dump via the db stack,
  object export via a one-off api-image container on `ss-<env>`, builds the
  bundle in the env dir, fetches it to Sirdar (ansible `fetch` or SFTP),
  validates, records the row, deletes the remote temp file. Keys come from
  Sirdar's stored env secrets (already encrypted at rest).
- **ss-stack**: add a `data` command (start db + storage only, wait healthy;
  no migrate) so restore can run between storage start and migrate. Keep the
  existing contract; update `deploy/tests/test_ss_stack.py`.
- **Restore** (new step 9 "Restore snapshot", spec Section 2):
  - Reset mode with a snapshot, and the first deploy of an env created with a
    snapshot: steps 1–5, 7 (reset only), new "start data services"
    (`ss-stack data`), 9 restore, 8 start services (migrate + app).
  - Refuse a snapshot whose alembic revision is newer than the deployed
    code's head (read the head from the checked-out repo's
    `api/migrations/versions` on the target after fetch, numeric prefix).
  - Restore replaces the env's stored pepper + TOTP key with the snapshot's
    (vault rows updated, re-rendered `.env`) and clears sessions.
- **Backups tab**: list pre-deploy dumps on the target (`backups/*.dump`, name,
  size, time) and restore one (typed-name gate, `deploy:change`) as a
  deployment mode `restore_dump`: stop app stacks, drop schema, pg_restore,
  `ss-stack up`. Objects are NOT rolled back — say so in the UI.
- **Rollback** (spec: manual, after a failure in steps 6–8): deployment mode
  `rollback` = fetch previous succeeded SHA, render, build (cached), stop app,
  restore that failed deployment's pre-deploy dump, up. Offered only when the
  failed deployment has a `dump_path` and a previous succeeded/adopted SHA.
- **Snapshots tab** on `/deploy`: list (name, source, created, revision, size,
  notes), Upload, Take snapshot from environment, Delete (`deploy:change`).
  New environment Create gets the spec's **Data** step: "Empty" or a snapshot.
- **Permissions**: view = list; add = take/upload/create-with-snapshot;
  change = delete snapshot, Reset with snapshot, restore dump, rollback.
- **Out of scope**: scrubbing (deferred by Jimmy), snapshot download to
  browsers, cross-Sirdar sharing, object-storage rollback.

## Constraints carried from phase 2 (binding)

All phase 2 global constraints still apply: secrets never in responses / logs /
audit / exceptions; unsafe extravars; allowlisted runner env; pinned host keys;
American English; modal header pattern + content-sized modals; DataTable /
ComboBox / segmented idioms; `.pf-form .field-label` for non-label captions;
modal-body sections in a `.pf-form` grid need `grid-column: 1 / -1`; display
copy "Canceled"; web tests `// @vitest-environment jsdom`; API tests
`.venv/bin/pytest -q` from `sirdar/api` (real Postgres sirdar-db, truncate
list in conftest), never write the dev `sirdar` DB from tests; no
`npm install` in worktrees.
