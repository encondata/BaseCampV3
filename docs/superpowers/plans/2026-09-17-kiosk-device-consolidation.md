# Kiosk Device Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page for every scanning device that runs the kiosk app, with Zebra Android handhelds classified automatically from what the app already reports.

**Architecture:** The kiosk pairing endpoint gains a pure derivation function over `(mode, raw_info)` so a Zebra handheld is stored as `sub_type='zebra'` without any Android release. The Handheld Readers page — which has no producer and no rows — is removed, and its vocab row retired by a migration that converts any stragglers to kiosks first.

**Tech Stack:** FastAPI / SQLAlchemy 2 async / Alembic / pytest; React + TypeScript / Vitest.

## Global Constraints

- Branch `kiosk-consolidate`, off `main` @ `118926e`. Worktree: `.claude/worktrees/timeclock`. Run every command from the worktree root.
- **API tests:** `PYTHONPATH=api/src api/.venv/bin/python -m pytest ...` from the worktree root. Omitting PYTHONPATH tests the main checkout's source.
- **Only ONE pytest run against the test database at a time** — `pgrep -f "pytest api/tests"` first.
- **Do NOT run the full API suite per task** (~21 min). Targeted files only; the full suite runs ONCE, in Task 4.
- **Portal: run the WHOLE suite** (`npm --prefix portal test`, ~20s), never a single file, plus `npx --prefix portal tsc --noEmit -p portal/tsconfig.json`. Do NOT run `npm install`.
- Migration head is `0066`; this feature's migration is `0067` and is the only one it adds.
- American English in all copy and comments.
- Never commit `api/src/serversherpa/_dev_reload.py`.
- End commit messages with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Key facts established by exploration

- `api/src/serversherpa/api/routes/kiosk.py:211` (create) and `:223` (update) both set `sub_type` from `body.mode`. Both branches need the derivation.
- `api/src/serversherpa/api/schemas.py:190` — `mode: Literal["web", "laptop", "pi", "android", "ios"]`. **Unchanged by this work.**
- Live `raw_info` from a paired Android kiosk: `{"model": "Pixel 10 Pro XL", "manufacturer": "Google", "datawedge": "false", "android_version": "17", "sdk_int": "37"}`.
- `device_type` is FK'd to `status_values` where `record_type='device_type'`; rows are `router`, `fixed_reader`, `handheld_reader`, `kiosk`.
- `sub_type` has no CHECK constraint — free text.
- `_PATCH_FIELDS` in `routes/devices.py:105` already allows `sub_type`.
- Handheld Readers wiring: page `portal/src/pages/HandheldReaders.tsx`, route `App.tsx:180`, nav `navSections.tsx:465`, nav test `scanningHardwareNav.test.tsx:20`.
- `subTypeLabel` lives in `portal/src/lib/devices.ts` and currently maps `zebra: 'Zebra'`.

---

### Task 1: Derive the Zebra sub-type at pairing

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk.py`
- Test: `api/tests/test_kiosk_pairing_sub_type.py` (new)

**Interfaces produced:** `kiosk_sub_type(mode: str, raw_info: dict) -> str` in `routes/kiosk.py` — pure, no DB.

- [ ] **Step 1: Write the failing tests**

```python
"""Zebra Android handhelds are derived from what the app already reports,
not chosen by hand — a manual sub_type is overwritten on the next re-pair."""

import pytest
from serversherpa.api.routes.kiosk import kiosk_sub_type


@pytest.mark.parametrize("raw_info", [
    {"manufacturer": "Zebra Technologies", "datawedge": "false"},
    {"manufacturer": "zebra technologies"},          # case-insensitive
    {"manufacturer": "Google", "datawedge": "true"},  # DataWedge fallback
])
def test_android_on_zebra_hardware_becomes_zebra(raw_info):
    assert kiosk_sub_type("android", raw_info) == "zebra"


@pytest.mark.parametrize("raw_info", [
    {"manufacturer": "Google", "datawedge": "false"},
    {"manufacturer": "Samsung"},
    {},
])
def test_ordinary_android_stays_android(raw_info):
    assert kiosk_sub_type("android", raw_info) == "android"


@pytest.mark.parametrize("mode", ["web", "laptop", "pi", "ios"])
def test_other_modes_are_never_reclassified(mode):
    """Only android is refined. A laptop reporting a Zebra manufacturer
    string is still a laptop."""
    assert kiosk_sub_type(mode, {"manufacturer": "Zebra Technologies"}) == mode


def test_missing_or_malformed_raw_info_does_not_raise():
    assert kiosk_sub_type("android", {}) == "android"
    assert kiosk_sub_type("android", {"manufacturer": None}) == "android"
    assert kiosk_sub_type("android", {"datawedge": True}) == "zebra"   # bool, not str
```

Then an integration test in the existing kiosk pairing test file (find it first — look for the test covering `/kiosk/pair` or the self-register flow) proving both branches apply the derivation:

```python
async def test_pairing_stores_zebra_for_a_zebra_handheld(client, db, ...):
    body = {..., "mode": "android",
            "raw_info": {"manufacturer": "Zebra Technologies", "datawedge": "true"}}
    await client.post("/kiosk/pair", json=body, headers=...)
    device = await db.scalar(select(Device).where(Device.serial == body["serial"]))
    assert device.sub_type == "zebra"


async def test_re_pairing_re_derives_rather_than_reverting(client, db, ...):
    """The update branch must derive too — otherwise a Zebra device
    classified on first pair silently drops back to 'android'."""
    # pair once as Zebra, then pair again with the same serial
    ...
    assert device.sub_type == "zebra"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_kiosk_pairing_sub_type.py -v`
Expected: FAIL — `ImportError: cannot import name 'kiosk_sub_type'`.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/routes/kiosk.py`, above the pairing handler:

```python
def kiosk_sub_type(mode: str, raw_info: dict) -> str:
    """The stored `sub_type` for a pairing kiosk.

    Only `android` is refined: a Zebra handheld running the kiosk app is
    still an Android kiosk, but it is worth telling apart, and the app
    already sends the evidence — `manufacturer`, and `datawedge`, which is
    Zebra's own scanning middleware. Deriving it here rather than offering
    it as a manual choice is deliberate: pairing reassigns `sub_type` on
    every check-in, so a hand-set value would be reverted the next time the
    device connected. `manufacturer` is the primary signal; `datawedge` is a
    fallback in case that string varies across Zebra models."""
    if mode != "android":
        return mode
    manufacturer = str(raw_info.get("manufacturer") or "").lower()
    datawedge = str(raw_info.get("datawedge") or "").lower()
    if "zebra" in manufacturer or datawedge == "true":
        return "zebra"
    return "android"
```

Then use it in **both** branches of the pairing handler — the create at `:211-213` and the update at `:223` — replacing `sub_type=body.mode` / `device.sub_type = body.mode` with `kiosk_sub_type(body.mode, body.raw_info)`. Also update the `self_register` audit `changes` so it records the derived value rather than the raw mode.

- [ ] **Step 4: Verify**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_kiosk_pairing_sub_type.py api/tests/ -k kiosk -q`
Expected: PASS, no regressions in the existing kiosk suite.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/kiosk.py api/tests/test_kiosk_pairing_sub_type.py
git commit -m "feat(hardware): derive the Zebra Android sub-type at pairing

A Zebra handheld running the kiosk app already reports manufacturer and
datawedge, so the server refines mode=android into sub_type=zebra rather
than asking anyone to pick it. That is not a convenience: pairing
reassigns sub_type on every check-in, so a hand-set value would revert
on the next connection. Applied on both the create and update branches.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Six sub-types on the Kiosk Devices page

**Files:**
- Modify: `portal/src/lib/devices.ts`
- Modify: `portal/src/pages/KioskDevices.tsx`
- Test: `portal/src/pages/KioskDevices.test.tsx`, and the devices lib test if one exists

**Interfaces:** `subTypeLabel('zebra')` returns `Android (Zebra)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('labels a Zebra Android kiosk distinctly', () => {
  expect(subTypeLabel('zebra')).toBe('Android (Zebra)');
  expect(subTypeLabel('android')).toBe('Android');
});
```

```tsx
it('offers every kiosk sub-type the pairing endpoint can produce', async () => {
  renderPage();
  // open the edit modal for an existing kiosk, then:
  const options = screen.getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(
    expect.arrayContaining(['Web', 'Laptop', 'Pi', 'Android', 'Android (Zebra)', 'iOS']));
});
```

Match the file's existing render helper and modal-opening idiom — read it first.

- [ ] **Step 2: Run them to verify they fail, then implement**

In `portal/src/lib/devices.ts`, change the `zebra` entry of `SUB_TYPE_LABELS` from `'Zebra'` to `'Android (Zebra)'`.

In `portal/src/pages/KioskDevices.tsx:492`, replace the two-entry `typeOptions` with all six, ordered as Jimmy listed them:

```tsx
typeOptions={[
  { value: 'laptop', label: 'Laptop' },
  { value: 'pi', label: 'Pi' },
  { value: 'android', label: 'Android' },
  { value: 'zebra', label: 'Android (Zebra)' },
  { value: 'ios', label: 'iOS' },
  { value: 'web', label: 'Web' },
]}
```

Add a short comment noting that for a device that actually pairs, the pairing derivation wins on the next check-in — this dropdown is authoritative only for manually created rows.

- [ ] **Step 3: Verify**

Run: `npm --prefix portal test` (whole suite), `npx --prefix portal tsc --noEmit -p portal/tsconfig.json`
Expected: PASS and clean.

- [ ] **Step 4: Commit**

```bash
git add portal/src/lib/devices.ts portal/src/pages/KioskDevices.tsx portal/src/pages/KioskDevices.test.tsx
git commit -m "fix(hardware): the kiosk edit modal can represent its own data

It offered Laptop and Pi while the live kiosks were android and web, so
editing an Android kiosk showed a type it could not express. Now lists
all six sub-types the pairing endpoint can produce.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Remove the Handheld Readers page and retire its type

**Files:**
- Delete: `portal/src/pages/HandheldReaders.tsx` and its test file if one exists
- Modify: `portal/src/App.tsx`, `portal/src/layout/navSections.tsx`, `portal/src/layout/scanningHardwareNav.test.tsx`
- Create: `api/migrations/versions/0067_retire_handheld_reader_type.py`
- Test: `api/tests/test_devices_api.py` or a new migration test

- [ ] **Step 1: Write the failing test**

```python
async def test_the_handheld_reader_device_type_is_retired(db):
    keys = set((await db.execute(
        select(StatusValue.key).where(StatusValue.record_type == "device_type"))).scalars())
    assert keys == {"router", "fixed_reader", "kiosk"}


async def test_any_surviving_handheld_becomes_a_kiosk(db):
    """The migration converts before it deletes — device_type is FK'd to
    status_values, so removing the vocab row first would fail against a
    device still referencing it."""
    # insert a handheld_reader device, run the migration's convert step,
    # assert it is now a kiosk with its sub_type intact
```

Follow the migration-testing convention this repo already uses — `api/tests/test_container_zpl_templates.py` re-runs a migration's extracted function directly because `clean_db` truncates seeded tables. Read it and apply the same shape.

- [ ] **Step 2: Run it to verify it fails, then write the migration**

`api/migrations/versions/0067_retire_handheld_reader_type.py`, revision `0067`, revises `0066`:

```python
def upgrade() -> None:
    conn = op.get_bind()
    # Convert BEFORE deleting: devices.device_type is FK'd to status_values,
    # so removing the vocab row while a device still points at it fails.
    # sub_type is preserved as-is — a legacy 'zebra' handheld lands on a
    # label the kiosk page now has, and any other value survives rather than
    # failing the upgrade (sub_type has no CHECK constraint).
    conn.execute(sa.text("""
        UPDATE devices SET device_type = 'kiosk'
        WHERE device_type = 'handheld_reader'
    """))
    conn.execute(sa.text("""
        DELETE FROM status_values
        WHERE record_type = 'device_type' AND key = 'handheld_reader'
    """))
```

The downgrade restores the vocab row but **cannot** un-convert the devices — once they are kiosks there is no record of which were handhelds. Say that in the docstring rather than pretending it round-trips.

- [ ] **Step 3: Remove the page**

Delete `portal/src/pages/HandheldReaders.tsx` (and its test file). Remove the route block at `App.tsx:180`, the nav entry at `navSections.tsx:465`, and the `/hardware/handheld-readers` entry from `scanningHardwareNav.test.tsx:20`. Then `grep -rn "handheld" portal/src api/src` and confirm only incidental matches remain (for example the `DeviceEditModal` comment listing example device types — update it too).

- [ ] **Step 4: Apply and verify**

Run: `cd api && .venv/bin/alembic upgrade head && .venv/bin/alembic heads && cd ..` — expect a single head `0067`.
Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -k device -q`
Run: `npm --prefix portal test` and `npx --prefix portal tsc --noEmit -p portal/tsconfig.json` and `npm --prefix portal run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A ':!api/src/serversherpa/_dev_reload.py'
git commit -m "refactor(hardware): retire the handheld reader device type

Nothing ever created one — the only producer was the page's own New
handheld button, and there were no rows. Every handheld in the fleet
runs the kiosk app and pairs as a kiosk, so the distinction was
speculative. Migration converts any straggler to a kiosk before removing
the vocab row, since device_type is foreign-keyed to it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Full suite and live verification

Not a code task.

- [ ] **Step 1:** With `pgrep -f "pytest api/tests"` clear, run the whole API suite once: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -q`. Unrelated failures in sites/surveys/kiosk/import are the known concurrent-session signature — re-run those files in isolation before believing them.

- [ ] **Step 2:** On the running dev stack (portal 5173, API 8000), confirm Scanning Hardware no longer lists Handheld Readers, and that `/hardware/handheld-readers` no longer resolves.

- [ ] **Step 3:** Open a kiosk's edit modal and confirm all six sub-types are offered, with `Android (Zebra)` present and the current value correctly preselected for an `android` and a `web` kiosk.

- [ ] **Step 4:** Exercise the derivation against the real API: pair a kiosk with `mode=android` and `raw_info` carrying `manufacturer: "Zebra Technologies"`, and confirm the row stores `sub_type='zebra'` and the page shows `Android (Zebra)`. Re-pair the same serial and confirm it stays `zebra`. Clean up the row afterwards and report the final kiosk list.

- [ ] **Step 5:** Report findings with a screenshot of the edit modal's type list.
