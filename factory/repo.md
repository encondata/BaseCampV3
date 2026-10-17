# Repo profile

Every factory agent reads this file first. It is the only repo knowledge the
agents share, so keep it short and true.

## What this repo is

ServerSherpa (BaseCamp V3): datacenter relocation tools, a monorepo.

| Piece | Stack | Tests |
|---|---|---|
| `api/` | Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic | pytest, real Postgres |
| `portal/` | React 18, Vite, TypeScript | vitest + `npm run build` |
| `kiosk/`, `wiki/`, `sirdar/web/` | React 18, Vite, TypeScript | vitest |
| `kiosk_laptop/`, `router_agent/`, `status/` | Python | pytest |
| `Android_Kiosk_App/`, `IOS_Kiosk_App/` | Kotlin/Compose, SwiftUI | gradle / xcodebuild |

Migrations live in `api/migrations/versions/NNNN_name.py`. Before adding one,
check every branch for the highest number: `git log --all --name-only --format= -- api/migrations/versions | sort -u | tail -3`.

## Job worktree setup (the builder does this once)

The orchestrator creates the worktree. Nothing heavy is committed, so link it in:

```bash
cd <worktree>
ln -s /Users/jrh1812/Developer/BaseCampV3/api/.venv api/.venv
ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules portal/node_modules
cp /Users/jrh1812/Developer/BaseCampV3/.env .env   # config reads <repo root>/.env
```

Remove the `.env` copy before your final commit; never commit links or `.env`.

## Test commands

Run everything in the FOREGROUND with a 600000 ms timeout. Never background a
test run and end your turn "waiting".

- API, targeted (from `<worktree>/api`):
  `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_factory_<NNN> DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest tests/test_<area>.py -q`
  `PYTHONPATH` is required, or you silently test the main checkout's code.
  The full API suite takes about an hour, so run the files that cover what you
  changed, not the whole suite.
- Portal (from `<worktree>/portal`): `npx vitest run src/<path>` for the
  changed areas, then `npx vitest run src/styles` (the guardrail tests), then
  `npm run build` (type-checks).

## Conventions

- American English everywhere: copy, comments, docs (color, customize).
- Commits: `feat(portal): …`, `fix(api): …`, `test(api): …`, `docs: …`.
  The subject says what the user gets, in plain words.
- Never commit `api/src/serversherpa/_dev_reload.py` (it churns when the dev API runs).
- Text sorting goes through natural sort (`portal/src/lib/naturalSort.ts`,
  `natural()` in SQL order_by); never `localeCompare` or a bare `.sort()`.
- Portal UI reuses existing idioms: ComboBox (never a native `<select>`),
  segmented controls, chips, `pf-form` fields, list column floors. New modals
  use the report-generate header and size to their content.
- Every route checks authorization on the server. Scope reads with the
  existing `visible_to` helpers; hidden records return 404, not 403.
- Tests that need a setting unset swap `serversherpa.config.Settings` for a
  `model_copy` factory; `monkeypatch.delenv` cannot beat the `.env` file.
- Do not invent policy numbers (password length, limits, timeouts). Reuse
  the portal's existing setting, or note the open question in `build.md`.
