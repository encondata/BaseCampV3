# Learn History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workers on the learn site see every document they've signed and can reopen any of them read-only at the signed version.

**Architecture:** One new read endpoint `GET /learn/history` built from the caller's signed assignments joined to their sign-offs, plus `signed_at` on the existing read endpoint. The learn web app gets a shared `HistoryList` component, a `/history` page, history inline on the caught-up screen, clickable signed rows, and a review mode in the Reader.

**Tech Stack:** FastAPI + SQLAlchemy async (api/), React + Vite + vitest (learn/web).

**Spec:** `docs/superpowers/specs/2026-10-29-learn-history-design.md`

## Global Constraints

- American English in all copy, comments and docs.
- Every new learn-site string goes in `learn/web/src/i18n/en.ts` AND gets a convenience translation in `ja.ts`, `ko.ts`, `he.ts` (`Dictionary` type requires every key).
- Every route acts on the caller's own assignments only (other people's rows never appear).
- Reuse existing learn styles (`learn-task`, `learn-banner`, `learn-cta`, `eyebrow`, `learn-note`, `learn-top`, `learn-backlink`); add CSS only if a new class is unavoidable, in `learn/web/src/styles/learn.css`.
- Run every test suite FOREGROUND in one continuous run with a long timeout (600000 ms). Never background a suite.
- API tests: `cd api && SS_TEST_DB=serversherpa_test_learn_history ../../../../api/.venv/bin/pytest …` (this worktree shares the main checkout's venv at `/Users/jrh1812/Developer/BaseCampV3/api/.venv`). Learn tests: `cd learn && npx vitest run`; build: `cd learn && npm run build`.
- Never commit `.env`, `api/src/serversherpa/_dev_reload.py`, or the `learn/node_modules` / `portal/node_modules` symlinks.

## Review Focus

- A sign-off on an older version, superseded by a newly assigned version: it must still be in history, open at the OLD version, and show "Updated since".
- A sign-off on a move that has ended (no longer on /training): must be in history and openable.
- Another person's sign-offs and the caller's open or cancelled assignments: never in history.
- Reader review mode must never show the agreement, signature, quiz button or read timers, even when the document has a quiz or a minimum read time.
- Back from the reader returns to `/history` when opened from there (router state), else `/training`.

---

### Task 1: History API and signed_at on read

**Files:**
- Modify: `api/src/serversherpa/learning/worker.py` (add `history()`; extend `read()`)
- Modify: `api/src/serversherpa/learning/schemas.py` (add `HistoryItemOut`; `AssignmentReadOut.signed_at`)
- Modify: `api/src/serversherpa/api/routes/learn/training.py` (add route)
- Test: `api/tests/test_learn_training.py` (append tests in a new `# ── history ──` section)

**Interfaces:**
- Produces: `GET /learn/history` → `list[HistoryItemOut]`, where
  `HistoryItemOut = {assignment_id: UUID, title: str, version_no: int, initiative: {id: UUID, name: str} | None, signed_at: datetime, language: str, newer_version: bool}`.
- Produces: `AssignmentReadOut.signed_at: datetime | None` (null unless the assignment's status is `signed`).
- Produces: `async def history(db: AsyncSession, person_id: uuid.UUID) -> list[dict]` in `learning/worker.py`.

- [ ] **Step 1: Write the failing tests** (sign through the real `POST /learn/assignments/{id}/sign` with `SIGN` so a `LearningSignoff` exists; helpers `_learner`, `_assign`, `_plain_doc`, `_initiative`, `_publish` already exist in the file / `test_learning_assign`):
  - `test_history_lists_own_signoffs_newest_first`: Wanda signs "Site safety" (general) then "Acme NDA" (on a move); she also has one open assignment; Otto signs "Site safety". `GET /learn/history` with Wanda's headers → 200, titles in order `["Acme NDA", "Site safety"]` (newest first), the move row's `initiative == {"id": str(move.id), "name": <move name>}`, the general row's `initiative is None`, each row has `version_no == 1`, `language == "en"`, `newer_version is False`, `signed_at` set, `assignment_id` equals the signed assignment's id. No Otto row, no open row. Without headers → 401.
  - `test_history_keeps_old_version_and_ended_moves`: a move that ended (end before `TODAY`); Wanda signs v1 of a doc on it, then `_publish` a v2 (new title "Site safety v2" if `_publish` allows a title, else same title) and add a new open assignment at v2. `/learn/training` no longer lists the ended move; `/learn/history` still has the v1 row with `version_no == 1`, the v1 title, and `newer_version is True`. Also exclude a cancelled signed assignment: set another signed assignment's status to `cancelled` → absent from history.
  - `test_read_signed_assignment_reports_signed_at`: before signing, `GET /learn/assignments/{id}` → `signed_at is None`; after signing → `signed_at` equals the sign response's `signed_at`, and after a v2 is published the read of the signed assignment still returns `version_no == 1`.

- [ ] **Step 2: Run them to verify they fail** — `pytest tests/test_learn_training.py -k "history or signed_at" -v` → FAIL (404 route / missing key).

- [ ] **Step 3: Implement.** `history()`: select the caller's `LearningAssignment` rows with `status == "signed"` joined to `LearningSignoff` on `LearningAssignment.signoff_id == LearningSignoff.id`, the signed `LearningDocumentVersion` (signoff.version_id) for `title`/`version_no`, the `LearningDocument` for `current_version_id` → compare the current version's `version_no` to the signed one for `newer_version` (no current version → False), and `Initiative` (outer) for `{id, name}`. `language` = the sign-off's language. Order `signed_at DESC`, then title casefold. Batch the lookups (no per-row queries), in the style of `training()`. `read()` adds `"signed_at": assignment.signed_at if assignment.status == "signed" else None`. Route: `@router.get("/history", response_model=list[HistoryItemOut])` with `CurrentLearner` + `DbSession`, like `my_training`. Update the module docstrings of worker.py's "my training" section / training.py only if they enumerate routes.

- [ ] **Step 4: Run** the new tests → PASS, then the whole learn API set: `pytest tests/test_learn_training.py tests/test_learn_auth.py tests/test_learning_completion.py -q` → all pass.

- [ ] **Step 5: Commit** — `feat(learn): history of my sign-offs and signed_at on read`.

---

### Task 2: Learn site history, review mode, clickable signed rows

**Files:**
- Modify: `learn/web/src/lib/training.ts` (types + `getHistory`)
- Create: `learn/web/src/components/HistoryList.tsx`
- Create: `learn/web/src/pages/History.tsx`, `learn/web/src/pages/History.test.tsx`
- Modify: `learn/web/src/pages/Training.tsx`, `Training.test.tsx`
- Modify: `learn/web/src/components/TaskRow.tsx`
- Modify: `learn/web/src/pages/Reader.tsx`, `Reader.test.tsx`
- Modify: `learn/web/src/App.tsx` (route `/history` inside `RequireLearner`, update the routes comment)
- Modify: `learn/web/src/i18n/en.ts`, `ja.ts`, `ko.ts`, `he.ts`

**Interfaces:**
- Consumes: Task 1's `GET /learn/history` and `signed_at` on read (shapes above).
- Produces: `export interface HistoryItem { assignment_id: string; title: string; version_no: number; initiative: { id: string; name: string } | null; signed_at: string; language: string; newer_version: boolean }`, `export const getHistory = () => call<HistoryItem[]>('/learn/history')`, `AssignmentRead.signed_at: string | null`.
- Produces: `export default function HistoryList({ items }: { items: HistoryItem[] })` — a `<ul className="learn-tasks">` of done-style rows, each a `Link` to `/training/${assignment_id}` with router `state={{ from: '/history' }}` only when rendered on the History page (prop `from?: string`, passed through as state when set).

English strings (exact):
- `'history.title': 'Completed training'`
- `'history.link': 'Completed training ({n})'`
- `'history.empty': 'Nothing signed yet.'`
- `'history.signed': 'Signed {date} · v{v}'`
- `'history.updated': 'Updated since'`
- `'reader.signedOn': 'You signed this on {date} (version {v}).'`
- `'reader.back': 'Back'`

Row text: title; sub line `history.signed` (date via `signedDay`), then ` · ` + scope (`initiative.name` or `t('training.general')`), then ` · ` + `history.updated` when `newer_version`.

- [ ] **Step 1: Write the failing tests** (mock `fetch` per URL, as the existing page tests do):
  - `History.test.tsx`: lists rows newest-first as returned with title, "Signed … · v1 · Acme DFW data center move", "General training" for a null initiative, "Updated since" on a `newer_version` row; each row links to `/training/<id>`; an empty array shows "Nothing signed yet."; the back link goes to `/training`.
  - `Training.test.tsx`: (a) no groups + history of 2 → shows "You're all caught up.", heading "Completed training" and both titles; (b) no groups + empty history → caught-up line only, no heading; (c) groups present + history of 3 → link "Completed training (3)" to `/history`, history titles not listed inline; (d) the signed "Dress code" row in GROUPS is now a link to `/training/a-1`. Existing Training tests keep passing (update their fetch mocks to answer `/learn/history` too).
  - `Reader.test.tsx`: a read with `signed_at: '2026-11-04T15:00:00Z'`, `version_no: 2`, `has_quiz: true`, `quiz_passed: false`, `min_read_seconds: 60` shows "You signed this on … (version 2)." and a "Back" control, and does NOT show the agree checkbox, "Sign and continue", or "Take the quiz". Opened with router state `{ from: '/history' }`, Back navigates to `/history`; without state, to `/training`. Existing reader tests get `signed_at: null` in their fixtures and keep passing.

- [ ] **Step 2: Run** `npx vitest run` in `learn/` → the new tests FAIL.

- [ ] **Step 3: Implement.** Training loads `getHistory` alongside `getTraining` (a failed history load just hides the history parts; the training list still shows). TaskRow: signed rows render as a `Link` like open rows (keep the check icon; show the chevron). Reader: when `doc.signed_at` is set, render the header, the `learn-banner` with `reader.signedOn` (date via `signedDay`), the document box, and a `learn-cta` "Back" that navigates to `location.state?.from === '/history' ? '/history' : '/training'`; the header back arrow uses the same target; skip the agreement/signature/quiz/read-gate block entirely. Add the `/history` route. Add the seven keys to en/ja/ko/he.

- [ ] **Step 4: Run** `npx vitest run` → all pass; `npm run build` → succeeds (tsc + vite).

- [ ] **Step 5: Commit** — `feat(learn): completed training history and read-only review of signed documents`.
