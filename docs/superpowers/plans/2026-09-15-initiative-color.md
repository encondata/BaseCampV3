# Initiative color — implementation plan

Design: `docs/superpowers/specs/2026-09-15-initiative-color-design.md`.
Branch `initiative-color`, worktree `.claude/worktrees/initiative-color`, off
`reports` @ 1bda022.

## Global constraints

- **API tests** (foreground, one run, 600000 ms timeout), from the worktree's
  `api/`:
  `SS_TEST_DB=serversherpa_test_icolor PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/initiative-color/api/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/<file> -q -x`
  The `PYTHONPATH` is mandatory: the venv's editable install points at the main
  checkout, so without it you are testing another branch's code.
- **Portal**, from the worktree's `portal/`: `npx vitest run <paths>` then
  `npx tsc -b`.
- TDD, red first. Show the failing output in the task report before the fix.
- Never weaken an existing assertion. Never `git add -A`. Never commit
  `api/src/serversherpa/_dev_reload.py` (`git checkout --` it if it shows
  modified). Never `git stash` — the stack is shared with other sessions.
- American English in all copy, comments and docs.
- Every commit ends with the trailer line exactly:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- The list-typography guardrail (`portal/src/styles/listTypography.test.ts`)
  forbids font-size / font-family / font-weight / line-height / min-height in a
  page stylesheet rule on a list-ish selector, and forbids inline `fontSize` and
  friends via the React `style` prop. New CSS uses `height`, colors and layout
  only, and reuses golden classes (`.chip`, `cell-top`, `mono`, `pf-form`) for
  text.

## Task 1 — API: column, palette, assignment, field

**Files:** `api/migrations/versions/0065_initiative_color.py` (new),
`api/src/serversherpa/db/models.py` (Initiative), `api/src/serversherpa/api/schemas.py`
(`InitiativeItem`, `InitiativeCreateIn`, `InitiativeUpdateIn`),
`api/src/serversherpa/api/routes/initiatives.py`; tests in
`api/tests/test_initiatives_api.py`.

- [ ] **Step 1: failing tests.**
  - `POST /initiatives` with no color → 201 and a color from the palette; twelve
    creates in a row yield twelve distinct colors; the thirteenth repeats one.
  - Archiving an initiative frees its color: archive the holder of palette[0],
    create again, get palette[0].
  - `POST` with an explicit `color` honors it (and normalizes `#ABC` → `#aabbcc`).
  - `PATCH` sets a new color; `PATCH` with `color: null` clears it.
  - Invalid color (`"red"`, `"#12"`, `"#gggggg"`) → 422 with `invalid_color` in
    `detail[0].msg`, on both create and update.
  - `GET /initiatives/next-color` → the color a create would assign, and it does
    not collide with an existing unarchived initiative while the palette has room.
  - `GET /initiatives` and `GET /initiatives/{id}` include `color`.
- [ ] **Step 2: implement.** Migration adds `color text` and backfills existing
  rows round-robin over `created_at` (deterministic; use the palette literal in
  the migration, do not import from the app — migrations must not move when the
  app does). `down_revision = "0063"`, and a comment in the migration explaining
  the 0064 situation from the design doc. Model gains `color: Mapped[str | None]`.
  `INITIATIVE_PALETTE` and `_next_color(db)` live in `routes/initiatives.py`
  next to the other helpers. `_normalize_color` is a `field_validator` shared by
  both schemas, shaped like `_normalize_website` in `schemas.py`.
  `GET /initiatives/next-color` is registered **before** `/{id}` and gated on
  `require_permission("initiatives", "add")` plus `_require_global`.
- [ ] **Step 3:** run `tests/test_initiatives_api.py` and
  `tests/test_initiatives_client_scope.py`; commit
  `feat(initiatives): each initiative carries its own color, auto-assigned unique on create`.

## Task 2 — Portal: the ColorWheel component

**Files:** `portal/src/components/ColorWheel.tsx` (new),
`portal/src/components/ColorWheel.test.tsx` (new),
`portal/src/styles/color-wheel.css` (new),
`portal/src/lib/variables.ts` (add `hexToHsl`/`hslToHex` only if not already
present — check first; `normalizeHex` already exists and must be reused).

- [ ] **Step 1: failing tests.** Round-trip `hexToHsl`/`hslToHex` for the twelve
  palette colors (within one unit per channel). The component: renders a
  `role="slider"` hue handle with `aria-valuenow`; ArrowRight moves the hue one
  degree and calls `onChange` with a new hex; the lightness range input changes
  the hex without changing the hue; typing a hex in the readout and blurring
  calls `onChange` with the normalized value; junk in the readout shows the
  invalid hint and does **not** call `onChange`.
- [ ] **Step 2: implement** per the design doc. Pointer geometry: angle from the
  ring center via `Math.atan2`, using the element's `getBoundingClientRect`;
  handle pointer, mouse and keyboard. Guard against a zero-size rect (jsdom
  reports 0×0) so tests can drive it by keyboard and by the hex field.
- [ ] **Step 3:** `npx vitest run src/components/ColorWheel src/styles/listTypography`
  and `npx tsc -b`; commit `feat(portal): ColorWheel — hue ring, lightness slider, hex readout`.

## Task 3 — Portal: wire the field into the edit modal

**Files:** `portal/src/lib/api.ts` (`InitiativeItem.color`, `getNextInitiativeColor`),
`portal/src/lib/initiatives.ts` (`InitiativeFormState.color`, `formFromInitiative`,
`initiativePayload`), `portal/src/components/initiatives/InitiativeEditModal.tsx`,
tests in `portal/src/lib/initiatives.test.ts` and a new/extended
`portal/src/components/initiatives/InitiativeEditModal.test.tsx`.

- [ ] **Step 1: failing tests.** `formFromInitiative(null)` has an empty color;
  `formFromInitiative(item)` takes the item's color; `initiativePayload` sends
  `color` on create, and on update sends it only when it changed (match the
  file's existing "send only what changed" contract — read it, do not assume).
  Modal: create mode requests the next color and opens the wheel on it; edit mode
  opens on the initiative's color; changing the wheel and saving sends the new
  color; a save failure surfaces the existing error shape.
- [ ] **Step 2: implement.** The field goes in the Identity section under Status,
  in the existing `.pf-form` grid, spanning the full row if the wheel needs it.
  Create mode shows the hint "Assigned automatically — spin the wheel to choose
  your own." If `getNextInitiativeColor` fails, fall back to the first palette
  color and do not block the modal.
- [ ] **Step 3:** `npx vitest run src/lib/initiatives src/components/initiatives`
  and `npx tsc -b`; commit `feat(portal): initiative edit modal picks the calendar color`.

## Task 4 — Portal: both timeline views color by initiative

**Files:** `portal/src/pages/InitiativeTimeline.tsx`,
`portal/src/pages/InitiativeTimeline.test.tsx`.

- [ ] **Step 1: failing tests.** A calendar span and a timeline bar for an
  initiative with `color: '#8b3fb8'` carry `--chip: #8b3fb8`; one with
  `color: null` falls back to its `status_color`. Cover the real-dates bar too.
- [ ] **Step 2: implement.** One `chipColor(i)` helper used by all three places.
- [ ] **Step 3:** `npx vitest run src/pages/InitiativeTimeline` and `npx tsc -b`;
  commit `feat(timeline): calendar and timeline bars take the initiative's color`.

## Task 5 — Verification and closeout

- [ ] Full API suite and full portal suite + build, in the worktree.
- [ ] Live verification against a **throwaway copy** of the dev database, never
  the shared one: `CREATE DATABASE serversherpa_icolor TEMPLATE serversherpa`
  (the dev DB is at 0064 from the sibling branch), then
  `UPDATE alembic_version SET version_num='0063'`, then `alembic upgrade head`
  from this worktree's `api/`. Run this branch's API on port 8001 against it and
  the portal on 5176 with `VITE_API_URL=http://localhost:8001`. Check: create an
  initiative and see a unique color pre-selected; change it on the wheel; both
  the calendar and the timeline repaint; two initiatives never share a color
  until the palette is exhausted.
- [ ] Append an "Outcome" section to the design doc; report what was and was not
  verified, and restate the 0065/0064 chain follow-up.
