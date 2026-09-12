# Print Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/labels/print` placeholder with a V3 port of V2's Print Labels page: initiative → label type → Zebra printer over WebUSB → asset pick list → print, with the Print settings modal, the batch-print modal, and an IndexedDB offline label cache.

**Architecture:** One new API endpoint returns every generated label for an initiative + label type (the print payload and the offline-cache payload). The portal splits the work into pure, unit-tested modules (ZPL/settings/order helpers in `lib/printLabels.ts`, WebUSB transport over a device interface in `labels/zebraUsb.ts`, IndexedDB wrapper in `lib/labelCache.ts`), a `useZebraPrinter` hook, three content-sized modals with the roomy header, a selectable directory list, and the page that wires them. Spec: `docs/superpowers/specs/2026-09-12-print-labels-design.md` (read it first; the "What V2 does" section is the behavior contract).

**Tech Stack:** FastAPI + SQLAlchemy async (api/), React 18 + TypeScript + Vite + vitest/jsdom/testing-library (portal/), WebUSB (`navigator.usb`), IndexedDB (via `fake-indexeddb` in tests).

## Global Constraints

- Branch: work on `print-labels` in a worktree off `reports` (currently `reports` == `main` + the spec commit). Never switch the main checkout's branch.
- API tests: run from `api/` with the main checkout's venv, always in the FOREGROUND with a long timeout: `SS_TEST_DB=serversherpa_test_print_labels api/.venv/bin/python -m pytest tests/<file> -q -x` (conftest creates/migrates that DB). Never background a suite.
- Portal tests: from `portal/`: `npx vitest run <file>`; guardrail `npx vitest run src/styles/listTypography.test.ts`. Worktrees need `portal/node_modules` — symlink it from the main checkout (`ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules <worktree>/portal/node_modules`) and, when a task adds a dev dependency, run `npm install` in the MAIN checkout's `portal/` too (a worktree `npm install` replaces the symlink with a copy).
- American English in all copy, comments, and docs (color, customize, canceled…).
- Modals: `modal-scrim` > `modal-card reports-modal-card rgm-card <own-modifier>` with `modal-head` > `rgm-head-text` (eyebrow / h3 / page-hint) + `modal-close`; Escape closes only when `!e.defaultPrevented`; each modal has its own width rule and `overflow: visible; max-height: none` when it hosts a ComboBox.
- Lists: never a raw `<table>` outside `components/DataTable.tsx`; row text carries `cell-top`/`cell-sub`/`mono`/`chip`/`pn`/`cell-primary`; no inline `fontSize`/`fontFamily`/`fontWeight`/`lineHeight` styles; page CSS on list selectors is layout/color only (no font-*/line-height/min-height). Run the guardrail after every CSS/TSX task.
- ZPL transforms, ordering, batching, `~HS` polling, messages: exactly the V2 semantics quoted in the spec; the V2 source is `/Users/jrh1812/Developer/BaseCampV2-reference/portal-v2/src/pages/PrintLabels.jsx` (read-only reference).
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.

## File map

| File | Responsibility |
|---|---|
| `api/src/serversherpa/api/schemas.py` (modify) | `GeneratedLabelBundleItemOut`, `GeneratedLabelBundleOut` |
| `api/src/serversherpa/api/routes/labels.py` (modify) | `GET /labels/generated/bundle` |
| `api/tests/test_label_print_bundle_api.py` (create) | endpoint tests |
| `portal/src/lib/api.ts` (modify) | `GeneratedLabelBundle*` types, `getGeneratedLabelBundle` |
| `portal/src/lib/api.printLabels.test.ts` (create) | fetch-stub test |
| `portal/src/lib/printLabels.ts` (+ `.test.ts`) | settings, ZPL transforms, ordering, batching, label status |
| `portal/src/labels/zebraUsb.ts` (+ `.test.ts`) | WebUSB transport over `UsbDeviceLike` |
| `portal/src/lib/useZebraPrinter.ts` (+ `.test.tsx`) | React hook around the transport (hooks live in `lib/` here, e.g. `lib/useDeepLinkFilter.ts`) |
| `portal/src/lib/labelCache.ts` (+ `.test.ts`) | IndexedDB cache |
| `portal/src/components/labels/PrintSettingsModal.tsx` (+ test) | settings modal |
| `portal/src/components/labels/PrintBatchModal.tsx` (+ test) | batch progress modal (presentational) |
| `portal/src/components/labels/OfflineCacheModal.tsx` (+ test) | cache management modal |
| `portal/src/components/labels/PrintAssetList.tsx` (+ test) | selectable/sortable/filterable asset list |
| `portal/src/pages/PrintLabels.tsx` (+ test) | the page: state, fetch/cache fallback, print flow |
| `portal/src/styles/labels.css` (modify) | `plabels-*` layout rules |
| `portal/src/App.tsx` (modify) | route swap |

---

### Task 1: API — `GET /labels/generated/bundle`

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (after `GeneratedLabelOut`, ~line 2408)
- Modify: `api/src/serversherpa/api/routes/labels.py` (after `list_generated_labels`, ~line 875; add the two schema names to the `from serversherpa.api.schemas import (...)` block)
- Test: `api/tests/test_label_print_bundle_api.py`

**Interfaces:**
- Produces: `GET /labels/generated/bundle?initiative_id=<uuid>&label_type=<str>` → `{initiative_id, label_type, fetched_at, labels: [{id, entity_type, entity_id, template_id, template_name, template_version, language_key, size_key, dpi_key, stale, generated_at, code}]}`; 404 `{"code": "initiative_not_found"}` for unknown/archived/out-of-scope initiatives; 403 without `labels:view`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_label_print_bundle_api.py
"""Print Labels' data source: GET /labels/generated/bundle returns every
generated label for one initiative + label type in one response (no
paging) with the language/size/dpi keys the print page needs — the same
payload the page stores in its offline cache."""

from serversherpa.db.models import GeneratedLabel

from tests.test_label_generate_api import _asset_on, _initiative, _template
from tests.test_sites_api import login
from tests.test_status_values_write import _make


async def _label(db, ini, asset, tpl, *, label_type="top", code="^XA^XZ", stale=False,
                 language="zpl"):
    db.add(GeneratedLabel(entity_type="asset", entity_id=asset.id, initiative_id=ini.id,
                          label_type=label_type, template_id=tpl.id,
                          template_version=tpl.version, language_key=language,
                          dpi_key="203", size_key="4x2", code=code, stale=stale))
    await db.commit()


async def test_bundle_returns_every_label_for_the_pair(client, db, seeded_user):
    ini = await _initiative(db)
    other = await _initiative(db)
    a1 = await _asset_on(db, ini, legacy_id=5001, name="sw-1", serial="S1")
    a2 = await _asset_on(db, ini, legacy_id=5002, name="sw-2", serial="S2")
    tpl = await _template(db, "top")
    await _label(db, ini, a1, tpl, code="^XA1^XZ")
    await _label(db, ini, a2, tpl, code="^XA2^XZ", stale=True, language="escp")
    await _label(db, ini, a1, tpl, label_type="front", code="^XAF^XZ")
    await _label(db, other, a1, tpl, code="^XAO^XZ")
    hdrs = await login(client)

    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initiative_id"] == str(ini.id)
    assert body["label_type"] == "top"
    assert body["fetched_at"]
    by_entity = {row["entity_id"]: row for row in body["labels"]}
    assert set(by_entity) == {str(a1.id), str(a2.id)}
    row = by_entity[str(a1.id)]
    assert row["code"] == "^XA1^XZ"
    assert row["template_id"] == str(tpl.id)
    assert row["template_name"] == tpl.name
    assert row["template_version"] == tpl.version
    assert row["language_key"] == "zpl"
    assert row["size_key"] == "4x2" and row["dpi_key"] == "203"
    assert row["stale"] is False and row["entity_type"] == "asset"
    assert by_entity[str(a2.id)]["stale"] is True
    assert by_entity[str(a2.id)]["language_key"] == "escp"


async def test_bundle_empty_for_type_without_labels(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=rail", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["labels"] == []


async def test_bundle_404_for_archived_or_unknown_initiative(client, db, seeded_user):
    ini = await _initiative(db, archived=True)
    hdrs = await login(client)
    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"
    resp = await client.get(
        "/labels/generated/bundle?initiative_id=00000000-0000-0000-0000-000000000001&label_type=top",
        headers=hdrs)
    assert resp.status_code == 404


async def test_bundle_requires_labels_view(client, db, seeded_user):
    ini = await _initiative(db)
    worker = await _make(db, client, "worker", "w-bundle@test.example.com")
    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=worker)
    assert resp.status_code == 403
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `api/`): `SS_TEST_DB=serversherpa_test_print_labels .venv/bin/python -m pytest tests/test_label_print_bundle_api.py -q -x`
Expected: FAIL — the first test gets a 404/422 (route missing; FastAPI matches `/labels/generated/bundle` nowhere).

- [ ] **Step 3: Add the schemas**

In `api/src/serversherpa/api/schemas.py`, directly after `GeneratedLabelOut`:

```python
class GeneratedLabelBundleItemOut(BaseModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    template_id: uuid.UUID
    template_name: str
    template_version: int
    language_key: str
    size_key: str
    dpi_key: str
    stale: bool
    generated_at: datetime
    code: str


class GeneratedLabelBundleOut(BaseModel):
    """Every generated label for one initiative + label type — the Print
    Labels page's print payload and its offline-cache entry. Not paged:
    an initiative's labels are bounded by its roster."""
    initiative_id: uuid.UUID
    label_type: str
    fetched_at: datetime
    labels: list[GeneratedLabelBundleItemOut]
```

- [ ] **Step 4: Add the route**

In `api/src/serversherpa/api/routes/labels.py`, add `GeneratedLabelBundleItemOut, GeneratedLabelBundleOut,` to the schemas import (keep alphabetical after `GeneratedLabelOut`), then append after `list_generated_labels`:

```python
@router.get("/generated/bundle", response_model=GeneratedLabelBundleOut)
async def get_generated_label_bundle(
    db: DbSession, initiative_id: uuid.UUID, label_type: str,
    actor: AuthContext = require_permission("labels", "view"),
) -> GeneratedLabelBundleOut:
    """Print Labels' data source: every asset label of one type on one
    initiative, with the language/size/dpi keys the page needs to decide
    what a Zebra printer can take. Unknown/archived/out-of-scope
    initiatives read as 404 like the preview endpoint."""
    ini = await _scoped_initiative(db, actor, initiative_id)
    rows = (await db.execute(
        select(GeneratedLabel, LabelTemplate.name)
        .join(LabelTemplate, LabelTemplate.id == GeneratedLabel.template_id)
        .where(GeneratedLabel.initiative_id == ini.id,
               GeneratedLabel.entity_type == "asset",
               GeneratedLabel.label_type == label_type)
        .order_by(GeneratedLabel.generated_at, GeneratedLabel.id))).all()
    return GeneratedLabelBundleOut(
        initiative_id=ini.id, label_type=label_type, fetched_at=datetime.now(UTC),
        labels=[
            GeneratedLabelBundleItemOut(
                id=gl.id, entity_type=gl.entity_type, entity_id=gl.entity_id,
                template_id=gl.template_id, template_name=template_name,
                template_version=gl.template_version, language_key=gl.language_key,
                size_key=gl.size_key, dpi_key=gl.dpi_key, stale=gl.stale,
                generated_at=gl.generated_at, code=gl.code)
            for gl, template_name in rows])
```

`_scoped_initiative` already exists in this file (used by the preview/run routes) and raises the 404.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_print_labels .venv/bin/python -m pytest tests/test_label_print_bundle_api.py tests/test_label_generate_api.py -q`
Expected: all PASS (the bundle file's 4 tests plus the existing generate-API file untouched).

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/labels.py api/tests/test_label_print_bundle_api.py
git commit -m "feat(labels): GET /labels/generated/bundle — every generated label for an initiative + type (Print Labels payload)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Portal API client — `getGeneratedLabelBundle`

**Files:**
- Modify: `portal/src/lib/api.ts` (after `listGeneratedLabels`, ~line 3703)
- Test: `portal/src/lib/api.printLabels.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GeneratedLabelBundleItem {
    id: string; entity_type: 'asset' | 'container'; entity_id: string;
    template_id: string; template_name: string; template_version: number;
    language_key: string; size_key: string; dpi_key: string;
    stale: boolean; generated_at: string; code: string;
  }
  export interface GeneratedLabelBundle {
    initiative_id: string; label_type: string; fetched_at: string;
    labels: GeneratedLabelBundleItem[];
  }
  export async function getGeneratedLabelBundle(initiativeId: string, labelType: string): Promise<GeneratedLabelBundle>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// portal/src/lib/api.printLabels.test.ts
// @vitest-environment jsdom
/** `getGeneratedLabelBundle` — the Print Labels page's label source, proven
 *  with the same low-level fetch-stubbing idiom as api.generateLabels.test.ts. */
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError, getGeneratedLabelBundle, type GeneratedLabelBundle } from './api';

afterEach(() => vi.unstubAllGlobals());

const bundle: GeneratedLabelBundle = {
  initiative_id: 'i1', label_type: 'top', fetched_at: '2026-09-12T00:00:00Z',
  labels: [{
    id: 'g1', entity_type: 'asset', entity_id: 'a1', template_id: 't1', template_name: 'Top asset tag',
    template_version: 5, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false,
    generated_at: '2026-09-12T00:00:00Z', code: '^XA^XZ',
  }],
};

it('requests the bundle for the initiative + type and returns it', async () => {
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(bundle), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  const result = await getGeneratedLabelBundle('i1', 'top');

  expect(result).toEqual(bundle);
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/labels/generated/bundle'));
  expect(String(call?.[0])).toContain('/labels/generated/bundle?initiative_id=i1&label_type=top');
});

it('throws an ApiError on a non-OK response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ detail: { code: 'initiative_not_found' } }), { status: 404 })));
  await expect(getGeneratedLabelBundle('nope', 'top')).rejects.toBeInstanceOf(ApiError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `portal/`): `npx vitest run src/lib/api.printLabels.test.ts`
Expected: FAIL — `getGeneratedLabelBundle` is not exported.

- [ ] **Step 3: Implement**

Append after `listGeneratedLabels` in `portal/src/lib/api.ts`:

```ts
/** One row of a label bundle — `generated_labels` plus the template name,
 *  including the language/size/dpi keys the print page needs (a label
 *  compiled for a Brother printer must never be sent to a Zebra). */
export interface GeneratedLabelBundleItem {
  id: string; entity_type: 'asset' | 'container'; entity_id: string;
  template_id: string; template_name: string; template_version: number;
  language_key: string; size_key: string; dpi_key: string;
  stale: boolean; generated_at: string; code: string;
}

/** Every generated asset label of one type on one initiative — the Print
 *  Labels page's print payload and the unit its offline cache stores. */
export interface GeneratedLabelBundle {
  initiative_id: string; label_type: string; fetched_at: string;
  labels: GeneratedLabelBundleItem[];
}

export async function getGeneratedLabelBundle(
  initiativeId: string, labelType: string,
): Promise<GeneratedLabelBundle> {
  const qs = new URLSearchParams({ initiative_id: initiativeId, label_type: labelType });
  const resp = await apiFetch(`/labels/generated/bundle?${qs.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/api.printLabels.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/api.printLabels.test.ts
git commit -m "feat(portal): getGeneratedLabelBundle client for the Print Labels page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pure print helpers — `lib/printLabels.ts`

**Files:**
- Create: `portal/src/lib/printLabels.ts`
- Test: `portal/src/lib/printLabels.test.ts`

**Interfaces:**
- Consumes: `InitiativeAssetRow`, `GeneratedLabelBundle`, `GeneratedLabelBundleItem` from `./api`.
- Produces (exact exports, used by Tasks 7–11):
  ```ts
  export interface PrintSettings { verticalOffset: number; horizontalOffset: number; copies: number; batchSize: number; printByRack: boolean; blanksBetweenRacks: number }
  export const DEFAULT_PRINT_SETTINGS: PrintSettings
  export const PRINT_SETTINGS_STORAGE_KEY = 'labels.print.settings'
  export const LABEL_TYPE_CUSTOM = 'custom'
  export type NumericSetting = 'verticalOffset' | 'horizontalOffset' | 'copies' | 'batchSize' | 'blanksBetweenRacks'
  export const SETTING_LIMITS: Record<NumericSetting, { min: number; max: number }>
  export function clampSetting(field: NumericSetting, raw: unknown): number
  export function settingsModified(s: PrintSettings): boolean
  export function sanitizePrintSettings(raw: unknown): PrintSettings
  export function readPrintSettings(storage?: Pick<Storage, 'getItem'>): PrintSettings
  export function writePrintSettings(s: PrintSettings, storage?: Pick<Storage, 'setItem'>): void
  export function applyPrintSettings(zpl: string, s: PrintSettings, opts?: { singleCopy?: boolean }): string
  export function blankLabelsZpl(count: number): string
  export function alignmentTestZpl(widthDots: number, heightDots: number, sizeLabel: string, dpi: number): string
  export function printOrder(selectedIds: string[], displayedRows: InitiativeAssetRow[], s: PrintSettings): string[]
  export function batchBounds(batchNumber: number, batchSize: number, total: number): { start: number; end: number }
  export function batchCount(total: number, batchSize: number): number
  export type LabelStatus = 'ready' | 'stale' | 'missing' | 'unsupported'
  export function bundleByEntity(bundle: GeneratedLabelBundle | null): Map<string, GeneratedLabelBundleItem>
  export function labelStatusFor(assetId: string, byEntity: Map<string, GeneratedLabelBundleItem>): LabelStatus
  export function isPrintableStatus(s: LabelStatus): boolean
  export function missingLabelIds(selectedIds: string[], byEntity: Map<string, GeneratedLabelBundleItem>): string[]
  export function staleLabelCount(selectedIds: string[], byEntity: Map<string, GeneratedLabelBundleItem>): number
  export function rackOf(row: InitiativeAssetRow | undefined): string
  ```
  Note: `printOrder` takes the **asset ids** (`row.asset_id`, the asset UUID — the bundle keys labels by `entity_id` = asset id), not the join-row ids. Selection everywhere in this feature is by `row.asset_id`.

- [ ] **Step 1: Write the failing tests**

```ts
// portal/src/lib/printLabels.test.ts
/** Pure Print Labels helpers. The ZPL transform cases are lifted from V2's
 *  sendZplToPrinter so the port stays exact; V2 source:
 *  BaseCampV2-reference/portal-v2/src/pages/PrintLabels.jsx. */
import { describe, expect, it } from 'vitest';

import type { GeneratedLabelBundle, InitiativeAssetRow } from './api';
import {
  DEFAULT_PRINT_SETTINGS, alignmentTestZpl, applyPrintSettings, batchBounds, batchCount,
  blankLabelsZpl, bundleByEntity, clampSetting, labelStatusFor, missingLabelIds, printOrder,
  readPrintSettings, sanitizePrintSettings, settingsModified, staleLabelCount, writePrintSettings,
} from './printLabels';

const S = (over: Partial<typeof DEFAULT_PRINT_SETTINGS> = {}) => ({ ...DEFAULT_PRINT_SETTINGS, ...over });
const ZPL = '^XA\n^PW812\n^LL406\n^FO10,10^FDhi^FS\n^XZ';

describe('applyPrintSettings (V2 sendZplToPrinter transform)', () => {
  it('returns the label untouched at defaults', () => {
    expect(applyPrintSettings(ZPL, S())).toBe(ZPL);
  });
  it('negates a positive horizontal offset into ^LS and widens ^PW', () => {
    const out = applyPrintSettings(ZPL, S({ horizontalOffset: 20 }));
    expect(out).toContain('^XA\n^LS-20');
    expect(out).toContain('^PW832');
  });
  it('a negative horizontal offset becomes a positive ^LS and leaves ^PW alone', () => {
    const out = applyPrintSettings(ZPL, S({ horizontalOffset: -15 }));
    expect(out).toContain('^XA\n^LS15');
    expect(out).toContain('^PW812');
  });
  it('replaces an existing ^LS instead of inserting a second one', () => {
    const out = applyPrintSettings('^XA^LS5^FDx^FS^XZ', S({ horizontalOffset: 7 }));
    expect(out).toBe('^XA^LS-7^FDx^FS^XZ');
  });
  it('inserts ^LT for a vertical offset (+ moves down)', () => {
    expect(applyPrintSettings(ZPL, S({ verticalOffset: 30 }))).toContain('^XA\n^LT30');
    expect(applyPrintSettings(ZPL, S({ verticalOffset: -4 }))).toContain('^XA\n^LT-4');
  });
  it('adds ^PQ before ^XZ for copies > 1, unless singleCopy', () => {
    expect(applyPrintSettings(ZPL, S({ copies: 3 }))).toMatch(/\^PQ3\^XZ$/);
    expect(applyPrintSettings(ZPL, S({ copies: 3 }), { singleCopy: true })).toBe(ZPL);
    expect(applyPrintSettings(ZPL, S({ copies: 1 }))).toBe(ZPL);
  });
  it('combines every setting in V2 order (LT after LS, both after ^XA)', () => {
    const out = applyPrintSettings(ZPL, S({ horizontalOffset: 10, verticalOffset: 5, copies: 2 }));
    expect(out.startsWith('^XA\n^LT5\n^LS-10')).toBe(true);
    expect(out.endsWith('^PQ2^XZ')).toBe(true);
    expect(out).toContain('^PW822');
  });
});

describe('blank + alignment ZPL', () => {
  it('feeds N blanks with ^PQ inside the format', () => {
    expect(blankLabelsZpl(2)).toBe('^XA^FO10,10^A0N,10,10^FD ^FS^PQ2^XZ');
  });
  it('draws V2 concentric boxes 25 dots apart with the size text', () => {
    const zpl = alignmentTestZpl(600, 300, '2x1', 300);
    const lines = zpl.split('\n');
    expect(lines[0]).toBe('^XA');
    expect(lines[1]).toBe('^PW600');
    expect(lines[2]).toBe('^LL300');
    expect(lines[3]).toBe('^LH0,0');
    expect(lines[4]).toBe('^FO5,5^GB590,290,4^FS');
    expect(lines[5]).toBe('^FO30,30^GB540,240,2^FS');
    expect(lines[6]).toBe('^FO55,55^GB490,190,2^FS');
    expect(lines).toContain('^FO0,138^A0N,24,24^FB600,1,0,C,0^FDALIGN 2x1 300DPI^FS');
    expect(lines[lines.length - 1]).toBe('^XZ');
    // boxes stop once a side would drop below 50 dots
    expect(lines.filter((l) => l.includes('^GB')).length).toBe(6);
  });
});

describe('settings', () => {
  it('clamps per field', () => {
    expect(clampSetting('copies', 0)).toBe(1);
    expect(clampSetting('copies', 500)).toBe(99);
    expect(clampSetting('copies', 'x')).toBe(1);
    expect(clampSetting('batchSize', 9999)).toBe(500);
    expect(clampSetting('batchSize', '')).toBe(1);
    expect(clampSetting('blanksBetweenRacks', -3)).toBe(0);
    expect(clampSetting('blanksBetweenRacks', 99)).toBe(20);
    expect(clampSetting('verticalOffset', 12.7)).toBe(13);
    expect(clampSetting('horizontalOffset', 'junk')).toBe(0);
  });
  it('detects modification against defaults', () => {
    expect(settingsModified(S())).toBe(false);
    expect(settingsModified(S({ printByRack: true }))).toBe(true);
    expect(settingsModified(S({ blanksBetweenRacks: 2 }))).toBe(true);
  });
  it('sanitizes junk from storage and drops unknown keys', () => {
    expect(sanitizePrintSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(sanitizePrintSettings({ copies: '4', printByRack: 'yes', foo: 1 }))
      .toEqual(S({ copies: 4, printByRack: true }));
  });
  it('round-trips through a storage-like object', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    writePrintSettings(S({ batchSize: 25 }), storage);
    expect(readPrintSettings(storage)).toEqual(S({ batchSize: 25 }));
    store.set('labels.print.settings', '{not json');
    expect(readPrintSettings(storage)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(readPrintSettings({ getItem: () => { throw new Error('private mode'); } })).toEqual(DEFAULT_PRINT_SETTINGS);
  });
});

const row = (assetId: string, rack: string | null, ru: number | null): InitiativeAssetRow => ({
  id: `j-${assetId}`, asset_id: assetId, source_rack: rack, source_ru: ru,
} as unknown as InitiativeAssetRow);

describe('printOrder', () => {
  const rows = [row('a', 'R10', 5), row('b', 'R2', 40), row('c', 'R2', 42), row('d', null, null)];
  it('keeps display order of the selected rows by default', () => {
    expect(printOrder(['c', 'a', 'zzz'], rows, S())).toEqual(['a', 'c']);
  });
  it('sorts by rack (numeric-aware) then RU descending in rack mode', () => {
    expect(printOrder(['a', 'b', 'c', 'd'], rows, S({ printByRack: true }))).toEqual(['d', 'b', 'c', 'a'].sort((x, y) => {
      const rx = rows.find((r) => r.asset_id === x)!, ry = rows.find((r) => r.asset_id === y)!;
      const cmp = String(rx.source_rack ?? '').localeCompare(String(ry.source_rack ?? ''), undefined, { numeric: true });
      return cmp !== 0 ? cmp : (ry.source_ru ?? 0) - (rx.source_ru ?? 0);
    }));
    expect(printOrder(['b', 'c'], rows, S({ printByRack: true }))).toEqual(['c', 'b']);
  });
});

describe('batches', () => {
  it('computes bounds and counts', () => {
    expect(batchCount(120, 50)).toBe(3);
    expect(batchCount(50, 50)).toBe(1);
    expect(batchBounds(1, 50, 120)).toEqual({ start: 0, end: 50 });
    expect(batchBounds(3, 50, 120)).toEqual({ start: 100, end: 120 });
  });
});

describe('label status', () => {
  const bundle: GeneratedLabelBundle = {
    initiative_id: 'i', label_type: 'top', fetched_at: 'now',
    labels: [
      { id: '1', entity_type: 'asset', entity_id: 'a', template_id: 't', template_name: 'T', template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false, generated_at: 'now', code: '^XA^XZ' },
      { id: '2', entity_type: 'asset', entity_id: 'b', template_id: 't', template_name: 'T', template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: true, generated_at: 'now', code: '^XA^XZ' },
      { id: '3', entity_type: 'asset', entity_id: 'c', template_id: 't', template_name: 'T', template_version: 1, language_key: 'escp', size_key: '4x2', dpi_key: '203', stale: false, generated_at: 'now', code: 'ESC' },
    ],
  };
  const by = bundleByEntity(bundle);
  it('classifies ready / stale / unsupported / missing', () => {
    expect(labelStatusFor('a', by)).toBe('ready');
    expect(labelStatusFor('b', by)).toBe('stale');
    expect(labelStatusFor('c', by)).toBe('unsupported');
    expect(labelStatusFor('zzz', by)).toBe('missing');
    expect(bundleByEntity(null).size).toBe(0);
  });
  it('lists the selected ids that cannot print and counts stale ones', () => {
    expect(missingLabelIds(['a', 'b', 'c', 'x'], by)).toEqual(['c', 'x']);
    expect(staleLabelCount(['a', 'b', 'c'], by)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/printLabels.test.ts`
Expected: FAIL — module `./printLabels` not found.

- [ ] **Step 3: Implement**

```ts
// portal/src/lib/printLabels.ts
/**
 * Pure helpers for the Print Labels page — settings (with the per-browser
 * localStorage store), V2's exact ZPL transforms, print ordering, batch
 * arithmetic, and per-asset label status. No React, no fetching.
 * Behavior contract: docs/superpowers/specs/2026-09-12-print-labels-design.md.
 */
import type { GeneratedLabelBundle, GeneratedLabelBundleItem, InitiativeAssetRow } from './api';

export interface PrintSettings {
  verticalOffset: number;
  horizontalOffset: number;
  copies: number;
  batchSize: number;
  printByRack: boolean;
  blanksBetweenRacks: number;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  verticalOffset: 0, horizontalOffset: 0, copies: 1, batchSize: 50,
  printByRack: false, blanksBetweenRacks: 1,
};

export const PRINT_SETTINGS_STORAGE_KEY = 'labels.print.settings';

/** The synthetic label-type key for V2's "Custom" (raw ZPL) choice. */
export const LABEL_TYPE_CUSTOM = 'custom';

export type NumericSetting = 'verticalOffset' | 'horizontalOffset' | 'copies' | 'batchSize' | 'blanksBetweenRacks';

export const SETTING_LIMITS: Record<NumericSetting, { min: number; max: number }> = {
  verticalOffset: { min: -9999, max: 9999 },
  horizontalOffset: { min: -9999, max: 9999 },
  copies: { min: 1, max: 99 },
  batchSize: { min: 1, max: 500 },
  blanksBetweenRacks: { min: 0, max: 20 },
};

/** V2's handleSettingChange: copies/batch ≥ 1, blanks ≥ 0, offsets any
 *  integer (junk → the field's floor / 0); V3 adds the upper bounds V2
 *  only hinted at in the inputs' max attributes. */
export function clampSetting(field: NumericSetting, raw: unknown): number {
  const { min, max } = SETTING_LIMITS[field];
  const n = Math.round(Number(raw));
  const fallback = field === 'copies' || field === 'batchSize' ? 1 : 0;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function settingsModified(s: PrintSettings): boolean {
  return (Object.keys(DEFAULT_PRINT_SETTINGS) as (keyof PrintSettings)[])
    .some((k) => s[k] !== DEFAULT_PRINT_SETTINGS[k]);
}

export function sanitizePrintSettings(raw: unknown): PrintSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PRINT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const num = (k: NumericSetting) => (k in r ? clampSetting(k, r[k]) : DEFAULT_PRINT_SETTINGS[k]);
  return {
    verticalOffset: num('verticalOffset'),
    horizontalOffset: num('horizontalOffset'),
    copies: num('copies'),
    batchSize: num('batchSize'),
    printByRack: 'printByRack' in r ? Boolean(r.printByRack) : DEFAULT_PRINT_SETTINGS.printByRack,
    blanksBetweenRacks: num('blanksBetweenRacks'),
  };
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPrintSettings(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): PrintSettings {
  try {
    const raw = storage?.getItem(PRINT_SETTINGS_STORAGE_KEY);
    return sanitizePrintSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PRINT_SETTINGS };
  }
}

export function writePrintSettings(s: PrintSettings, storage: Pick<Storage, 'setItem'> | null = defaultStorage()): void {
  try {
    storage?.setItem(PRINT_SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just don't persist */
  }
}

/** V2's sendZplToPrinter transform, verbatim: ^LS is a shift-LEFT value so
 *  the horizontal offset is negated (positive setting = move right), and a
 *  rightward shift widens ^PW so the layout isn't clipped; ^LT for the
 *  vertical offset; ^PQ copies before ^XZ unless `singleCopy` (blanks and
 *  the alignment test never multiply). */
export function applyPrintSettings(
  zpl: string, s: PrintSettings, { singleCopy = false }: { singleCopy?: boolean } = {},
): string {
  let out = zpl;
  if (s.horizontalOffset !== 0) {
    const lsValue = -s.horizontalOffset;
    if (/\^LS-?\d+/i.test(out)) out = out.replace(/\^LS-?\d+/i, `^LS${lsValue}`);
    else out = out.replace(/\^XA/i, `^XA\n^LS${lsValue}`);
    if (s.horizontalOffset > 0) {
      out = out.replace(/\^PW(\d+)/i, (_m, w: string) => `^PW${parseInt(w, 10) + s.horizontalOffset}`);
    }
  }
  if (s.verticalOffset !== 0) {
    out = out.replace(/\^XA/i, `^XA\n^LT${s.verticalOffset}`);
  }
  if (!singleCopy && s.copies > 1) {
    out = out.replace(/\^XZ/i, `^PQ${s.copies}^XZ`);
  }
  return out;
}

/** V2's rack-separator format — ^PQ rides inside so the copies setting
 *  can't multiply the blanks (callers send it with singleCopy). */
export function blankLabelsZpl(count: number): string {
  return `^XA^FO10,10^A0N,10,10^FD ^FS^PQ${count}^XZ`;
}

/** V2's generateAlignmentTestZpl: an outer box 5 dots in at 4-dot
 *  thickness marking the label edge, then 2-dot boxes every 25 dots
 *  inward while both sides stay ≥ 50 dots, and the size/dpi caption
 *  centered on the label. */
export function alignmentTestZpl(widthDots: number, heightDots: number, sizeLabel: string, dpi: number): string {
  const lines = ['^XA', `^PW${widthDots}`, `^LL${heightDots}`, '^LH0,0'];
  const outerInset = 5;
  lines.push(`^FO${outerInset},${outerInset}^GB${widthDots - 2 * outerInset},${heightDots - 2 * outerInset},4^FS`);
  for (let inset = outerInset + 25; widthDots - 2 * inset >= 50 && heightDots - 2 * inset >= 50; inset += 25) {
    lines.push(`^FO${inset},${inset}^GB${widthDots - 2 * inset},${heightDots - 2 * inset},2^FS`);
  }
  lines.push(`^FO0,${Math.round(heightDots / 2) - 12}^A0N,24,24^FB${widthDots},1,0,C,0^FDALIGN ${sizeLabel} ${dpi}DPI^FS`);
  lines.push('^XZ');
  return lines.join('\n');
}

export function rackOf(row: InitiativeAssetRow | undefined): string {
  return row?.source_rack ?? '';
}

/** Print order: the selected assets in the list's displayed order, or —
 *  with Print by rack — rack ascending (numeric-aware) then RU top-down
 *  (largest first). Ids are asset ids (`row.asset_id`). */
export function printOrder(selectedIds: string[], displayedRows: InitiativeAssetRow[], s: PrintSettings): string[] {
  const selected = new Set(selectedIds);
  const ordered = displayedRows.filter((r) => selected.has(r.asset_id));
  if (!s.printByRack) return ordered.map((r) => r.asset_id);
  return [...ordered].sort((a, b) => {
    const rackCmp = rackOf(a).localeCompare(rackOf(b), undefined, { numeric: true });
    if (rackCmp !== 0) return rackCmp;
    return (b.source_ru ?? 0) - (a.source_ru ?? 0);
  }).map((r) => r.asset_id);
}

export function batchCount(total: number, batchSize: number): number {
  return Math.ceil(total / Math.max(1, batchSize));
}

export function batchBounds(batchNumber: number, batchSize: number, total: number): { start: number; end: number } {
  const start = (batchNumber - 1) * batchSize;
  return { start, end: Math.min(start + batchSize, total) };
}

export type LabelStatus = 'ready' | 'stale' | 'missing' | 'unsupported';

export function bundleByEntity(bundle: GeneratedLabelBundle | null): Map<string, GeneratedLabelBundleItem> {
  const map = new Map<string, GeneratedLabelBundleItem>();
  for (const item of bundle?.labels ?? []) map.set(item.entity_id, item);
  return map;
}

/** Only ZPL can go to a Zebra; a label compiled for another language is
 *  `unsupported` (blocks the print like a missing one). Stale labels still
 *  have code, so they print. */
export function labelStatusFor(assetId: string, byEntity: Map<string, GeneratedLabelBundleItem>): LabelStatus {
  const item = byEntity.get(assetId);
  if (!item) return 'missing';
  if (item.language_key !== 'zpl') return 'unsupported';
  return item.stale ? 'stale' : 'ready';
}

export function isPrintableStatus(s: LabelStatus): boolean {
  return s === 'ready' || s === 'stale';
}

export function missingLabelIds(selectedIds: string[], byEntity: Map<string, GeneratedLabelBundleItem>): string[] {
  return selectedIds.filter((id) => !isPrintableStatus(labelStatusFor(id, byEntity)));
}

export function staleLabelCount(selectedIds: string[], byEntity: Map<string, GeneratedLabelBundleItem>): number {
  return selectedIds.filter((id) => labelStatusFor(id, byEntity) === 'stale').length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/printLabels.test.ts`
Expected: all passed. If the alignment-test expectations differ from the implementation, the implementation is wrong (the expectations are computed from V2's routine: 600×300 → boxes at insets 5, 30, 55, 80, 105, 130 → six `^GB` lines, caption at y = 150 − 12 = 138).

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/printLabels.ts portal/src/lib/printLabels.test.ts
git commit -m "feat(portal): Print Labels pure helpers — settings store, V2 ZPL transforms, print order, batches, label status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: WebUSB transport — `labels/zebraUsb.ts`

**Files:**
- Create: `portal/src/labels/zebraUsb.ts`
- Test: `portal/src/labels/zebraUsb.test.ts`

**Interfaces:**
- Produces (exact exports; Task 5's hook and Task 11's page use them):
  ```ts
  export const ZEBRA_VENDOR_ID = 0x0a5f
  export interface UsbEndpointLike { direction: 'in' | 'out'; type: 'bulk' | 'interrupt' | 'isochronous'; endpointNumber: number }
  export interface UsbDeviceLike {
    readonly opened: boolean;
    readonly productName?: string;
    readonly configuration: { interfaces: { alternate: { endpoints: UsbEndpointLike[] } }[] } | null;
    open(): Promise<void>; close(): Promise<void>;
    selectConfiguration(n: number): Promise<void>;
    claimInterface(n: number): Promise<void>; releaseInterface(n: number): Promise<void>;
    transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
    transferIn(endpoint: number, length: number): Promise<{ data?: DataView }>;
  }
  export interface UsbLike { requestDevice(opts: { filters: { vendorId: number }[] }): Promise<UsbDeviceLike> }
  export function requestZebraDevice(usb: UsbLike): Promise<UsbDeviceLike>
  export function openPrinter(device: UsbDeviceLike): Promise<void>
  export function closePrinter(device: UsbDeviceLike): Promise<void>
  export function ensureOpen(device: UsbDeviceLike): Promise<void>    // throws Error('Printer connection lost. Please reconnect.')
  export function findBulkEndpoints(device: UsbDeviceLike): { out: UsbEndpointLike | null; in: UsbEndpointLike | null }
  export function sendRaw(device: UsbDeviceLike, text: string): Promise<void>  // throws Error('Could not find printer output endpoint')
  export function parseHostStatusQueued(text: string): number | null
  export interface Clock { now(): number; sleep(ms: number): Promise<void> }
  export function queryQueuedFormats(device: UsbDeviceLike, clock?: Clock): Promise<number | null>
  export function waitForPrinterIdle(device: UsbDeviceLike, labelsSent: number, opts?: { onQueued?: (n: number) => void; clock?: Clock }): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// portal/src/labels/zebraUsb.test.ts
/** The Zebra WebUSB transport against a fake device — V2's connect/send/
 *  ~HS-poll semantics (PrintLabels.jsx) without a printer. */
import { describe, expect, it, vi } from 'vitest';

import {
  ZEBRA_VENDOR_ID, closePrinter, ensureOpen, findBulkEndpoints, openPrinter, parseHostStatusQueued,
  queryQueuedFormats, requestZebraDevice, sendRaw, waitForPrinterIdle, type Clock, type UsbDeviceLike,
} from './zebraUsb';

class FakeDevice implements UsbDeviceLike {
  opened = false;
  productName = 'ZD421';
  configuration: UsbDeviceLike['configuration'] = null;
  log: string[] = [];
  sent: string[] = [];
  /** One entry per `~HS` query: the packets transferIn hands out for that
   *  query, in order. transferIn hangs once the current query's packets are
   *  exhausted (→ the transport's timeout path), so a later poll never sees
   *  an earlier poll's leftovers. */
  responses: string[][] = [];
  private pending: string[] = [];
  failOpen = false;
  constructor(endpoints: Array<{ direction: 'in' | 'out'; type: 'bulk' | 'interrupt' }> = [
    { direction: 'out', type: 'bulk' }, { direction: 'in', type: 'bulk' },
  ], configured = true) {
    if (configured) {
      this.configuration = { interfaces: [{ alternate: { endpoints: endpoints.map((e, i) => ({ ...e, endpointNumber: i + 1 })) } }] };
    }
  }
  async open() { if (this.failOpen) throw new Error('nope'); this.opened = true; this.log.push('open'); }
  async close() { this.opened = false; this.log.push('close'); }
  async selectConfiguration(n: number) { this.log.push(`selectConfiguration:${n}`); }
  async claimInterface(n: number) { this.log.push(`claim:${n}`); }
  async releaseInterface(n: number) { this.log.push(`release:${n}`); }
  async transferOut(endpoint: number, data: BufferSource) {
    this.log.push(`out:${endpoint}`);
    const text = new TextDecoder().decode(data as ArrayBuffer | ArrayBufferView);
    this.sent.push(text);
    if (text === '~HS') this.pending = [...(this.responses.shift() ?? [])];
  }
  async transferIn(endpoint: number, _length: number) {
    this.log.push(`in:${endpoint}`);
    const next = this.pending.shift();
    if (next === undefined) return new Promise<{ data?: DataView }>(() => undefined); // hangs → timeout path
    const bytes = new TextEncoder().encode(next);
    return { data: new DataView(bytes.buffer) };
  }
}

const instantClock = (): Clock & { slept: number[] } => {
  let t = 0;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
};

describe('connect / disconnect', () => {
  it('requests with the Zebra vendor filter', async () => {
    const dev = new FakeDevice();
    const usb = { requestDevice: vi.fn(async () => dev) };
    expect(await requestZebraDevice(usb)).toBe(dev);
    expect(usb.requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: ZEBRA_VENDOR_ID }] });
  });
  it('opens: close-if-open, open, select config 1 when none, claim interface 0', async () => {
    const dev = new FakeDevice([], false);
    dev.opened = true;
    await openPrinter(dev);
    expect(dev.log).toEqual(['close', 'open', 'selectConfiguration:1', 'claim:0']);
  });
  it('skips selectConfiguration when one is already active', async () => {
    const dev = new FakeDevice();
    await openPrinter(dev);
    expect(dev.log).toEqual(['open', 'claim:0']);
  });
  it('closePrinter releases then closes and tolerates failures', async () => {
    const dev = new FakeDevice();
    dev.releaseInterface = async () => { throw new Error('already released'); };
    await expect(closePrinter(dev)).resolves.toBeUndefined();
    expect(dev.log).toEqual(['close']);
  });
  it('ensureOpen reopens a device that went stale, or throws the V2 message', async () => {
    const dev = new FakeDevice();
    await ensureOpen(dev);
    expect(dev.log).toEqual(['open', 'claim:0']);
    const dead = new FakeDevice();
    dead.failOpen = true;
    await expect(ensureOpen(dead)).rejects.toThrow('Printer connection lost. Please reconnect.');
  });
});

describe('sending', () => {
  it('finds the bulk endpoints and writes UTF-8 bytes to the OUT one', async () => {
    const dev = new FakeDevice([{ direction: 'in', type: 'interrupt' }, { direction: 'out', type: 'bulk' }, { direction: 'in', type: 'bulk' }]);
    dev.opened = true;
    const eps = findBulkEndpoints(dev);
    expect(eps.out?.endpointNumber).toBe(2);
    expect(eps.in?.endpointNumber).toBe(3);
    await sendRaw(dev, '^XA^FDhé^FS^XZ');
    expect(dev.log).toContain('out:2');
    expect(dev.sent).toEqual(['^XA^FDhé^FS^XZ']);
  });
  it('throws when there is no bulk OUT endpoint', async () => {
    const dev = new FakeDevice([{ direction: 'in', type: 'bulk' }]);
    dev.opened = true;
    await expect(sendRaw(dev, '^XA^XZ')).rejects.toThrow('Could not find printer output endpoint');
  });
});

describe('~HS host status', () => {
  it('parses the queued-format count from field 5 of string 1', () => {
    expect(parseHostStatusQueued('\x02030,0,0,1245,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,0,2,4,0,00000000,1,000\x03')).toBe(0);
    expect(parseHostStatusQueued('\x02030,0,0,1245,007,0,0,0,000,0,0,0\x03')).toBe(7);
    expect(parseHostStatusQueued('garbage')).toBeNull();
    expect(parseHostStatusQueued('\x02abc')).toBeNull();
  });
  it('sends ~HS, reads the first packet, drains extra packets, and returns the count', async () => {
    const dev = new FakeDevice();
    dev.opened = true;
    dev.responses = [['\x02030,0,0,1245,003,0,0,0,000,0,0,0\x03', '\x02more\x03']];
    const clock = instantClock();
    expect(await queryQueuedFormats(dev, clock)).toBe(3);
    expect(dev.sent).toEqual(['~HS']);
    expect(dev.log.filter((l) => l.startsWith('in:')).length).toBeGreaterThanOrEqual(2);
  });
  it('returns null when the device is closed, lacks endpoints, or the read times out', async () => {
    const closed = new FakeDevice();
    expect(await queryQueuedFormats(closed, instantClock())).toBeNull();
    const noIn = new FakeDevice([{ direction: 'out', type: 'bulk' }]);
    noIn.opened = true;
    expect(await queryQueuedFormats(noIn, instantClock())).toBeNull();
    const silent = new FakeDevice();
    silent.opened = true;               // no responses → transferIn hangs
    expect(await queryQueuedFormats(silent, instantClock())).toBeNull();
  });
});

describe('waitForPrinterIdle', () => {
  it('polls once a second until the queue is empty, reporting each count', async () => {
    const dev = new FakeDevice();
    dev.opened = true;
    dev.responses = [
      ['\x02030,0,0,1245,002,0,0,0,000,0,0,0\x03'],
      ['\x02030,0,0,1245,001,0,0,0,000,0,0,0\x03'],
      ['\x02030,0,0,1245,000,0,0,0,000,0,0,0\x03'],
    ];
    const clock = instantClock();
    const onQueued = vi.fn();
    await waitForPrinterIdle(dev, 3, { onQueued, clock });
    expect(onQueued.mock.calls.map((c) => c[0])).toEqual([2, 1, 0]);
    expect(clock.slept.filter((ms) => ms === 1000).length).toBe(2);
  });
  it('falls back to ~0.5 s per label (capped at 30 s) when status is unreadable from the start', async () => {
    const dev = new FakeDevice([{ direction: 'out', type: 'bulk' }]);
    dev.opened = true;
    const clock = instantClock();
    await waitForPrinterIdle(dev, 10, { clock });
    expect(clock.slept).toEqual([5000]);
    const big = instantClock();
    await waitForPrinterIdle(dev, 1000, { clock: big });
    expect(big.slept).toEqual([30000]);
  });
  it('gives up at the deadline (max 30 s, 3 s per label) when the queue never drains', async () => {
    const dev = new FakeDevice();
    dev.opened = true;
    dev.responses = Array.from({ length: 50 }, () => ['\x02030,0,0,1245,001,0,0,0,000,0,0,0\x03']);
    const clock = instantClock();
    await waitForPrinterIdle(dev, 2, { clock });
    // the instant clock advances on every sleep call, including the losing
    // side of the read-timeout race (2000 + 250 per poll) plus the 1 s loop
    // sleep, so ~10 polls reach the 30 s deadline
    expect(clock.now()).toBeGreaterThanOrEqual(30000);
    expect(clock.now()).toBeLessThan(40000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/labels/zebraUsb.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// portal/src/labels/zebraUsb.ts
/**
 * Zebra-over-WebUSB transport — V2's PrintLabels.jsx connection, send and
 * `~HS` host-status polling, lifted into a pure module over a narrow
 * device interface so it runs against a fake in tests and against
 * `navigator.usb` in the browser (`lib/useZebraPrinter.ts`). No React.
 *
 * WebUSB needs Chromium on a secure context (https or localhost); callers
 * check `'usb' in navigator` before offering the connect button.
 */

export const ZEBRA_VENDOR_ID = 0x0a5f; // Zebra Technologies

export interface UsbEndpointLike {
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
  endpointNumber: number;
}

export interface UsbDeviceLike {
  readonly opened: boolean;
  readonly productName?: string;
  readonly configuration: { interfaces: { alternate: { endpoints: UsbEndpointLike[] } }[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
  transferIn(endpoint: number, length: number): Promise<{ data?: DataView }>;
}

export interface UsbLike {
  requestDevice(opts: { filters: { vendorId: number }[] }): Promise<UsbDeviceLike>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function requestZebraDevice(usb: UsbLike): Promise<UsbDeviceLike> {
  return usb.requestDevice({ filters: [{ vendorId: ZEBRA_VENDOR_ID }] });
}

/** V2's handleConnectPrinter sequence after requestDevice. */
export async function openPrinter(device: UsbDeviceLike): Promise<void> {
  if (device.opened) {
    try { await device.close(); } catch { /* was open; ignore */ }
  }
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(0);
}

/** Release interface 0 then close, each tolerant — V2 deliberately never
 *  calls forget(), which would make the device object stale. */
export async function closePrinter(device: UsbDeviceLike): Promise<void> {
  try { await device.releaseInterface(0); } catch { /* ignore */ }
  try { await device.close(); } catch { /* ignore */ }
}

/** V2's reopen-on-stale path at the top of sendZplToPrinter. */
export async function ensureOpen(device: UsbDeviceLike): Promise<void> {
  if (device.opened) return;
  try {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);
  } catch {
    throw new Error('Printer connection lost. Please reconnect.');
  }
}

export function findBulkEndpoints(device: UsbDeviceLike): { out: UsbEndpointLike | null; in: UsbEndpointLike | null } {
  const endpoints = device.configuration?.interfaces?.[0]?.alternate?.endpoints ?? [];
  return {
    out: endpoints.find((e) => e.direction === 'out' && e.type === 'bulk') ?? null,
    in: endpoints.find((e) => e.direction === 'in' && e.type === 'bulk') ?? null,
  };
}

/** Raw bytes to the printer's bulk OUT endpoint. Callers apply the print
 *  settings transform first (`lib/printLabels.ts` applyPrintSettings). */
export async function sendRaw(device: UsbDeviceLike, text: string): Promise<void> {
  await ensureOpen(device);
  const { out } = findBulkEndpoints(device);
  if (!out) throw new Error('Could not find printer output endpoint');
  await device.transferOut(out.endpointNumber, new TextEncoder().encode(text));
}

/** `~HS` string 1 is `<STX>aaa,b,c,dddd,eee,…<ETX>`; field 5 (eee) is the
 *  number of formats in the receive buffer. */
export function parseHostStatusQueued(text: string): number | null {
  const string1 = text.split('\x02')[1];
  if (!string1) return null;
  const queued = parseInt(string1.split(',')[4], 10);
  return Number.isNaN(queued) ? null : queued;
}

const STATUS_FIRST_READ_MS = 2000;
const STATUS_DRAIN_READ_MS = 250;
const STATUS_DRAIN_READS = 3;

/** Ask the printer how many formats are still queued; null when the status
 *  can't be read (closed device, no bulk IN, timeout, transfer error). */
export async function queryQueuedFormats(device: UsbDeviceLike, clock: Clock = realClock): Promise<number | null> {
  if (!device.opened) return null;
  const { in: inEp, out: outEp } = findBulkEndpoints(device);
  if (!inEp || !outEp) return null;
  const readWithTimeout = (ms: number) => Promise.race([
    device.transferIn(inEp.endpointNumber, 256),
    clock.sleep(ms).then(() => { throw new Error('status timeout'); }),
  ]);
  try {
    await device.transferOut(outEp.endpointNumber, new TextEncoder().encode('~HS'));
    const decoder = new TextDecoder();
    let text = decoder.decode((await readWithTimeout(STATUS_FIRST_READ_MS)).data);
    // The 3 STX-framed strings can arrive as separate packets — drain them
    // so stale data doesn't confuse the next poll.
    for (let i = 0; i < STATUS_DRAIN_READS; i++) {
      try {
        text += decoder.decode((await readWithTimeout(STATUS_DRAIN_READ_MS)).data);
      } catch {
        break; // drained
      }
    }
    return parseHostStatusQueued(text);
  } catch {
    return null;
  }
}

/** Wait until the printer has physically printed everything sent: poll
 *  `~HS` once a second until the receive buffer is empty, reporting each
 *  queued count via `onQueued`. Deadline max(30 s, 3 s × labels). If status
 *  is unreadable from the first poll, sleep ~0.5 s per label (max 30 s)
 *  instead; a transient failure after a successful read keeps polling. */
export async function waitForPrinterIdle(
  device: UsbDeviceLike, labelsSent: number,
  { onQueued, clock = realClock }: { onQueued?: (queued: number) => void; clock?: Clock } = {},
): Promise<void> {
  const deadline = clock.now() + Math.max(30000, labelsSent * 3000);
  let statusAvailable = false;
  while (clock.now() < deadline) {
    const queued = await queryQueuedFormats(device, clock);
    if (queued === null) {
      if (!statusAvailable) {
        await clock.sleep(Math.min(labelsSent * 500, 30000));
        return;
      }
    } else {
      statusAvailable = true;
      onQueued?.(queued);
      if (queued === 0) return;
    }
    await clock.sleep(1000);
  }
}
```

Note on the timeout race: `clock.sleep(ms).then(() => { throw … })` rejects after `ms`, which is what `Promise.race` needs; with the instant fake clock the rejection wins immediately when the fake `transferIn` hangs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/labels/zebraUsb.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add portal/src/labels/zebraUsb.ts portal/src/labels/zebraUsb.test.ts
git commit -m "feat(portal): Zebra WebUSB transport module (V2 connect/send/~HS polling over a fakeable device interface)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `useZebraPrinter` hook

**Files:**
- Create: `portal/src/lib/useZebraPrinter.ts` (hooks live in `lib/` in this repo, e.g. `lib/useDeepLinkFilter.ts`)
- Test: `portal/src/lib/useZebraPrinter.test.tsx`

**Interfaces:**
- Consumes: Task 4's transport.
- Produces:
  ```ts
  export interface PrinterNotice { type: 'success' | 'info' | 'warning' | 'error'; message: string }
  export interface ZebraPrinter {
    supported: boolean;
    connected: boolean;
    productName: string | null;
    notice: PrinterNotice | null;          // last connect/disconnect message (page shows it, then clears with clearNotice)
    clearNotice(): void;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(zpl: string): Promise<void>;      // raw send — the page applies settings first
    waitForIdle(labelsSent: number, onQueued?: (n: number) => void): Promise<void>;
  }
  export function useZebraPrinter(usb?: UsbLike & { addEventListener?: ...; removeEventListener?: ... }): ZebraPrinter
  ```
  The `usb` parameter defaults to `navigator.usb` (cast) and exists so tests inject a fake with `requestDevice` + `addEventListener`/`removeEventListener`.

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/lib/useZebraPrinter.test.tsx
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { UsbDeviceLike } from '../labels/zebraUsb';
import { useZebraPrinter } from './useZebraPrinter';

function fakeDevice(name = 'ZD421'): UsbDeviceLike & { log: string[] } {
  const dev = {
    opened: false, productName: name, log: [] as string[],
    configuration: { interfaces: [{ alternate: { endpoints: [{ direction: 'out' as const, type: 'bulk' as const, endpointNumber: 1 }, { direction: 'in' as const, type: 'bulk' as const, endpointNumber: 2 }] } }] },
    async open() { dev.opened = true; dev.log.push('open'); },
    async close() { dev.opened = false; dev.log.push('close'); },
    async selectConfiguration() { dev.log.push('select'); },
    async claimInterface() { dev.log.push('claim'); },
    async releaseInterface() { dev.log.push('release'); },
    async transferOut(_e: number, data: BufferSource) { dev.log.push(`out:${new TextDecoder().decode(data as ArrayBuffer)}`); },
    async transferIn() { return new Promise<{ data?: DataView }>(() => undefined); },
  };
  return dev;
}

function fakeUsb(device: UsbDeviceLike | Error) {
  const listeners: Record<string, ((e: { device: UsbDeviceLike }) => void)[]> = {};
  return {
    requestDevice: vi.fn(async () => { if (device instanceof Error) throw device; return device; }),
    addEventListener: (type: string, fn: (e: { device: UsbDeviceLike }) => void) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: (e: { device: UsbDeviceLike }) => void) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    emitDisconnect: (d: UsbDeviceLike) => listeners.disconnect?.forEach((fn) => fn({ device: d })),
    listeners,
  };
}

describe('useZebraPrinter', () => {
  it('reports unsupported when no usb object exists', () => {
    const { result } = renderHook(() => useZebraPrinter(null));
    expect(result.current.supported).toBe(false);
    expect(result.current.connected).toBe(false);
  });

  it('connects (request → open → claim) and reports the product name', async () => {
    const dev = fakeDevice();
    const usb = fakeUsb(dev);
    const { result } = renderHook(() => useZebraPrinter(usb));
    expect(result.current.supported).toBe(true);
    await act(async () => { await result.current.connect(); });
    expect(dev.log).toEqual(['open', 'claim']);
    expect(result.current.connected).toBe(true);
    expect(result.current.productName).toBe('ZD421');
    expect(result.current.notice).toEqual({ type: 'success', message: 'Printer connected: ZD421' });
  });

  it('surfaces a connect failure as an error notice and stays disconnected', async () => {
    const usb = fakeUsb(new Error('No device selected.'));
    const { result } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    expect(result.current.connected).toBe(false);
    expect(result.current.notice).toEqual({ type: 'error', message: 'No device selected.' });
  });

  it('sends raw ZPL through the device and disconnects cleanly', async () => {
    const dev = fakeDevice();
    const usb = fakeUsb(dev);
    const { result } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    await act(async () => { await result.current.send('^XA^XZ'); });
    expect(dev.log).toContain('out:^XA^XZ');
    await act(async () => { await result.current.disconnect(); });
    expect(dev.log.slice(-2)).toEqual(['release', 'close']);
    expect(result.current.connected).toBe(false);
    expect(result.current.notice).toEqual({ type: 'info', message: 'Printer disconnected' });
    await expect(result.current.send('^XA^XZ')).rejects.toThrow('Printer not connected');
  });

  it('drops the connection with a warning when the USB device disconnects, and releases on unmount', async () => {
    const dev = fakeDevice();
    const usb = fakeUsb(dev);
    const { result, unmount } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    act(() => { usb.emitDisconnect(fakeDevice('other')); });
    expect(result.current.connected).toBe(true);
    act(() => { usb.emitDisconnect(dev); });
    expect(result.current.connected).toBe(false);
    expect(result.current.notice).toEqual({ type: 'warning', message: 'Printer was disconnected' });

    const dev2 = fakeDevice();
    const usb2 = fakeUsb(dev2);
    const h2 = renderHook(() => useZebraPrinter(usb2));
    await act(async () => { await h2.result.current.connect(); });
    h2.unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(dev2.log.slice(-2)).toEqual(['release', 'close']);
    expect(usb2.listeners.disconnect?.length ?? 0).toBe(0);
    unmount();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/useZebraPrinter.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// portal/src/lib/useZebraPrinter.ts
/**
 * React wrapper around `labels/zebraUsb.ts` — one printer per page, held
 * in a ref so USB disconnect events and the unmount release see the live
 * device; V2's connect/disconnect notices are exposed as `notice` for the
 * page's status strip. Pass a fake `usb` in tests; the default is
 * `navigator.usb`, and `supported` is false where WebUSB doesn't exist.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  closePrinter, openPrinter, requestZebraDevice, sendRaw, waitForPrinterIdle,
  type UsbDeviceLike, type UsbLike,
} from '../labels/zebraUsb';

export interface PrinterNotice { type: 'success' | 'info' | 'warning' | 'error'; message: string }

type UsbEvents = {
  addEventListener?: (type: 'disconnect', fn: (e: { device: UsbDeviceLike }) => void) => void;
  removeEventListener?: (type: 'disconnect', fn: (e: { device: UsbDeviceLike }) => void) => void;
};

export type UsbApi = UsbLike & UsbEvents;

export interface ZebraPrinter {
  supported: boolean;
  connected: boolean;
  productName: string | null;
  notice: PrinterNotice | null;
  clearNotice(): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(zpl: string): Promise<void>;
  waitForIdle(labelsSent: number, onQueued?: (n: number) => void): Promise<void>;
}

function defaultUsb(): UsbApi | null {
  if (typeof navigator === 'undefined') return null;
  const usb = (navigator as unknown as { usb?: UsbApi }).usb;
  return usb ?? null;
}

export function useZebraPrinter(usbOverride?: UsbApi | null): ZebraPrinter {
  const usb = useMemo(() => (usbOverride === undefined ? defaultUsb() : usbOverride), [usbOverride]);
  const deviceRef = useRef<UsbDeviceLike | null>(null);
  const [device, setDevice] = useState<UsbDeviceLike | null>(null);
  const [notice, setNotice] = useState<PrinterNotice | null>(null);

  const drop = useCallback((next: PrinterNotice | null) => {
    deviceRef.current = null;
    setDevice(null);
    if (next) setNotice(next);
  }, []);

  // A physical unplug of OUR device drops the connection with V2's warning.
  useEffect(() => {
    if (!usb?.addEventListener) return undefined;
    const onDisconnect = (e: { device: UsbDeviceLike }) => {
      if (deviceRef.current && e.device === deviceRef.current) {
        drop({ type: 'warning', message: 'Printer was disconnected' });
      }
    };
    usb.addEventListener('disconnect', onDisconnect);
    return () => usb.removeEventListener?.('disconnect', onDisconnect);
  }, [usb, drop]);

  // Leaving the page releases the interface and closes the device (V2).
  useEffect(() => () => {
    const held = deviceRef.current;
    deviceRef.current = null;
    if (held) void closePrinter(held);
  }, []);

  const connect = useCallback(async () => {
    if (!usb) {
      setNotice({ type: 'error', message: 'USB printing needs Chrome or Edge on a secure (https or localhost) address.' });
      return;
    }
    if (deviceRef.current) {
      await closePrinter(deviceRef.current);
      drop(null);
    }
    try {
      const next = await requestZebraDevice(usb);
      await openPrinter(next);
      deviceRef.current = next;
      setDevice(next);
      setNotice({ type: 'success', message: `Printer connected: ${next.productName || 'Zebra Printer'}` });
    } catch (err) {
      drop({ type: 'error', message: err instanceof Error && err.message ? err.message : 'Failed to connect to printer' });
    }
  }, [usb, drop]);

  const disconnect = useCallback(async () => {
    const held = deviceRef.current;
    if (held) await closePrinter(held);
    drop({ type: 'info', message: 'Printer disconnected' });
  }, [drop]);

  const send = useCallback(async (zpl: string) => {
    const held = deviceRef.current;
    if (!held) throw new Error('Printer not connected');
    try {
      await sendRaw(held, zpl);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Printer connection lost')) drop(null);
      throw err;
    }
  }, [drop]);

  const waitForIdle = useCallback(async (labelsSent: number, onQueued?: (n: number) => void) => {
    const held = deviceRef.current;
    if (!held) return;
    await waitForPrinterIdle(held, labelsSent, { onQueued });
  }, []);

  return {
    supported: usb !== null,
    connected: device !== null,
    productName: device?.productName ?? null,
    notice,
    clearNotice: () => setNotice(null),
    connect, disconnect, send, waitForIdle,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/useZebraPrinter.test.tsx`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/useZebraPrinter.ts portal/src/lib/useZebraPrinter.test.tsx
git commit -m "feat(portal): useZebraPrinter hook — page-scoped WebUSB printer with disconnect handling and unmount release

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: IndexedDB label cache — `lib/labelCache.ts`

**Files:**
- Modify: `portal/package.json` (devDependency `fake-indexeddb`)
- Create: `portal/src/lib/labelCache.ts`
- Test: `portal/src/lib/labelCache.test.ts`

**Interfaces:**
- Consumes: `InitiativeItem`, `InitiativeAssetRow`, `GeneratedLabelBundle` from `./api`.
- Produces:
  ```ts
  export interface CachedInitiative { initiative: InitiativeItem; roster: InitiativeAssetRow[]; cached_at: string }
  export interface CachedBundle extends GeneratedLabelBundle { initiative_name: string; cached_at: string }
  export function bundleKey(initiativeId: string, labelType: string): string   // `${initiativeId}:${labelType}`
  export function cacheAvailable(): boolean
  export function putInitiative(entry: Omit<CachedInitiative, 'cached_at'>): Promise<void>
  export function getInitiative(initiativeId: string): Promise<CachedInitiative | null>
  export function listInitiatives(): Promise<CachedInitiative[]>
  export function putBundle(bundle: GeneratedLabelBundle, initiativeName: string): Promise<void>
  export function getBundle(initiativeId: string, labelType: string): Promise<CachedBundle | null>
  export function listBundles(): Promise<CachedBundle[]>
  export function deleteBundle(initiativeId: string, labelType: string): Promise<void>
  export function deleteInitiative(initiativeId: string): Promise<void>   // and all its bundles
  export function clearAll(): Promise<void>
  ```
  Every function resolves (null / [] / void) without throwing when IndexedDB is unavailable.

- [ ] **Step 1: Add the dev dependency**

Run (from `portal/`): `npm install --save-dev fake-indexeddb@^6.0.0`. If this checkout is a worktree with a symlinked `node_modules`, run the install in the MAIN checkout's `portal/` (`/Users/jrh1812/Developer/BaseCampV3/portal`) instead and copy the resulting `package.json`/`package-lock.json` diff into the worktree (`git -C /Users/jrh1812/Developer/BaseCampV3 diff -- portal/package.json portal/package-lock.json | git apply`). Verify `ls portal/node_modules/fake-indexeddb` exists from the worktree.

- [ ] **Step 2: Write the failing tests**

```ts
// portal/src/lib/labelCache.test.ts
// @vitest-environment jsdom
/** The Print Labels offline cache against fake-indexeddb. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import type { GeneratedLabelBundle, InitiativeAssetRow, InitiativeItem } from './api';
import {
  bundleKey, cacheAvailable, clearAll, deleteBundle, deleteInitiative, getBundle, getInitiative,
  listBundles, listInitiatives, putBundle, putInitiative,
} from './labelCache';

const ini = (id: string, name: string) => ({ id, name, client_name: 'Acme' } as unknown as InitiativeItem);
const row = (assetId: string) => ({ id: `j-${assetId}`, asset_id: assetId } as unknown as InitiativeAssetRow);
const bundle = (initiativeId: string, type: string, n: number): GeneratedLabelBundle => ({
  initiative_id: initiativeId, label_type: type, fetched_at: '2026-09-12T00:00:00Z',
  labels: Array.from({ length: n }, (_, i) => ({
    id: `${type}-${i}`, entity_type: 'asset', entity_id: `a${i}`, template_id: 't', template_name: 'T',
    template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false,
    generated_at: '2026-09-12T00:00:00Z', code: '^XA^XZ',
  })),
});

beforeEach(() => {
  // fresh database per test
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe('labelCache', () => {
  it('reports availability and builds keys', () => {
    expect(cacheAvailable()).toBe(true);
    expect(bundleKey('i1', 'top')).toBe('i1:top');
  });

  it('stores and lists initiatives with their rosters', async () => {
    await putInitiative({ initiative: ini('i1', 'NAP11'), roster: [row('a1'), row('a2')] });
    await putInitiative({ initiative: ini('i2', 'NAP22'), roster: [] });
    const got = await getInitiative('i1');
    expect(got?.initiative.name).toBe('NAP11');
    expect(got?.roster.map((r) => r.asset_id)).toEqual(['a1', 'a2']);
    expect(got?.cached_at).toBeTruthy();
    expect((await listInitiatives()).map((e) => e.initiative.id).sort()).toEqual(['i1', 'i2']);
    expect(await getInitiative('nope')).toBeNull();
  });

  it('stores bundles per initiative + type, replacing on re-put', async () => {
    await putBundle(bundle('i1', 'top', 2), 'NAP11');
    await putBundle(bundle('i1', 'front', 1), 'NAP11');
    await putBundle(bundle('i1', 'top', 3), 'NAP11');
    const top = await getBundle('i1', 'top');
    expect(top?.labels.length).toBe(3);
    expect(top?.initiative_name).toBe('NAP11');
    expect(top?.cached_at).toBeTruthy();
    expect((await listBundles()).length).toBe(2);
    expect(await getBundle('i1', 'rail')).toBeNull();
  });

  it('deletes one bundle, an initiative with its bundles, or everything', async () => {
    await putInitiative({ initiative: ini('i1', 'NAP11'), roster: [] });
    await putInitiative({ initiative: ini('i2', 'NAP22'), roster: [] });
    await putBundle(bundle('i1', 'top', 1), 'NAP11');
    await putBundle(bundle('i1', 'front', 1), 'NAP11');
    await putBundle(bundle('i2', 'top', 1), 'NAP22');
    await deleteBundle('i1', 'front');
    expect((await listBundles()).map((b) => bundleKey(b.initiative_id, b.label_type)).sort()).toEqual(['i1:top', 'i2:top']);
    await deleteInitiative('i1');
    expect(await getInitiative('i1')).toBeNull();
    expect((await listBundles()).map((b) => b.initiative_id)).toEqual(['i2']);
    await clearAll();
    expect(await listInitiatives()).toEqual([]);
    expect(await listBundles()).toEqual([]);
  });

  it('degrades to no-ops without IndexedDB', async () => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
    expect(cacheAvailable()).toBe(false);
    await expect(putBundle(bundle('i1', 'top', 1), 'NAP11')).resolves.toBeUndefined();
    expect(await getBundle('i1', 'top')).toBeNull();
    expect(await listBundles()).toEqual([]);
    expect(await listInitiatives()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/labelCache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// portal/src/lib/labelCache.ts
/**
 * Print Labels' offline cache — a small typed wrapper over IndexedDB (no
 * library). Two stores: `initiatives` (the initiative item + its asset
 * roster, keyed by initiative id) and `bundles` (one generated-label
 * bundle per initiative + label type, keyed `${initiativeId}:${labelType}`).
 * Every call degrades to a no-op/null when IndexedDB is unavailable
 * (private mode, jsdom without fake-indexeddb) so the page never depends
 * on it. Behavior contract: the spec's "Offline mechanics" section.
 */
import type { GeneratedLabelBundle, InitiativeAssetRow, InitiativeItem } from './api';

const DB_NAME = 'basecamp-labels';
const DB_VERSION = 1;
const STORE_INITIATIVES = 'initiatives';
const STORE_BUNDLES = 'bundles';

export interface CachedInitiative {
  initiative: InitiativeItem;
  roster: InitiativeAssetRow[];
  cached_at: string;
}

export interface CachedBundle extends GeneratedLabelBundle {
  initiative_name: string;
  cached_at: string;
}

type StoredInitiative = CachedInitiative & { id: string };
type StoredBundle = CachedBundle & { key: string };

export function bundleKey(initiativeId: string, labelType: string): string {
  return `${initiativeId}:${labelType}`;
}

function factory(): IDBFactory | null {
  try {
    const f = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
    return f ?? null;
  } catch {
    return null;
  }
}

export function cacheAvailable(): boolean {
  return factory() !== null;
}

function openDb(): Promise<IDBDatabase | null> {
  const f = factory();
  if (!f) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = f.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_INITIATIVES)) db.createObjectStore(STORE_INITIATIVES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_BUNDLES)) db.createObjectStore(STORE_BUNDLES, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `fn` inside a transaction over `stores`; resolves `fallback` when
 *  IndexedDB is unavailable or the transaction fails. */
async function withStore<T>(
  stores: string[], mode: IDBTransactionMode, fallback: T,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  try {
    const tx = db.transaction(stores, mode);
    const result = await fn(tx);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

const stamp = () => new Date().toISOString();

export function putInitiative(entry: Omit<CachedInitiative, 'cached_at'>): Promise<void> {
  const stored: StoredInitiative = { ...entry, id: entry.initiative.id, cached_at: stamp() };
  return withStore([STORE_INITIATIVES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_INITIATIVES).put(stored));
  });
}

export function getInitiative(initiativeId: string): Promise<CachedInitiative | null> {
  return withStore([STORE_INITIATIVES], 'readonly', null, async (tx) => {
    const got = (await request(tx.objectStore(STORE_INITIATIVES).get(initiativeId))) as StoredInitiative | undefined;
    return got ?? null;
  });
}

export function listInitiatives(): Promise<CachedInitiative[]> {
  return withStore([STORE_INITIATIVES], 'readonly', [], async (tx) =>
    (await request(tx.objectStore(STORE_INITIATIVES).getAll())) as StoredInitiative[]);
}

export function putBundle(bundle: GeneratedLabelBundle, initiativeName: string): Promise<void> {
  const stored: StoredBundle = {
    ...bundle, initiative_name: initiativeName, cached_at: stamp(),
    key: bundleKey(bundle.initiative_id, bundle.label_type),
  };
  return withStore([STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_BUNDLES).put(stored));
  });
}

export function getBundle(initiativeId: string, labelType: string): Promise<CachedBundle | null> {
  return withStore([STORE_BUNDLES], 'readonly', null, async (tx) => {
    const got = (await request(tx.objectStore(STORE_BUNDLES).get(bundleKey(initiativeId, labelType)))) as StoredBundle | undefined;
    return got ?? null;
  });
}

export function listBundles(): Promise<CachedBundle[]> {
  return withStore([STORE_BUNDLES], 'readonly', [], async (tx) =>
    (await request(tx.objectStore(STORE_BUNDLES).getAll())) as StoredBundle[]);
}

export function deleteBundle(initiativeId: string, labelType: string): Promise<void> {
  return withStore([STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_BUNDLES).delete(bundleKey(initiativeId, labelType)));
  });
}

export function deleteInitiative(initiativeId: string): Promise<void> {
  return withStore([STORE_INITIATIVES, STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_INITIATIVES).delete(initiativeId));
    const bundles = tx.objectStore(STORE_BUNDLES);
    const all = (await request(bundles.getAll())) as StoredBundle[];
    for (const b of all) {
      if (b.initiative_id === initiativeId) await request(bundles.delete(b.key));
    }
  });
}

export function clearAll(): Promise<void> {
  return withStore([STORE_INITIATIVES, STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_INITIATIVES).clear());
    await request(tx.objectStore(STORE_BUNDLES).clear());
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/labelCache.test.ts`
Expected: 5 passed. (If `tx.oncomplete` never fires under fake-indexeddb because the awaited request resolved in a microtask after the transaction auto-committed, move the completion promise creation BEFORE running `fn` — create it first, then `await fn(tx)`, then `await` the completion promise.)

- [ ] **Step 6: Commit**

```bash
git add portal/package.json portal/package-lock.json portal/src/lib/labelCache.ts portal/src/lib/labelCache.test.ts
git commit -m "feat(portal): IndexedDB label cache for offline printing (initiative rosters + label bundles)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Print settings modal + page CSS

**Files:**
- Create: `portal/src/components/labels/PrintSettingsModal.tsx`
- Modify: `portal/src/styles/labels.css` (append the `plabels-*` block below — this task adds ALL the feature's CSS so later tasks only add markup)
- Test: `portal/src/components/labels/PrintSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `PrintSettings`, `clampSetting`, `settingsModified`, `DEFAULT_PRINT_SETTINGS`, `alignmentTestZpl`, `NumericSetting` (Task 3); `LabelVocab`, `vocabOfKind`, `sizeMeta`, `dpiDots` (`lib/labels.ts`); `ComboBox`; `Switch`.
- Produces:
  ```tsx
  export default function PrintSettingsModal(props: {
    settings: PrintSettings;
    onChange: (next: PrintSettings) => void;     // page persists via writePrintSettings
    vocab: LabelVocab[];                         // sizes + dpi
    printerConnected: boolean;
    onPrintAlignmentTest: (zpl: string, sizeLabel: string) => Promise<void>;
    onClose: () => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/components/labels/PrintSettingsModal.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../../lib/api';
import { DEFAULT_PRINT_SETTINGS, type PrintSettings } from '../../lib/printLabels';
import PrintSettingsModal from './PrintSettingsModal';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '2x1', label: '2" x 1"', description: '', meta: { width_in: 2, height_in: 1 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
];

function setup(over: Partial<PrintSettings> = {}, printerConnected = true) {
  const onChange = vi.fn();
  const onPrintAlignmentTest = vi.fn(async () => undefined);
  const onClose = vi.fn();
  const settings = { ...DEFAULT_PRINT_SETTINGS, ...over };
  const view = render(
    <PrintSettingsModal settings={settings} onChange={onChange} vocab={vocab}
                        printerConnected={printerConnected}
                        onPrintAlignmentTest={onPrintAlignmentTest} onClose={onClose} />);
  return { onChange, onPrintAlignmentTest, onClose, view };
}

describe('PrintSettingsModal', () => {
  it('renders the roomy header and every V2 field with its hint', () => {
    setup();
    expect(screen.getByText('Print settings')).toBeTruthy();
    expect(screen.getByText('Print Labels')).toBeTruthy();
    expect(screen.getByLabelText('Vertical offset')).toBeTruthy();
    expect(screen.getByLabelText('Horizontal offset')).toBeTruthy();
    expect(screen.getByLabelText('Copies')).toBeTruthy();
    expect(screen.getByLabelText('Batch size')).toBeTruthy();
    expect(screen.getByLabelText('Blanks between racks')).toBeTruthy();
    expect(screen.getByText('Offset in dots (+ moves down)')).toBeTruthy();
    expect(screen.getByText('Offset in dots (+ moves right)')).toBeTruthy();
    expect(screen.getByText('Labels per batch before pausing')).toBeTruthy();
  });

  it('emits clamped numeric changes on blur and boolean changes immediately', async () => {
    const { onChange } = setup();
    const copies = screen.getByLabelText('Copies') as HTMLInputElement;
    fireEvent.change(copies, { target: { value: '150' } });
    fireEvent.blur(copies);
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PRINT_SETTINGS, copies: 99 });
    const vertical = screen.getByLabelText('Vertical offset') as HTMLInputElement;
    fireEvent.change(vertical, { target: { value: '-12' } });
    fireEvent.blur(vertical);
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PRINT_SETTINGS, verticalOffset: -12 });
    await userEvent.click(screen.getByLabelText('Print by rack'));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PRINT_SETTINGS, printByRack: true });
  });

  it('disables Blanks between racks until Print by rack is on', () => {
    setup();
    expect((screen.getByLabelText('Blanks between racks') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    setup({ printByRack: true });
    expect((screen.getByLabelText('Blanks between racks') as HTMLInputElement).disabled).toBe(false);
  });

  it('Reset is disabled at defaults and restores them when modified', async () => {
    const { onChange } = setup({ copies: 3, printByRack: true });
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(reset);
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_PRINT_SETTINGS);
    cleanup();
    setup();
    expect((screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('prints an alignment test for the chosen size × DPI (default 4x2 @ 300)', async () => {
    const { onPrintAlignmentTest } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(onPrintAlignmentTest).toHaveBeenCalledTimes(1);
    const [zpl, sizeLabel] = onPrintAlignmentTest.mock.calls[0];
    expect(sizeLabel).toBe('4x2');
    expect(zpl).toContain('^PW1200');
    expect(zpl).toContain('^LL600');
    expect(zpl).toContain('ALIGN 4x2 300DPI');
    await userEvent.click(screen.getByRole('tab', { name: '203 DPI' }));
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(onPrintAlignmentTest.mock.calls[1][0]).toContain('^PW812');
  });

  it('gates the alignment test on a connected printer', () => {
    setup({}, false);
    expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connect a printer first')).toBeTruthy();
  });

  it('closes on Done, the × button, and Escape', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/labels/PrintSettingsModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Append the feature CSS to `portal/src/styles/labels.css`**

```css

/* ── Print Labels (/labels/print) — layout + color only; typography rides
   the shared primitives (guardrail: no font-*/line-height/min-height on
   list-ish selectors here). ─────────────────────────────────────────── */
.plabels-head-actions { display: flex; align-items: center; gap: 8px; }
.plabels-gear { position: relative; }
.plabels-gear .plabels-modified {
  position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: 50%;
  background: var(--c-amber); border: 2px solid var(--surface, #fff);
}
/* status strip under the header (V2's dismissible Alert) */
.plabels-notice {
  display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
  padding: 10px 14px; border: 1px solid var(--paper-line); border-radius: 10px;
  background: var(--surface-2, #f5f7fa);
}
.plabels-notice .page-hint { margin: 0; flex: 1; }
.plabels-notice.info { border-color: var(--c-blue-bd, #bcd4f5); background: var(--c-blue-bg, #eef4fd); }
.plabels-notice.success { border-color: var(--c-green-bd, #b7e0c1); background: var(--c-green-bg, #edf8ef); }
.plabels-notice.warning { border-color: var(--c-amber-bd, #efd39a); background: var(--c-amber-bg, #fff7e6); }
.plabels-notice.error { border-color: var(--c-red-bd, #f0b4b4); background: var(--c-red-bg, #fdecec); }
.plabels-notice-actions { display: flex; gap: 6px; }

/* the three-card band (V2's side-by-side cards) */
.plabels-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
@media (max-width: 1100px) { .plabels-steps { grid-template-columns: 1fr; } }
.plabels-step {
  display: flex; flex-direction: column; gap: 12px; min-width: 0;
  padding: 18px 22px; border: 1px solid var(--paper-line); border-radius: 12px;
  background: var(--surface-2, #f5f7fa);
}
.plabels-step-head { display: flex; flex-direction: column; gap: 4px; }
.plabels-step-head .eyebrow, .plabels-step-head .modal-section { margin: 0; }
.plabels-step-head .page-hint { margin: 2px 0 0; }
.plabels-step-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.plabels-step-body .rgm-choice-cards { display: grid; grid-template-columns: 1fr; gap: 8px; margin: 0; }
.plabels-summary-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.plabels-zpl { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--paper-line); border-radius: 8px; background: var(--surface, #fff); resize: vertical; }
/* printer card */
.plabels-printer-status { display: flex; align-items: center; gap: 10px; }
.plabels-printer-status .dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.plabels-printer-status .dot.on { background: var(--c-green); }
.plabels-printer-status .dot.off { background: var(--c-red); }

/* full-width cards: assets + ready-to-print */
.plabels-card {
  display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;
  padding: 18px 22px; border: 1px solid var(--paper-line); border-radius: 12px;
  background: var(--surface-2, #f5f7fa);
}
.plabels-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.plabels-card-head .modal-section { margin: 0; }
.plabels-list-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.plabels-list-tools .dir-search { flex: 0 1 360px; }
.plabels-list-tools .spacer { flex: 1; }
.plabels-ready { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.plabels-ready-text { display: flex; flex-direction: column; gap: 2px; }
.plabels-ready-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.plabels-ready-chips { display: flex; gap: 6px; flex-wrap: wrap; }

/* Print settings modal — two content-sized columns; ComboBox lists overlay */
.modal-card.reports-modal-card.rgm-card.plabels-settings-card {
  width: min(900px, 96vw); max-width: 96vw; overflow: visible; max-height: none;
}
.plabels-settings-grid { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(300px, 1fr); gap: 12px 36px; align-items: start; }
@media (max-width: 760px) { .plabels-settings-grid { grid-template-columns: 1fr; } }
.plabels-settings-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.plabels-settings-col .modal-section { margin: 0; }
.plabels-settings-col .page-hint { margin: 0; }
.plabels-settings-form { grid-template-columns: 1fr 1fr; gap: 12px 18px; }
.plabels-settings-form .field-hint { margin: 4px 0 0; }
.plabels-align { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--paper-line); border-radius: 10px; background: var(--surface, #fff); }
.plabels-align-controls { display: grid; grid-template-columns: minmax(160px, 1fr) auto; gap: 10px; align-items: center; }
.plabels-align-actions { display: flex; align-items: center; gap: 10px; }

/* Printing labels (batch) modal */
.modal-card.reports-modal-card.rgm-card.plabels-batch-card { width: min(720px, 96vw); max-width: 96vw; }
.plabels-batch-headline { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 4px 0 12px; }
.plabels-batch-headline .dash-kpi-value { color: var(--accent); }
.plabels-batch-headline.done .dash-kpi-value { color: var(--c-green); }
.plabels-progress { height: 10px; border-radius: 5px; background: var(--c-blue-bg, #eef4fd); overflow: hidden; margin-bottom: 14px; }
.plabels-progress-fill { height: 100%; background: var(--accent); border-radius: inherit; transition: width 200ms ease; }
.plabels-progress-fill.done { background: var(--c-green); }
.plabels-batch-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 12px; }
.plabels-batch-toggle { display: flex; justify-content: center; margin-bottom: 8px; }
.plabels-batch-status { display: flex; align-items: center; gap: 10px; }

/* Offline cache modal */
.modal-card.reports-modal-card.rgm-card.plabels-cache-card { width: min(860px, 96vw); max-width: 96vw; }
.plabels-cache-download { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--paper-line); border-radius: 10px; background: var(--surface, #fff); }
.plabels-cache-types { display: flex; gap: 14px; flex-wrap: wrap; }
.plabels-cache-types label { display: inline-flex; align-items: center; gap: 6px; }
.plabels-cache-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
```

Then run the guardrail: `npx vitest run src/styles/listTypography.test.ts` — must stay green (none of the rules above set font-*/line-height/min-height on list-ish selectors; `.plabels-list-tools .dir-search` sets only flex).

- [ ] **Step 4: Implement the modal**

```tsx
// portal/src/components/labels/PrintSettingsModal.tsx
/**
 * Print Labels › Print settings — V2's settings dialog (offsets, copies,
 * batch size, Print by rack + blanks, alignment test) in the roomy
 * report-modal shape, sized to its two columns. Changes apply
 * immediately through `onChange` (the page persists them); numeric
 * fields keep free text while editing and clamp on blur, like
 * BulkContainersModal's Count field. The alignment test takes any
 * active size at 203 or 300 DPI (V2's fixed 1×2 / 2×4 buttons were
 * 2"×1" and 4"×2" at 300).
 */
import { useEffect, useMemo, useState } from 'react';

import type { LabelVocab } from '../../lib/api';
import { dpiDots, sizeMeta, vocabOfKind } from '../../lib/labels';
import {
  DEFAULT_PRINT_SETTINGS, alignmentTestZpl, clampSetting, settingsModified,
  type NumericSetting, type PrintSettings,
} from '../../lib/printLabels';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';

const DEFAULT_SIZE = '4x2';
const DEFAULT_DPI = '300';

interface Props {
  settings: PrintSettings;
  onChange: (next: PrintSettings) => void;
  vocab: LabelVocab[];
  printerConnected: boolean;
  onPrintAlignmentTest: (zpl: string, sizeLabel: string) => Promise<void>;
  onClose: () => void;
}

const NUMERIC_FIELDS: { key: NumericSetting; label: string; hint: string; suffix?: string }[] = [
  { key: 'verticalOffset', label: 'Vertical offset', hint: 'Offset in dots (+ moves down)', suffix: 'dots' },
  { key: 'horizontalOffset', label: 'Horizontal offset', hint: 'Offset in dots (+ moves right)', suffix: 'dots' },
  { key: 'copies', label: 'Copies', hint: 'Number of copies per label' },
  { key: 'batchSize', label: 'Batch size', hint: 'Labels per batch before pausing' },
];

export default function PrintSettingsModal({
  settings, onChange, vocab, printerConnected, onPrintAlignmentTest, onClose,
}: Props) {
  // Free text per numeric field so a value can be emptied/retyped; the
  // clamped number lands in `settings` on blur.
  const [text, setText] = useState<Record<NumericSetting, string>>({
    verticalOffset: String(settings.verticalOffset),
    horizontalOffset: String(settings.horizontalOffset),
    copies: String(settings.copies),
    batchSize: String(settings.batchSize),
    blanksBetweenRacks: String(settings.blanksBetweenRacks),
  });
  const [sizeKey, setSizeKey] = useState(DEFAULT_SIZE);
  const [dpiKey, setDpiKey] = useState(DEFAULT_DPI);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sizes = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);
  const dpis = useMemo(() => vocabOfKind(vocab, 'dpi'), [vocab]);
  const sizeOptions = sizes.map((s) => ({ value: s.key, label: s.label }));
  const effectiveSize = sizes.find((s) => s.key === sizeKey) ?? sizes[0] ?? null;
  const effectiveDpi = dpis.some((d) => d.key === dpiKey) ? dpiKey : (dpis[0]?.key ?? DEFAULT_DPI);

  const commit = (key: NumericSetting) => {
    const value = clampSetting(key, text[key]);
    setText((t) => ({ ...t, [key]: String(value) }));
    if (value !== settings[key]) onChange({ ...settings, [key]: value });
  };

  const reset = () => {
    setText({
      verticalOffset: '0', horizontalOffset: '0', copies: '1',
      batchSize: String(DEFAULT_PRINT_SETTINGS.batchSize),
      blanksBetweenRacks: String(DEFAULT_PRINT_SETTINGS.blanksBetweenRacks),
    });
    onChange({ ...DEFAULT_PRINT_SETTINGS });
  };

  const printTest = async () => {
    if (!effectiveSize) return;
    const dots = dpiDots(vocab, effectiveDpi);
    const { width_in, height_in } = sizeMeta(effectiveSize);
    const zpl = alignmentTestZpl(Math.round(width_in * dots), Math.round(height_in * dots), effectiveSize.key, dots);
    setTesting(true);
    try {
      await onPrintAlignmentTest(zpl, effectiveSize.key);
    } finally {
      setTesting(false);
    }
  };

  const numberField = (f: { key: NumericSetting; label: string; hint: string; suffix?: string }, disabled = false) => (
    <div key={f.key}>
      <label htmlFor={`ps-${f.key}`}>{f.label}{f.suffix ? ` (${f.suffix})` : ''}</label>
      <input id={`ps-${f.key}`} type="number" aria-label={f.label} disabled={disabled}
             value={text[f.key]} onChange={(e) => setText((t) => ({ ...t, [f.key]: e.target.value }))}
             onBlur={() => commit(f.key)}
             onKeyDown={(e) => { if (e.key === 'Enter') commit(f.key); }} />
      <p className="page-hint field-hint">{f.hint}</p>
    </div>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card plabels-settings-card" role="dialog" aria-label="Print settings">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Print Labels</div>
            <h3>Print settings</h3>
            <p className="page-hint">
              Offsets and copies apply to every label sent from this page. Settings are kept on this computer.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="plabels-settings-grid">
            <section className="plabels-settings-col" aria-label="Placement and copies">
              <div className="modal-section">Placement &amp; copies</div>
              <div className="pf-form plabels-settings-form">
                {NUMERIC_FIELDS.map((f) => numberField(f))}
              </div>
            </section>
            <section className="plabels-settings-col" aria-label="Rack order and alignment">
              <div className="modal-section">Rack order</div>
              <label className="mini-row report-section-row" aria-label="Print by rack">
                <Switch checked={settings.printByRack}
                        onChange={(v) => onChange({ ...settings, printByRack: v })} />
                <span className="report-section-text">
                  <span className="cell-top">Print by rack</span>
                  <span className="cell-sub">
                    Prints in rack order (RU top-down within each rack) and feeds blank labels between racks.
                  </span>
                </span>
              </label>
              <div className="pf-form plabels-settings-form">
                {numberField({ key: 'blanksBetweenRacks', label: 'Blanks between racks', hint: 'Blank labels fed when the rack changes' }, !settings.printByRack)}
              </div>
              <div className="modal-section">Alignment test</div>
              <div className="plabels-align">
                <p className="page-hint">
                  Prints concentric boxes 25 dots apart so you can dial in the offsets above.
                  Current offsets apply; copies are ignored.
                </p>
                <div className="plabels-align-controls">
                  <ComboBox options={sizeOptions} value={effectiveSize?.key ?? ''} onChange={setSizeKey}
                            placeholder="Label size…" />
                  <div className="segmented" role="tablist" aria-label="Printer DPI">
                    {dpis.map((d) => (
                      <button key={d.key} type="button" role="tab" aria-selected={effectiveDpi === d.key}
                              className={effectiveDpi === d.key ? 'on' : ''} onClick={() => setDpiKey(d.key)}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="plabels-align-actions">
                  <button type="button" className="mini-btn" disabled={!printerConnected || testing || !effectiveSize}
                          onClick={() => void printTest()}>
                    {testing ? 'Sending…' : 'Print test label'}
                  </button>
                  {!printerConnected && <span className="cell-sub">Connect a printer first</span>}
                </div>
              </div>
            </section>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="mini-btn" onClick={reset} disabled={!settingsModified(settings)}>Reset</button>
          <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
```

Aria note: the outer `<label className="mini-row …" aria-label="Print by rack">` is what `getByLabelText('Print by rack')` finds (its text content also includes the description, so the aria-label is required); clicking it toggles the nested checkbox the `Switch` renders.

- [ ] **Step 5: Run the tests and the guardrail**

Run: `npx vitest run src/components/labels/PrintSettingsModal.test.tsx src/styles/listTypography.test.ts`
Expected: all passed.

- [ ] **Step 6: Commit**

```bash
git add portal/src/components/labels/PrintSettingsModal.tsx portal/src/components/labels/PrintSettingsModal.test.tsx portal/src/styles/labels.css
git commit -m "feat(portal): Print settings modal (offsets, copies, batch size, print by rack, alignment test) + Print Labels CSS

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Printing labels (batch) modal

**Files:**
- Create: `portal/src/components/labels/PrintBatchModal.tsx`
- Test: `portal/src/components/labels/PrintBatchModal.test.tsx`

**Interfaces:**
- Produces a presentational modal driven by the page's batch state (Task 11 owns the state machine):
  ```tsx
  export interface BatchPrintState {
    total: number; batchSize: number; currentBatch: number; totalBatches: number;
    printedCount: number; printing: boolean; finishing: boolean;   // finishing = sent, waiting for ~HS idle
    batchComplete: boolean; allComplete: boolean;
    autoPrintNext: boolean; autoCountdown: number | null; error: string | null;
  }
  export default function PrintBatchModal(props: {
    state: BatchPrintState;
    subtitle: string;                              // "<Initiative> · <Label type> · N labels in K batches of B"
    onAutoPrintNextChange: (v: boolean) => void;
    onPrintNext: () => void; onReprint: () => void; onCancel: () => void; onDone: () => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/components/labels/PrintBatchModal.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PrintBatchModal, { type BatchPrintState } from './PrintBatchModal';

afterEach(cleanup);

const base: BatchPrintState = {
  total: 120, batchSize: 50, currentBatch: 1, totalBatches: 3, printedCount: 0,
  printing: true, finishing: false, batchComplete: false, allComplete: false,
  autoPrintNext: false, autoCountdown: null, error: null,
};

function setup(over: Partial<BatchPrintState> = {}) {
  const handlers = {
    onAutoPrintNextChange: vi.fn(), onPrintNext: vi.fn(), onReprint: vi.fn(), onCancel: vi.fn(), onDone: vi.fn(),
  };
  render(<PrintBatchModal state={{ ...base, ...over }} subtitle="NAP11 · Top Label · 120 labels in 3 batches of 50" {...handlers} />);
  return handlers;
}

describe('PrintBatchModal', () => {
  it('shows progress, batch figures, and the sending status while printing', () => {
    setup({ printedCount: 12 });
    expect(screen.getByText('Printing labels')).toBeTruthy();
    expect(screen.getByText('12 of 120')).toBeTruthy();
    expect(screen.getByText('Printing batch 1 of 3…')).toBeTruthy();
    expect(screen.getByText('Current batch').parentElement?.textContent).toContain('1');
    expect(screen.getByText('Per batch').parentElement?.textContent).toContain('50');
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Print next batch/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('progressbar') as HTMLElement).getAttribute('aria-valuenow')).toBe('10');
  });

  it('says it is waiting for the printer once the batch is sent', () => {
    setup({ finishing: true });
    expect(screen.getByText('Batch 1 sent - waiting for printer to finish printing…')).toBeTruthy();
  });

  it('offers next / reprint / cancel when a batch completes', async () => {
    const h = setup({ printing: false, batchComplete: true, printedCount: 50 });
    expect(screen.getByText('Batch 1 complete! Ready to print next batch.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Print next batch (50 labels)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reprint current batch' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onPrintNext).toHaveBeenCalledTimes(1);
    expect(h.onReprint).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('labels the last batch with the remaining count and shows the countdown', () => {
    setup({ printing: false, batchComplete: true, printedCount: 100, currentBatch: 2, autoPrintNext: true, autoCountdown: 3 });
    expect(screen.getByRole('button', { name: 'Print next batch (20 labels)' })).toBeTruthy();
    expect(screen.getByText('Batch 2 complete! Next batch starts automatically in 3s… (turn off the toggle to pause)')).toBeTruthy();
  });

  it('toggles auto print next batch', async () => {
    const h = setup({ printing: false, batchComplete: true, printedCount: 50 });
    await userEvent.click(screen.getByLabelText('Auto print next batch (5 s delay)'));
    expect(h.onAutoPrintNextChange).toHaveBeenCalledWith(true);
  });

  it('shows Done only when everything printed, and hides the toggle', async () => {
    const h = setup({ printing: false, batchComplete: true, allComplete: true, printedCount: 120, currentBatch: 3 });
    expect(screen.getByText('All 120 labels printed successfully!')).toBeTruthy();
    expect(screen.queryByLabelText('Auto print next batch (5 s delay)')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows a batch error and ignores Escape while printing', () => {
    const h = setup({ error: 'Batch 1 failed: Printer connection lost. Please reconnect.' });
    expect(screen.getByText('Batch 1 failed: Printer connection lost. Please reconnect.')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onCancel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/labels/PrintBatchModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// portal/src/components/labels/PrintBatchModal.tsx
/**
 * Print Labels › Printing labels — V2's batch dialog: "X of N" headline,
 * progress bar, current/total/per-batch tiles, the auto-print toggle with
 * its 5 s countdown, V2's status lines, and Cancel / Reprint current batch
 * / Print next batch / Done. Purely presentational: the page owns the
 * state machine (`BatchPrintState`) and the printer. Not dismissable
 * while printing (no scrim click, no Escape).
 */
import { useEffect } from 'react';

import { Switch } from '../Switch';

export interface BatchPrintState {
  total: number;
  batchSize: number;
  currentBatch: number;
  totalBatches: number;
  printedCount: number;
  printing: boolean;
  finishing: boolean;
  batchComplete: boolean;
  allComplete: boolean;
  autoPrintNext: boolean;
  autoCountdown: number | null;
  error: string | null;
}

interface Props {
  state: BatchPrintState;
  subtitle: string;
  onAutoPrintNextChange: (v: boolean) => void;
  onPrintNext: () => void;
  onReprint: () => void;
  onCancel: () => void;
  onDone: () => void;
}

export default function PrintBatchModal({
  state, subtitle, onAutoPrintNextChange, onPrintNext, onReprint, onCancel, onDone,
}: Props) {
  const {
    total, batchSize, currentBatch, totalBatches, printedCount, printing, finishing,
    batchComplete, allComplete, autoPrintNext, autoCountdown, error,
  } = state;
  const pct = total > 0 ? Math.round((printedCount / total) * 100) : 0;
  const nextCount = Math.min(batchSize, total - printedCount);

  // Escape cancels only between batches — V2's dialog can't be dismissed mid-print.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !printing && !allComplete) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [printing, allComplete, onCancel]);

  return (
    <div className="modal-scrim">
      <div className="modal-card reports-modal-card rgm-card plabels-batch-card" role="dialog" aria-label="Printing labels">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Print Labels</div>
            <h3>Printing labels</h3>
            <p className="page-hint">{subtitle}</p>
          </div>
        </div>
        <div className="modal-body">
          <div className={`plabels-batch-headline dash-kpi ${allComplete ? 'done' : ''}`}>
            <span className="dash-kpi-value">{printedCount} of {total}</span>
            <span className="dash-kpi-label">labels printed</span>
          </div>
          <div className="plabels-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={`plabels-progress-fill ${allComplete ? 'done' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="dash-kpis plabels-batch-kpis">
            <div className="dash-kpi"><span className="dash-kpi-label">Current batch</span><span className="dash-kpi-value">{currentBatch}</span></div>
            <div className="dash-kpi"><span className="dash-kpi-label">Total batches</span><span className="dash-kpi-value">{totalBatches}</span></div>
            <div className="dash-kpi"><span className="dash-kpi-label">Per batch</span><span className="dash-kpi-value">{batchSize}</span></div>
          </div>

          {!allComplete && (
            <div className="plabels-batch-toggle">
              <label className="mini-row report-section-row" aria-label="Auto print next batch (5 s delay)">
                <Switch checked={autoPrintNext} onChange={onAutoPrintNextChange} />
                <span className="report-section-text">
                  <span className="cell-top">Auto print next batch (5 s delay)</span>
                </span>
              </label>
            </div>
          )}

          {printing && (
            <div className="plabels-notice info plabels-batch-status">
              <p className="page-hint">
                {finishing
                  ? `Batch ${currentBatch} sent - waiting for printer to finish printing…`
                  : `Printing batch ${currentBatch} of ${totalBatches}…`}
              </p>
            </div>
          )}
          {batchComplete && !allComplete && !printing && (
            <div className={`plabels-notice ${autoCountdown !== null ? 'info' : 'success'}`}>
              <p className="page-hint">
                {autoCountdown !== null
                  ? `Batch ${currentBatch} complete! Next batch starts automatically in ${autoCountdown}s… (turn off the toggle to pause)`
                  : `Batch ${currentBatch} complete! Ready to print next batch.`}
              </p>
            </div>
          )}
          {allComplete && (
            <div className="plabels-notice success">
              <p className="page-hint">All {total} labels printed successfully!</p>
            </div>
          )}
          {error && (
            <div className="plabels-notice error">
              <p className="page-hint">{error}</p>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {allComplete ? (
            <button type="button" className="btn-solid" onClick={onDone}>Done</button>
          ) : (
            <>
              <button type="button" className="mini-btn" onClick={onCancel} disabled={printing}>Cancel</button>
              <button type="button" className="mini-btn" onClick={onReprint} disabled={printing || !batchComplete}>
                Reprint current batch
              </button>
              <button type="button" className="btn-solid" onClick={onPrintNext} disabled={printing || !batchComplete}>
                {printing ? 'Printing…' : `Print next batch (${nextCount} labels)`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and the guardrail**

Run: `npx vitest run src/components/labels/PrintBatchModal.test.tsx src/styles/listTypography.test.ts`
Expected: all passed. (Guardrail check d: every text inside the `mini-row` carries `cell-top` — it does.)

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/labels/PrintBatchModal.tsx portal/src/components/labels/PrintBatchModal.test.tsx
git commit -m "feat(portal): Printing labels batch modal (progress, batches, auto-next countdown, reprint)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Offline cache modal

**Files:**
- Create: `portal/src/components/labels/OfflineCacheModal.tsx`
- Test: `portal/src/components/labels/OfflineCacheModal.test.tsx`

**Interfaces:**
- Consumes: `CachedBundle` (Task 6), `relativeTime` (`lib/format.ts`), `DataTable`.
- Produces (the page owns the cache calls so this stays presentational + testable):
  ```tsx
  export default function OfflineCacheModal(props: {
    bundles: CachedBundle[];                                  // from labelCache.listBundles()
    selectedInitiative: { id: string; name: string } | null;  // the page's current initiative
    labelTypes: { key: string; label: string }[];             // asset label types (vocab, no Custom)
    downloading: boolean;
    downloadStatus: string | null;                            // "Cached 3 types · 555 labels" / error text
    onDownload: (labelTypes: string[]) => Promise<void>;
    onRemove: (initiativeId: string, labelType: string) => Promise<void>;
    onClearAll: () => Promise<void>;
    onClose: () => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/components/labels/OfflineCacheModal.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CachedBundle } from '../../lib/labelCache';
import OfflineCacheModal from './OfflineCacheModal';

afterEach(cleanup);

const bundle = (initiative_id: string, initiative_name: string, label_type: string, n: number): CachedBundle => ({
  initiative_id, initiative_name, label_type, fetched_at: '2026-09-12T00:00:00Z',
  cached_at: new Date(Date.now() - 120_000).toISOString(),
  labels: Array.from({ length: n }, (_, i) => ({
    id: `${label_type}${i}`, entity_type: 'asset', entity_id: `a${i}`, template_id: 't', template_name: 'T',
    template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false,
    generated_at: '2026-09-12T00:00:00Z', code: '^XA^XZ',
  })),
});

const TYPES = [{ key: 'top', label: 'Top Label' }, { key: 'front', label: 'Front Label' }];

function setup(over: Partial<Parameters<typeof OfflineCacheModal>[0]> = {}) {
  const h = {
    onDownload: vi.fn(async () => undefined), onRemove: vi.fn(async () => undefined),
    onClearAll: vi.fn(async () => undefined), onClose: vi.fn(),
  };
  render(<OfflineCacheModal bundles={[bundle('i1', 'NAP11', 'top', 185), bundle('i2', 'NAP22', 'front', 3)]}
                            selectedInitiative={{ id: 'i1', name: 'NAP11' }} labelTypes={TYPES}
                            downloading={false} downloadStatus={null} {...h} {...over} />);
  return h;
}

describe('OfflineCacheModal', () => {
  it('lists cached bundles with counts and ages, and removes one', async () => {
    const h = setup();
    expect(screen.getByText('Offline labels')).toBeTruthy();
    expect(screen.getByText('NAP11')).toBeTruthy();
    expect(screen.getByText('185')).toBeTruthy();
    expect(screen.getAllByText('2m ago').length).toBe(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(h.onRemove).toHaveBeenCalledWith('i2', 'front');
  });

  it('downloads the checked label types for the selected initiative', async () => {
    const h = setup();
    expect(screen.getByText('Download for NAP11')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Front Label'));   // Top is checked by default (all types)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(h.onDownload).toHaveBeenCalledWith(['top']);
  });

  it('shows the download status and disables Download while downloading', () => {
    setup({ downloading: true, downloadStatus: 'Cached 2 types · 370 labels' });
    expect(screen.getByText('Cached 2 types · 370 labels')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Downloading…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks before clearing everything', async () => {
    const h = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(h.onClearAll).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, clear the cache' }));
    expect(h.onClearAll).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and hides the download row without a selected initiative', () => {
    setup({ bundles: [], selectedInitiative: null });
    expect(screen.getByText('Nothing cached yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(screen.getByText('Pick an initiative on the page to download its labels.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/labels/OfflineCacheModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// portal/src/components/labels/OfflineCacheModal.tsx
/**
 * Print Labels › Offline labels — what the IndexedDB cache holds (one row
 * per initiative + label type), a Download row for the initiative picked
 * on the page, and Clear all. Presentational: the page performs the cache
 * and API calls and passes the results back in.
 */
import { useEffect, useMemo, useState } from 'react';

import { relativeTime } from '../../lib/format';
import type { CachedBundle } from '../../lib/labelCache';
import DataTable from '../DataTable';

interface Props {
  bundles: CachedBundle[];
  selectedInitiative: { id: string; name: string } | null;
  labelTypes: { key: string; label: string }[];
  downloading: boolean;
  downloadStatus: string | null;
  onDownload: (labelTypes: string[]) => Promise<void>;
  onRemove: (initiativeId: string, labelType: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onClose: () => void;
}

export default function OfflineCacheModal({
  bundles, selectedInitiative, labelTypes, downloading, downloadStatus,
  onDownload, onRemove, onClearAll, onClose,
}: Props) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(labelTypes.map((t) => t.key)));
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !downloading) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, downloading]);

  const typeLabel = (key: string) => labelTypes.find((t) => t.key === key)?.label ?? key;

  const rows = useMemo(() => [...bundles]
    .sort((a, b) => a.initiative_name.localeCompare(b.initiative_name) || a.label_type.localeCompare(b.label_type))
    .map((b) => ({
      key: `${b.initiative_id}:${b.label_type}`,
      cells: [
        <b className="cell-top" key="n">{b.initiative_name}</b>,
        <span className="chip tag" key="t">{typeLabel(b.label_type)}</span>,
        <span className="mono" key="c">{b.labels.length}</span>,
        <span className="mono" key="d">{relativeTime(b.cached_at)}</span>,
        <button type="button" className="mini-btn" key="r" disabled={downloading}
                onClick={() => void onRemove(b.initiative_id, b.label_type)}>Remove</button>,
      ],
    })), [bundles, downloading, labelTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const totalLabels = bundles.reduce((n, b) => n + b.labels.length, 0);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !downloading) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card plabels-cache-card" role="dialog" aria-label="Offline labels">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Print Labels</div>
            <h3>Offline labels</h3>
            <p className="page-hint">
              Labels downloaded here print even when the network is down. Every initiative you open online is cached automatically.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={downloading}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">Cached bundles</div>
          {bundles.length === 0
            ? <div className="dir-empty">Nothing cached yet.</div>
            : (
              <DataTable ariaLabel="Cached label bundles"
                columns={[
                  { key: 'initiative', label: 'Initiative', width: '2fr' },
                  { key: 'type', label: 'Label type', width: '1fr' },
                  { key: 'count', label: 'Labels', width: '0.6fr', align: 'right', mono: true },
                  { key: 'age', label: 'Downloaded', width: '0.8fr', mono: true },
                  { key: 'remove', label: '', width: '0.6fr', align: 'right' },
                ]}
                rows={rows} />
            )}
          <div className="plabels-cache-download" style={{ marginTop: 14 }}>
            {selectedInitiative ? (
              <>
                <div className="modal-section">Download for {selectedInitiative.name}</div>
                <div className="plabels-cache-types">
                  {labelTypes.map((t) => (
                    <label key={t.key}>
                      <input type="checkbox" checked={checked.has(t.key)} disabled={downloading}
                             aria-label={t.label} onChange={() => toggle(t.key)} />
                      <span className="cell-sub">{t.label}</span>
                    </label>
                  ))}
                </div>
                <div className="plabels-cache-actions">
                  <button type="button" className="btn-solid" disabled={downloading || checked.size === 0}
                          onClick={() => void onDownload(labelTypes.map((t) => t.key).filter((k) => checked.has(k)))}>
                    {downloading ? 'Downloading…' : 'Download'}
                  </button>
                  {downloadStatus && <span className="cell-sub">{downloadStatus}</span>}
                </div>
              </>
            ) : (
              <p className="page-hint">Pick an initiative on the page to download its labels.</p>
            )}
          </div>
        </div>
        <div className="modal-foot">
          {confirmClear ? (
            <>
              <span className="cell-sub">Remove all {bundles.length} cached bundles ({totalLabels} labels)?</span>
              <button type="button" className="mini-btn danger" disabled={downloading}
                      onClick={() => { setConfirmClear(false); void onClearAll(); }}>Yes, clear the cache</button>
              <button type="button" className="mini-btn" onClick={() => setConfirmClear(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className="mini-btn danger" disabled={downloading || bundles.length === 0}
                    onClick={() => setConfirmClear(true)}>Clear all</button>
          )}
          <button type="button" className="btn-solid" onClick={onClose} disabled={downloading}>Done</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and the guardrail**

Run: `npx vitest run src/components/labels/OfflineCacheModal.test.tsx src/styles/listTypography.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/labels/OfflineCacheModal.tsx portal/src/components/labels/OfflineCacheModal.test.tsx
git commit -m "feat(portal): Offline labels modal (cached bundles, per-initiative download, clear all)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `PrintAssetList` — selectable, sortable, filterable roster

**Files:**
- Create: `portal/src/components/labels/PrintAssetList.tsx`
- Test: `portal/src/components/labels/PrintAssetList.test.tsx`

**Interfaces:**
- Consumes: `InitiativeAssetRow` (`lib/api`), `LabelStatus` (Task 3), `usePersistentListState`/`ColumnMenu`/`passesColumnFilters`/`EmptyClearFilters`/`FilterSummaryChip`/`CellText` (`lib/columnMenu.tsx`), `ColumnDef`/`ColumnsButton`/`applyColumnOrder`/`visibleColumnsFor`/`useReorderDrag`/`moveKey`/`useSearchHaystacks` (`lib/listTools.tsx`), `VirtualRows` (`lib/virtualRows.tsx`), `naturalCompare` (`lib/sites.ts`), `displayRfid`-style helpers are NOT needed.
- Produces:
  ```tsx
  export type LabelFilter = 'all' | 'ready' | 'missing'
  export const PRINT_LIST_PAGE_KEY = 'labels-print'
  export function assetCellText(row: InitiativeAssetRow, status: LabelStatus | null, key: string): string
  export function sortRows(rows: InitiativeAssetRow[], statusOf: (r) => LabelStatus | null, sortKey: string, sortDir: 1 | -1): InitiativeAssetRow[]
  export default function PrintAssetList(props: {
    rows: InitiativeAssetRow[];
    statusOf: ((row: InitiativeAssetRow) => LabelStatus) | null;   // null for Custom → Label column blank, filter hidden
    selected: string[];                       // asset ids (row.asset_id)
    onSelectedChange: (next: string[]) => void;
    onDisplayedChange: (displayedRows: InitiativeAssetRow[]) => void;  // the sorted+filtered rows in display order (print order source)
    onRefresh: () => void; refreshing: boolean;
    disabled?: boolean;
  }): JSX.Element
  ```
  `usePersistentListState` needs `useAuth`, so the page test (Task 11) and this test must render inside an auth provider or mock `../../auth/AuthContext` — see the test below.

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/components/labels/PrintAssetList.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InitiativeAssetRow } from '../../lib/api';
import type { LabelStatus } from '../../lib/printLabels';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_prefs: {} }, updatePreferences: vi.fn(async () => true) }),
}));

const { default: PrintAssetList, assetCellText, sortRows } = await import('./PrintAssetList');

afterEach(cleanup);

const row = (n: number, over: Partial<InitiativeAssetRow> & { name?: string; serial?: string; make?: string; model?: string } = {}): InitiativeAssetRow => ({
  id: `j${n}`, asset_id: `a${n}`, priority_wave: null, disposition: null, owner: null,
  source_rack: over.source_rack ?? `R${n}`, source_ru: over.source_ru ?? n,
  source_verified: null, source_position: null, destination_rack: null, destination_ru: null,
  destination_verified: null, destination_position: null, cable_info: null, vendor_involved: null,
  status: 'planned', status_label: 'Planned', status_color: '#123456', created_at: '', updated_at: '',
  asset: {
    id: `a${n}`, legacy_id: 38000 + n, serial_number: over.serial ?? `SN${n}`, name: over.name ?? `asset-${n}`,
    rfid_tag: null, model_make: over.make ?? 'Dell', model_name: over.model ?? `R${n}40`, ru_size: 1,
    model_category: null, model_category_label: null, model_category_color: null,
    location_detail: null, client_name: 'Acme', status: 'active', status_label: 'Active', status_color: '#000',
  } as unknown as InitiativeAssetRow['asset'],
});

const ROWS = [row(1), row(2, { source_rack: 'R1', source_ru: 40 }), row(3, { name: 'core-switch', make: 'Cisco' })];
const STATUS: Record<string, LabelStatus> = { a1: 'ready', a2: 'missing', a3: 'stale' };
const statusOf = (r: InitiativeAssetRow) => STATUS[r.asset_id];

function setup(over: Partial<Parameters<typeof PrintAssetList>[0]> = {}) {
  const h = { onSelectedChange: vi.fn(), onDisplayedChange: vi.fn(), onRefresh: vi.fn() };
  const view = render(<PrintAssetList rows={ROWS} statusOf={statusOf} selected={[]} refreshing={false} {...h} {...over} />);
  return { ...h, view };
}

describe('PrintAssetList', () => {
  it('renders V2 columns plus Label status chips', () => {
    setup();
    for (const label of ['Asset ID', 'Name', 'Serial', 'Make', 'Model', 'Source rack', 'RU', 'Status', 'Label']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('38001')).toBeTruthy();
    expect(screen.getByText('core-switch')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Stale')).toBeTruthy();
    expect(screen.getByText('Showing 3 of 3 assets')).toBeTruthy();
  });

  it('row click toggles, header checkbox selects the filtered rows', async () => {
    const h = setup({ selected: ['a1'] });
    await userEvent.click(screen.getByText('core-switch'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['a1', 'a3']);
    await userEvent.click(screen.getByLabelText('Select all filtered assets'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['a1', 'a2', 'a3']);
  });

  it('search narrows rows and select-all then covers only the matches', async () => {
    const h = setup();
    await userEvent.type(screen.getByPlaceholderText('Search assets…'), 'cisco');
    expect(screen.getByText('Showing 1 of 3 assets')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Select all filtered assets'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['a3']);
    expect(h.onDisplayedChange).toHaveBeenLastCalledWith([ROWS[2]]);
  });

  it('Label filter: Ready shows ready + stale, Missing shows missing', async () => {
    setup();
    await userEvent.click(screen.getByRole('tab', { name: 'Ready' }));
    expect(screen.getByText('Showing 2 of 3 assets')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Missing' }));
    expect(screen.getByText('Showing 1 of 3 assets')).toBeTruthy();
    expect(screen.getByText('38002')).toBeTruthy();
  });

  it('hides the Label column and filter for Custom (statusOf null)', () => {
    setup({ statusOf: null });
    expect(screen.queryByRole('tab', { name: 'Ready' })).toBeNull();
    expect(screen.queryByText('Label')).toBeNull();
  });

  it('sorts by rack numeric-aware with RU top-down as the tie-break', () => {
    const rows = [row(1, { source_rack: 'R10', source_ru: 5 }), row(2, { source_rack: 'R2', source_ru: 40 }), row(3, { source_rack: 'R2', source_ru: 42 })];
    expect(sortRows(rows, () => 'ready', 'source_rack', 1).map((r) => r.asset_id)).toEqual(['a3', 'a2', 'a1']);
    expect(sortRows(rows, () => 'ready', 'source_rack', -1).map((r) => r.asset_id)).toEqual(['a1', 'a3', 'a2']);
    expect(sortRows(rows, () => 'ready', 'source_ru', -1).map((r) => r.asset_id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('cell text feeds search/filters for every column', () => {
    const r = ROWS[0];
    expect(assetCellText(r, 'ready', 'asset_id')).toBe('38001');
    expect(assetCellText(r, 'ready', 'name')).toBe('asset-1');
    expect(assetCellText(r, 'ready', 'serial')).toBe('SN1');
    expect(assetCellText(r, 'ready', 'make')).toBe('Dell');
    expect(assetCellText(r, 'ready', 'source_rack')).toBe('R1');
    expect(assetCellText(r, 'ready', 'source_ru')).toBe('1');
    expect(assetCellText(r, 'ready', 'status')).toBe('Planned');
    expect(assetCellText(r, 'stale', 'label')).toBe('Stale');
    expect(assetCellText(r, null, 'label')).toBe('');
  });

  it('shows the empty state with a clear-filters action when a column filter hides everything', async () => {
    setup();
    await userEvent.type(screen.getByPlaceholderText('Search assets…'), 'zzz');
    expect(screen.getByText('No assets match your search')).toBeTruthy();
  });

  it('refresh button calls back and disables while refreshing', async () => {
    const h = setup({ refreshing: true });
    const btn = screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    cleanup();
    const h2 = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(h2.onRefresh).toHaveBeenCalledTimes(1);
    expect(h.onRefresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/labels/PrintAssetList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// portal/src/components/labels/PrintAssetList.tsx
/**
 * Print Labels › Step 4 — the initiative's roster as a selectable
 * directory list: checkbox column (header = select all FILTERED rows,
 * indeterminate when partial; row click toggles), V2's columns (Asset ID,
 * Name, Serial, Make, Model, Source rack, RU, Status) plus a Label status
 * column, V2's Excel-style per-column sort + value filters via
 * `ColumnMenu`, a Ready / Missing filter, search, and persisted column
 * prefs under `labels-print`. Sorting by Source rack is numeric-aware
 * with RU top-down (largest first) as the tie-break — V2's own rule.
 * Selection is by asset id (`row.asset_id`); the parent gets the displayed
 * (sorted + filtered) rows so it can derive the print order.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { InitiativeAssetRow } from '../../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters, usePersistentListState,
  type CellText,
} from '../../lib/columnMenu';
import {
  ColumnsButton, applyColumnOrder, moveKey, useReorderDrag, useSearchHaystacks, visibleColumnsFor,
  type ColumnDef,
} from '../../lib/listTools';
import type { LabelStatus } from '../../lib/printLabels';
import { naturalCompare } from '../../lib/sites';
import { VirtualRows } from '../../lib/virtualRows';
import '../../styles/directory.css';

export const PRINT_LIST_PAGE_KEY = 'labels-print';

export type LabelFilter = 'all' | 'ready' | 'missing';

const COLUMNS: ColumnDef[] = [
  { key: 'asset_id', label: 'Asset ID', width: '90px', default: true },
  { key: 'name', label: 'Name', width: 'minmax(160px, 1.6fr)', default: true },
  { key: 'serial', label: 'Serial', width: 'minmax(120px, 1fr)', default: true },
  { key: 'make', label: 'Make', width: 'minmax(90px, 0.8fr)', default: true },
  { key: 'model', label: 'Model', width: 'minmax(110px, 1fr)', default: true },
  { key: 'source_rack', label: 'Source rack', width: 'minmax(100px, 0.9fr)', default: true },
  { key: 'source_ru', label: 'RU', width: '64px', default: true },
  { key: 'status', label: 'Status', width: 'minmax(110px, 0.9fr)', default: true },
  { key: 'label', label: 'Label', width: '110px', default: true },
];
const ALL_KEYS = new Set(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set(COLUMNS.filter((c) => c.default).map((c) => c.key));

const STATUS_LABEL: Record<LabelStatus, string> = { ready: 'Ready', stale: 'Stale', missing: 'Missing', unsupported: 'Unsupported' };
const STATUS_CHIP: Record<LabelStatus, string> = { ready: 'c-green', stale: 'c-amber', missing: 'c-slate', unsupported: 'c-red' };

export function assetCellText(row: InitiativeAssetRow, status: LabelStatus | null, key: string): string {
  switch (key) {
    case 'asset_id': return row.asset.legacy_id != null ? String(row.asset.legacy_id) : '';
    case 'name': return row.asset.name ?? '';
    case 'serial': return row.asset.serial_number ?? '';
    case 'make': return row.asset.model_make ?? '';
    case 'model': return row.asset.model_name ?? '';
    case 'source_rack': return row.source_rack ?? '';
    case 'source_ru': return row.source_ru != null ? String(row.source_ru) : '';
    case 'status': return row.status_label ?? '';
    case 'label': return status ? STATUS_LABEL[status] : '';
    default: return '';
  }
}

/** Sort with V2's rack rule: rack compare is numeric-aware and, within the
 *  same rack, RU descends regardless of direction (V2's secondaryCompare). */
export function sortRows(
  rows: InitiativeAssetRow[], statusOf: (r: InitiativeAssetRow) => LabelStatus | null,
  sortKey: string, sortDir: 1 | -1,
): InitiativeAssetRow[] {
  const numeric = sortKey === 'source_ru' || sortKey === 'asset_id';
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (numeric) {
      const va = sortKey === 'source_ru' ? (a.source_ru ?? -Infinity) : (a.asset.legacy_id ?? -Infinity);
      const vb = sortKey === 'source_ru' ? (b.source_ru ?? -Infinity) : (b.asset.legacy_id ?? -Infinity);
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    } else {
      cmp = naturalCompare(assetCellText(a, statusOf(a), sortKey), assetCellText(b, statusOf(b), sortKey));
    }
    if (cmp !== 0) return cmp * sortDir;
    if (sortKey === 'source_rack') return (b.source_ru ?? 0) - (a.source_ru ?? 0);
    return 0;
  });
}

interface Props {
  rows: InitiativeAssetRow[];
  statusOf: ((row: InitiativeAssetRow) => LabelStatus) | null;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
  onDisplayedChange: (displayed: InitiativeAssetRow[]) => void;
  onRefresh: () => void;
  refreshing: boolean;
  disabled?: boolean;
}

export default function PrintAssetList({
  rows, statusOf, selected, onSelectedChange, onDisplayedChange, onRefresh, refreshing, disabled = false,
}: Props) {
  const [query, setQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState<LabelFilter>('all');
  const headerRef = useRef<HTMLInputElement>(null);
  const {
    visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters, colOrder, setColOrder,
  } = usePersistentListState(PRINT_LIST_PAGE_KEY, { visible: DEFAULT_VISIBLE, sortKey: 'source_rack', sortDir: 1 }, ALL_KEYS);

  const status = (r: InitiativeAssetRow): LabelStatus | null => (statusOf ? statusOf(r) : null);
  const cellText: CellText<InitiativeAssetRow> = (r, key) => assetCellText(r, status(r), key);
  const haystack = useSearchHaystacks(rows, (r) =>
    ['asset_id', 'name', 'serial', 'make', 'model'].map((k) => assetCellText(r, null, k)).join(' ').toLowerCase());

  const displayed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (statusOf && labelFilter !== 'all') {
        const s = statusOf(r);
        const printable = s === 'ready' || s === 'stale';
        if (labelFilter === 'ready' ? !printable : printable) return false;
      }
      if (!passesColumnFilters(r, filters, cellText)) return false;
      return !q || haystack(r).includes(q);
    });
    return sortRows(filtered, status, sortKey, sortDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, statusOf, labelFilter, filters, query, sortKey, sortDir, haystack]);

  useEffect(() => { onDisplayedChange(displayed); }, [displayed]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayedIds = useMemo(() => displayed.map((r) => r.asset_id), [displayed]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedInDisplayed = displayedIds.filter((id) => selectedSet.has(id));
  const allSelected = displayedIds.length > 0 && selectedInDisplayed.length === displayedIds.length;
  const someSelected = selectedInDisplayed.length > 0 && !allSelected;
  useEffect(() => { if (headerRef.current) headerRef.current.indeterminate = someSelected; }, [someSelected]);

  const toggleOne = (id: string) =>
    onSelectedChange(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  // V2 semantics: select-all REPLACES the selection with the filtered rows; unchecking clears it.
  const toggleAll = () => onSelectedChange(allSelected ? [] : displayedIds);

  const orderedCols = applyColumnOrder(COLUMNS.filter((c) => statusOf || c.key !== 'label'), colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid: CSSProperties = { gridTemplateColumns: `32px ${shownCols.map((c) => c.width).join(' ')}` };
  const caret = (key: string) => (sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null);

  const cell = (r: InitiativeAssetRow, key: string) => {
    const text = cellText(r, key);
    switch (key) {
      case 'name': return <div className="pn"><b>{text || '—'}</b></div>;
      case 'asset_id': case 'serial': case 'source_rack': case 'source_ru':
        return <span className="mono">{text || '—'}</span>;
      case 'status':
        return <span className="chip custom" style={{ '--chip': r.status_color } as CSSProperties}><span className="dot" />{text}</span>;
      case 'label': {
        const s = status(r);
        return s ? <span className={`chip ${STATUS_CHIP[s]}`}>{STATUS_LABEL[s]}</span> : null;
      }
      default: return <span className="cell-sub">{text || '—'}</span>;
    }
  };

  return (
    <div className="plabels-list">
      <div className="plabels-list-tools">
        <div className="dir-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="Search assets…" value={query} disabled={disabled} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {selected.length > 0 && <span className="chip tag">{selected.length} selected</span>}
        {statusOf && (
          <div className="segmented" role="tablist" aria-label="Label status filter">
            {(['all', 'ready', 'missing'] as LabelFilter[]).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={labelFilter === f}
                      className={labelFilter === f ? 'on' : ''} onClick={() => setLabelFilter(f)}>
                {f === 'all' ? 'All' : f === 'ready' ? 'Ready' : 'Missing'}
              </button>
            ))}
          </div>
        )}
        <FilterSummaryChip filters={filters} onClear={clearFilters} />
        <span className="spacer" />
        <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                       onReorder={setColOrder} />
        <button type="button" className="mini-btn" onClick={onRefresh} disabled={refreshing || disabled}>Refresh</button>
      </div>

      <div className="dir-list" role="list" aria-label="Assets">
        <div className="list-head" style={grid}>
          <span className="col-head">
            <input type="checkbox" ref={headerRef} checked={allSelected} disabled={disabled || displayedIds.length === 0}
                   aria-label="Select all filtered assets" onChange={toggleAll} />
          </span>
          {shownCols.map((c) => (
            <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`} {...headerDrag.dragProps(c.key)}>
              <button className="sortable" onClick={() => toggleSort(c.key)}>{c.label} {caret(c.key)}</button>
              <ColumnMenu colKey={c.key} label={c.label} allRows={rows} filters={filters} text={cellText}
                          filter={filters[c.key]} onFilter={setFilter}
                          sortDir={sortKey === c.key ? sortDir : null} onSort={(dir) => setSort(c.key, dir)} />
            </span>
          ))}
        </div>

        {displayed.length === 0 && (
          <div className="dir-empty">
            {query ? 'No assets match your search' : 'No assets match the active filters'}
            <EmptyClearFilters filters={filters} onClear={() => { clearFilters(); setLabelFilter('all'); }} />
          </div>
        )}

        <VirtualRows rows={displayed} renderRow={(r, vp) => {
          const isSelected = selectedSet.has(r.asset_id);
          return (
            <div key={r.id} className={`dir-row ${isSelected ? 'open' : ''}`} {...vp} style={vp?.style} role="listitem">
              <div className="row-main" style={grid} onClick={() => !disabled && toggleOne(r.asset_id)}>
                <div className="cell">
                  <input type="checkbox" checked={isSelected} disabled={disabled}
                         aria-label={`Select ${r.asset.name ?? r.asset.legacy_id ?? r.asset_id}`}
                         onChange={() => toggleOne(r.asset_id)} onClick={(e) => e.stopPropagation()} />
                </div>
                {shownCols.map((c) => (
                  <div key={c.key} className={`cell ${c.key === 'name' ? 'cell-primary' : ''}`}>{cell(r, c.key)}</div>
                ))}
              </div>
            </div>
          );
        }} />
      </div>
      <p className="page-hint">Showing {displayed.length} of {rows.length} assets</p>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and the guardrail**

Run: `npx vitest run src/components/labels/PrintAssetList.test.tsx src/styles/listTypography.test.ts`
Expected: all passed. Likely adjustments: if `getByText('Label')` collides with other text, scope the header assertion to `.list-head`; if `useReorderDrag`'s `dragProps` needs a different option shape, copy the exact call from `pages/FixedReaders.tsx:158-162`. Keep `displayed` stable across renders (the `useMemo` above) so `onDisplayedChange` doesn't fire every render.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/labels/PrintAssetList.tsx portal/src/components/labels/PrintAssetList.test.tsx
git commit -m "feat(portal): PrintAssetList — selectable roster with column menus, label status, ready/missing filter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The page — `pages/PrintLabels.tsx` + route

**Files:**
- Create: `portal/src/pages/PrintLabels.tsx`
- Modify: `portal/src/App.tsx` (lines 142–147: replace the `Placeholder` element with `<PrintLabels />`; add `import PrintLabels from './pages/PrintLabels';` next to the other page imports; delete `import Placeholder from './pages/Placeholder';` on line 37 — that was its only use; if `tsc` reports Placeholder still used elsewhere, keep the import)
- Test: `portal/src/pages/PrintLabels.test.tsx`

**Interfaces:**
- Consumes everything from Tasks 2–10 by the exact names listed in their Interfaces blocks, plus `listInitiatives`, `listInitiativeAssets`, `listLabelVocab`, `ApiError` (`lib/api`), `visibleInitiativesForGenerate`, `isAssetLabelType` (`lib/generateLabels`), `vocabOfKind`, `vocabLabel` (`lib/labels`), `relativeTime` (`lib/format`), `ComboBox`, `ChoiceCard`, `InitiativeSummary`, `summaryFromInitiative` (`components/reports/ReportOptionsLayout`).
- Produces: the default-exported page at `/labels/print`.

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/pages/PrintLabels.test.tsx
// @vitest-environment jsdom
/**
 * /labels/print — wiring of the five-step flow with the API, the printer
 * hook, and the offline cache all mocked: picker filter + summary, type
 * coverage, printer card states, selection → print validation, the
 * inline print path (settings applied, blanks in rack mode), the batch
 * modal path, settings persistence, and the offline fallback.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { GeneratedLabelBundle, InitiativeAssetRow, InitiativeItem, LabelVocab } from '../lib/api';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), listInitiativeAssets: vi.fn(), listLabelVocab: vi.fn(), getGeneratedLabelBundle: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const printer = vi.hoisted(() => ({
  supported: true, connected: false, productName: null as string | null, notice: null,
  clearNotice: vi.fn(), connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
  send: vi.fn(async (_zpl: string) => undefined), waitForIdle: vi.fn(async (_n: number, onQueued?: (q: number) => void) => { onQueued?.(0); }),
}));
vi.mock('../lib/useZebraPrinter', () => ({ useZebraPrinter: () => printer }));

const cache = vi.hoisted(() => {
  const inis = new Map<string, unknown>();
  const bundles = new Map<string, unknown>();
  return {
    inis, bundles,
    cacheAvailable: () => true,
    bundleKey: (i: string, t: string) => `${i}:${t}`,
    putInitiative: vi.fn(async (e: { initiative: { id: string } }) => { inis.set(e.initiative.id, { ...e, cached_at: new Date().toISOString() }); }),
    getInitiative: vi.fn(async (id: string) => inis.get(id) ?? null),
    listInitiatives: vi.fn(async () => Array.from(inis.values())),
    putBundle: vi.fn(async (b: { initiative_id: string; label_type: string }, name: string) => { bundles.set(`${b.initiative_id}:${b.label_type}`, { ...b, initiative_name: name, cached_at: new Date().toISOString() }); }),
    getBundle: vi.fn(async (i: string, t: string) => bundles.get(`${i}:${t}`) ?? null),
    listBundles: vi.fn(async () => Array.from(bundles.values())),
    deleteBundle: vi.fn(async (i: string, t: string) => { bundles.delete(`${i}:${t}`); }),
    deleteInitiative: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => { inis.clear(); bundles.clear(); }),
  };
});
vi.mock('../lib/labelCache', () => cache);

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_prefs: {} }, updatePreferences: vi.fn(async () => true) }),
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: PrintLabels } = await import('./PrintLabels');

const ini = (id: string, name: string, status = 'planned'): InitiativeItem => ({
  id, name, status, status_label: status, status_color: '#000', initiative_type: 'move', type_label: 'Move',
  type_color: '#000', client_name: 'Acme', archived_at: null, scheduled_start: '2026-10-01T00:00:00Z',
  scheduled_end: null, origin_site_name: 'NAP11', destination_site_name: 'NAP22', created_at: '2026-09-01T00:00:00Z',
} as unknown as InitiativeItem);

const row = (n: number, rack: string, ru: number): InitiativeAssetRow => ({
  id: `j${n}`, asset_id: `a${n}`, source_rack: rack, source_ru: ru, status: 'planned', status_label: 'Planned',
  status_color: '#123', asset: { id: `a${n}`, legacy_id: 38000 + n, serial_number: `SN${n}`, name: `asset-${n}`, model_make: 'Dell', model_name: 'R740' },
} as unknown as InitiativeAssetRow);

const vocab: LabelVocab[] = [
  { kind: 'type', key: 'top', label: 'Top Label', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'type', key: 'front', label: 'Front Label', description: '', meta: {}, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'type', key: 'container', label: 'Container Label', description: '', meta: {}, sort_order: 4, is_active: true, usage_count: null },
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
];

const bundleFor = (ids: string[], type = 'top'): GeneratedLabelBundle => ({
  initiative_id: 'i1', label_type: type, fetched_at: 'now',
  labels: ids.map((id) => ({
    id: `g-${id}`, entity_type: 'asset', entity_id: id, template_id: 't', template_name: 'T', template_version: 1,
    language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false, generated_at: 'now', code: `^XA^PW812^FD${id}^FS^XZ`,
  })),
});

const ROWS = [row(1, 'R1', 40), row(2, 'R1', 42), row(3, 'R2', 10)];

beforeEach(() => {
  localStorage.clear();
  cache.inis.clear(); cache.bundles.clear();
  printer.connected = false; printer.productName = null; printer.send.mockClear(); printer.connect.mockClear();
  api.listInitiatives.mockResolvedValue([ini('i1', 'NAP11'), ini('i2', 'Done move', 'completed')]);
  api.listLabelVocab.mockResolvedValue(vocab);
  api.listInitiativeAssets.mockResolvedValue(ROWS);
  api.getGeneratedLabelBundle.mockImplementation(async (_i: string, t: string) => bundleFor(t === 'top' ? ['a1', 'a2', 'a3'] : ['a1'], t));
});
afterEach(cleanup);

const renderPage = () => render(<MemoryRouter><PrintLabels /></MemoryRouter>);

async function pickInitiative() {
  await userEvent.click(screen.getByPlaceholderText('Choose an initiative…'));
  await userEvent.click(await screen.findByText('NAP11'));
  await screen.findByText('Showing 3 of 3 assets');
}

it('renders the header, hides finished initiatives, and shows the summary + coverage after a pick', async () => {
  renderPage();
  expect(screen.getByText('Print Labels')).toBeTruthy();
  await userEvent.click(screen.getByPlaceholderText('Choose an initiative…'));
  expect(await screen.findByText('NAP11')).toBeTruthy();
  expect(screen.queryByText('Done move')).toBeNull();
  await userEvent.click(screen.getByText('NAP11'));
  await screen.findByText('Showing 3 of 3 assets');
  expect(screen.getByText('3 assets')).toBeTruthy();
  expect(screen.getByText('3 of 3 assets have a Top Label')).toBeTruthy();
  expect(screen.queryByText('Container Label')).toBeNull();
  expect(cache.putInitiative).toHaveBeenCalled();
  expect(cache.putBundle).toHaveBeenCalled();
});

it('switching to Front shows its coverage and Custom reveals the raw ZPL box', async () => {
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByRole('radio', { name: /Front Label/ }));
  expect(await screen.findByText('1 of 3 assets have a Front Label · 2 missing')).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: /Custom/ }));
  expect(screen.getByLabelText('Raw ZPL')).toBeTruthy();
});

it('printer card: connect button calls the hook; unsupported browsers get an explanation', async () => {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Connect via USB' }));
  expect(printer.connect).toHaveBeenCalledTimes(1);
  cleanup();
  printer.supported = false;
  renderPage();
  expect(screen.getByText('USB printing needs Chrome or Edge on a secure (https or localhost) address.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect via USB' })).toBeNull();
  printer.supported = true;
});

it('Print is gated and prints selected labels in display order with settings applied', async () => {
  printer.connected = true; printer.productName = 'ZD421';
  renderPage();
  await pickInitiative();
  const print = screen.getByRole('button', { name: /^Print/ }) as HTMLButtonElement;
  expect(print.disabled).toBe(true);
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  expect(screen.getByRole('button', { name: 'Print 3 labels' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  await waitFor(() => expect(printer.send).toHaveBeenCalledTimes(3));
  // default sort is Source rack asc with RU top-down: a2 (R1/42), a1 (R1/40), a3 (R2/10)
  expect(printer.send.mock.calls.map((c) => c[0])).toEqual([
    '^XA^PW812^FDa2^FS^XZ', '^XA^PW812^FDa1^FS^XZ', '^XA^PW812^FDa3^FS^XZ',
  ]);
  expect(await screen.findByText('Successfully printed 3 label(s)')).toBeTruthy();
});

it('applies offsets/copies from saved settings and feeds blanks between racks in rack mode', async () => {
  localStorage.setItem('labels.print.settings', JSON.stringify({ horizontalOffset: 10, copies: 2, printByRack: true, blanksBetweenRacks: 2 }));
  printer.connected = true;
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  await waitFor(() => expect(printer.send).toHaveBeenCalledTimes(4));
  const sent = printer.send.mock.calls.map((c) => c[0]);
  expect(sent[0]).toBe('^XA\n^LS-10^PW822^FDa2^FS^PQ2^XZ');
  expect(sent[1]).toBe('^XA\n^LS-10^PW822^FDa1^FS^PQ2^XZ');
  // rack change R1 → R2: 2 blanks; offsets still apply (V2 ran blanks through the same transform), copies do NOT
  expect(sent[2]).toBe('^XA\n^LS-10^FO10,10^A0N,10,10^FD ^FS^PQ2^XZ');
  expect(sent[3]).toBe('^XA\n^LS-10^PW822^FDa3^FS^PQ2^XZ');
});

it('blocks printing when selected assets lack labels and offers Deselect missing', async () => {
  printer.connected = true;
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByRole('radio', { name: /Front Label/ }));
  await screen.findByText('1 of 3 assets have a Front Label · 2 missing');
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  expect(await screen.findByText('2 selected asset(s) do not have Front Label data. Please generate labels first.')).toBeTruthy();
  expect(printer.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Deselect missing' }));
  expect(screen.getByRole('button', { name: 'Print 1 label' })).toBeTruthy();
});

it('opens the batch modal above the batch size and walks batches', async () => {
  localStorage.setItem('labels.print.settings', JSON.stringify({ batchSize: 2 }));
  printer.connected = true;
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  expect(await screen.findByText('Printing labels')).toBeTruthy();
  expect(await screen.findByText('Batch 1 complete! Ready to print next batch.')).toBeTruthy();
  expect(printer.send).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Print next batch (1 labels)' }));
  expect(await screen.findByText('All 3 labels printed successfully!')).toBeTruthy();
  expect(printer.send).toHaveBeenCalledTimes(3);
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByText('Printing labels')).toBeNull();
  expect(screen.getByText('Successfully printed 3 label(s)')).toBeTruthy();
});

it('settings modal edits persist to localStorage and mark the gear', async () => {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Print settings' }));
  const copies = screen.getByLabelText('Copies');
  fireEvent.change(copies, { target: { value: '4' } });
  fireEvent.blur(copies);
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(JSON.parse(localStorage.getItem('labels.print.settings') ?? '{}').copies).toBe(4);
  expect(screen.getByRole('button', { name: 'Print settings' }).querySelector('.plabels-modified')).toBeTruthy();
});

it('falls back to the cache with an offline banner when the API fails', async () => {
  cache.inis.set('i1', { initiative: ini('i1', 'NAP11'), roster: ROWS, cached_at: new Date().toISOString() });
  cache.bundles.set('i1:top', { ...bundleFor(['a1', 'a2', 'a3']), initiative_name: 'NAP11', cached_at: new Date().toISOString() });
  api.listInitiatives.mockRejectedValue(new TypeError('Failed to fetch'));
  api.listInitiativeAssets.mockRejectedValue(new TypeError('Failed to fetch'));
  api.getGeneratedLabelBundle.mockRejectedValue(new TypeError('Failed to fetch'));
  renderPage();
  await userEvent.click(screen.getByPlaceholderText('Choose an initiative…'));
  await userEvent.click(await screen.findByText('NAP11'));
  await screen.findByText('Showing 3 of 3 assets');
  expect(screen.getByText(/Offline — using labels downloaded/)).toBeTruthy();
  expect(screen.getByText('3 of 3 assets have a Top Label')).toBeTruthy();
});

it('offline cache modal lists bundles and downloads the checked types', async () => {
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByRole('button', { name: /Offline cache/ }));
  expect(await screen.findByText('Offline labels')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(api.getGeneratedLabelBundle).toHaveBeenCalledWith('i1', 'front'));
  expect(await screen.findByText(/Cached 2 types/)).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/PrintLabels.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page**

```tsx
// portal/src/pages/PrintLabels.tsx
/**
 * /labels/print — V3 port of V2's Print Labels page (PrintLabels.jsx):
 * pick an initiative and a label type, connect a Zebra printer over
 * WebUSB, pick assets, print. Labels come from `generated_labels` through
 * the bundle endpoint and every online load is written to the IndexedDB
 * cache (`lib/labelCache.ts`) so the dock keeps printing when the network
 * drops. Behavior contract: docs/superpowers/specs/2026-09-12-print-labels-design.md.
 *
 * Layout mirrors V2: header + status notice, three side-by-side step
 * cards (Initiative / Label type / Printer), the asset list card, the
 * Ready to print bar. Modals: Print settings, Printing labels (batch),
 * Offline labels.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import {
  getGeneratedLabelBundle, listInitiativeAssets, listInitiatives, listLabelVocab,
  type GeneratedLabelBundle, type InitiativeAssetRow, type InitiativeItem, type LabelVocab,
} from '../lib/api';
import { relativeTime } from '../lib/format';
import { isAssetLabelType, visibleInitiativesForGenerate } from '../lib/generateLabels';
import * as labelCache from '../lib/labelCache';
import { vocabLabel, vocabOfKind } from '../lib/labels';
import {
  LABEL_TYPE_CUSTOM, applyPrintSettings, batchBounds, batchCount, blankLabelsZpl, bundleByEntity,
  labelStatusFor, missingLabelIds, printOrder, rackOf, readPrintSettings, settingsModified,
  staleLabelCount, writePrintSettings, type LabelStatus, type PrintSettings,
} from '../lib/printLabels';
import { useZebraPrinter } from '../lib/useZebraPrinter';
import ComboBox from '../components/ComboBox';
import OfflineCacheModal from '../components/labels/OfflineCacheModal';
import PrintAssetList from '../components/labels/PrintAssetList';
import PrintBatchModal, { type BatchPrintState } from '../components/labels/PrintBatchModal';
import PrintSettingsModal from '../components/labels/PrintSettingsModal';
import { ChoiceCard, InitiativeSummary, summaryFromInitiative } from '../components/reports/ReportOptionsLayout';
import '../styles/directory.css';
import '../styles/dashboard.css';
import '../styles/reports.css';
import '../styles/labels.css';

const LABEL_DELAY_MS = 100;
const AUTO_NEXT_SECONDS = 5;

interface Notice { type: 'success' | 'info' | 'warning' | 'error'; message: string; action?: { label: string; onClick: () => void } }

function StepCard({ step, title, hint, children }: { step: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="plabels-step" aria-label={title}>
      <div className="plabels-step-head">
        <span className="eyebrow">{step}</span>
        <div className="modal-section">{title}</div>
        {hint && <p className="page-hint">{hint}</p>}
      </div>
      <div className="plabels-step-body">{children}</div>
    </section>
  );
}

const isNetworkFailure = (err: unknown) => !(err instanceof Error && 'status' in err);

export default function PrintLabels() {
  const printer = useZebraPrinter();

  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [initiativeId, setInitiativeId] = useState('');
  const [labelType, setLabelType] = useState('');
  const [customZpl, setCustomZpl] = useState('');
  const [roster, setRoster] = useState<InitiativeAssetRow[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [bundle, setBundle] = useState<GeneratedLabelBundle | null>(null);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);   // cached_at of what we're serving
  const [cacheStamp, setCacheStamp] = useState<{ cached_at: string; count: number } | null>(null);
  const [cachedBundles, setCachedBundles] = useState<labelCache.CachedBundle[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [displayed, setDisplayed] = useState<InitiativeAssetRow[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settings, setSettings] = useState<PrintSettings>(() => readPrintSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [inlineProgress, setInlineProgress] = useState<{ done: number; total: number } | null>(null);
  const [batch, setBatch] = useState<BatchPrintState | null>(null);
  const batchIdsRef = useRef<string[]>([]);
  const initiativeIdRef = useRef(initiativeId);
  initiativeIdRef.current = initiativeId;

  // Printer notices flow into the page's strip.
  useEffect(() => {
    if (printer.notice) {
      setNotice(printer.notice);
      printer.clearNotice();
    }
  }, [printer.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshCachedBundles = useCallback(() => {
    void labelCache.listBundles().then(setCachedBundles);
  }, []);

  // ── initial loads (initiatives + vocab), with cache fallback ─────────
  useEffect(() => {
    listInitiatives()
      .then(setInitiatives)
      .catch(async () => {
        const cached = await labelCache.listInitiatives();
        setInitiatives(cached.map((c) => c.initiative));
        setOfflineSince((s) => s ?? (cached[0]?.cached_at ?? null));
        if (cached.length === 0) setNotice({ type: 'error', message: "Couldn't load initiatives." });
      });
    listLabelVocab().then(setVocab).catch(() => undefined);
    refreshCachedBundles();
  }, [refreshCachedBundles]);

  const typeVocab = useMemo(() => vocabOfKind(vocab, 'type').filter((v) => isAssetLabelType(v.key)), [vocab]);
  // Offline without vocab: the types present in cached bundles.
  const typeChoices = useMemo(() => {
    if (typeVocab.length > 0) return typeVocab.map((v) => ({ key: v.key, label: v.label }));
    const keys = Array.from(new Set(cachedBundles.map((b) => b.label_type)));
    return keys.map((key) => ({ key, label: key }));
  }, [typeVocab, cachedBundles]);
  const typeLabel = (key: string) => (key === LABEL_TYPE_CUSTOM ? 'Custom' : (typeChoices.find((t) => t.key === key)?.label ?? vocabLabel(vocab, 'type', key)));

  const pickerOptions = useMemo(
    () => visibleInitiativesForGenerate(initiatives ?? []).map((i) => ({ value: i.id, label: i.name, sub: i.client_name ?? undefined })),
    [initiatives]);
  const initiative = useMemo(() => initiatives?.find((i) => i.id === initiativeId) ?? null, [initiatives, initiativeId]);

  // ── roster load (API → cache), clears selection like V2 ──────────────
  const loadRoster = useCallback(async (id: string) => {
    setRosterLoading(true);
    setSelected([]);
    try {
      const rows = await listInitiativeAssets(id);
      if (initiativeIdRef.current !== id) return;
      setRoster(rows);
      setOfflineSince(null);
      const item = initiatives?.find((i) => i.id === id);
      if (item) await labelCache.putInitiative({ initiative: item, roster: rows });
    } catch (err) {
      if (initiativeIdRef.current !== id) return;
      const cached = isNetworkFailure(err) ? await labelCache.getInitiative(id) : null;
      if (cached) {
        setRoster(cached.roster);
        setOfflineSince(cached.cached_at);
      } else {
        setRoster([]);
        setNotice({ type: 'error', message: "Couldn't load the initiative's assets." });
      }
    } finally {
      if (initiativeIdRef.current === id) setRosterLoading(false);
    }
  }, [initiatives]);

  useEffect(() => {
    if (!initiativeId) { setRoster(null); setSelected([]); setBundle(null); return; }
    void loadRoster(initiativeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiativeId]);

  // ── bundle load for initiative + type (API → cache) ──────────────────
  const loadBundle = useCallback(async (id: string, type: string) => {
    try {
      const b = await getGeneratedLabelBundle(id, type);
      if (initiativeIdRef.current !== id) return;
      setBundle(b);
      const name = initiatives?.find((i) => i.id === id)?.name ?? id;
      await labelCache.putBundle(b, name);
      setCacheStamp({ cached_at: new Date().toISOString(), count: b.labels.length });
      refreshCachedBundles();
    } catch (err) {
      if (initiativeIdRef.current !== id) return;
      const cached = isNetworkFailure(err) ? await labelCache.getBundle(id, type) : null;
      if (cached) {
        setBundle(cached);
        setOfflineSince((s) => s ?? cached.cached_at);
        setCacheStamp({ cached_at: cached.cached_at, count: cached.labels.length });
      } else {
        setBundle(null);
        setCacheStamp(null);
        setNotice({ type: 'error', message: `Couldn't load ${typeLabel(type)} labels.` });
      }
    }
  }, [initiatives, refreshCachedBundles]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initiativeId || !labelType || labelType === LABEL_TYPE_CUSTOM) { setBundle(null); setCacheStamp(null); return; }
    void loadBundle(initiativeId, labelType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiativeId, labelType]);

  // Default the type to the first choice once vocab arrives (V2 defaulted to Front).
  useEffect(() => {
    if (!labelType && typeChoices.length > 0) setLabelType(typeChoices[0].key);
  }, [typeChoices, labelType]);

  // Back online → refetch what's in view.
  useEffect(() => {
    const onOnline = () => {
      if (initiativeIdRef.current) {
        void loadRoster(initiativeIdRef.current);
        if (labelType && labelType !== LABEL_TYPE_CUSTOM) void loadBundle(initiativeIdRef.current, labelType);
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [labelType, loadRoster, loadBundle]);

  const byEntity = useMemo(() => bundleByEntity(bundle), [bundle]);
  const isCustom = labelType === LABEL_TYPE_CUSTOM;
  const statusOf = useCallback((r: InitiativeAssetRow): LabelStatus => labelStatusFor(r.asset_id, byEntity), [byEntity]);
  const coverage = useMemo(() => {
    if (!roster || isCustom || !labelType) return null;
    const have = roster.filter((r) => statusOf(r) === 'ready' || statusOf(r) === 'stale').length;
    return { have, total: roster.length, missing: roster.length - have };
  }, [roster, isCustom, labelType, statusOf]);

  const updateSettings = (next: PrintSettings) => { setSettings(next); writePrintSettings(next); };

  // ── sending ──────────────────────────────────────────────────────────
  const sendLabel = (zpl: string, singleCopy = false) => printer.send(applyPrintSettings(zpl, settings, { singleCopy }));
  const sendBlanks = async (count: number) => { if (count > 0) await sendLabel(blankLabelsZpl(count), true); };
  const zplFor = (assetId: string): string | null => (isCustom ? (customZpl.trim() || null) : (byEntity.get(assetId)?.code ?? null));
  const rowById = useMemo(() => new Map((roster ?? []).map((r) => [r.asset_id, r])), [roster]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Send `ids[from..to)`; returns formats sent and blanks fed. */
  const sendRange = async (ids: string[], from: number, to: number, onSent?: (n: number) => void) => {
    let formatsSent = 0, blanksSent = 0, skipped = 0;
    let prevRack: string | null = from > 0 ? rackOf(rowById.get(ids[from - 1])) : null;
    for (const assetId of ids.slice(from, to)) {
      const zpl = zplFor(assetId);
      if (!zpl) { skipped += 1; continue; }
      const rack = rackOf(rowById.get(assetId));
      if (settings.printByRack && prevRack !== null && rack !== prevRack) {
        await sendBlanks(settings.blanksBetweenRacks);
        blanksSent += settings.blanksBetweenRacks;
      }
      await sendLabel(zpl);
      prevRack = rack;
      formatsSent += 1;
      onSent?.(formatsSent);
      await sleep(LABEL_DELAY_MS);
    }
    return { formatsSent, blanksSent, skipped };
  };

  const validateForPrint = (): string[] | null => {
    if (!printer.connected || !labelType || selected.length === 0) {
      setNotice({ type: 'error', message: 'Please connect a printer, select a label type, and select assets to print' });
      return null;
    }
    if (isCustom) {
      if (!customZpl.trim()) { setNotice({ type: 'error', message: 'Please enter raw ZPL code for custom label printing' }); return null; }
    } else {
      const missing = missingLabelIds(selected, byEntity);
      if (missing.length > 0) {
        const unsupported = missing.filter((id) => labelStatusFor(id, byEntity) === 'unsupported').length;
        setNotice({
          type: 'error',
          message: unsupported === missing.length
            ? `${missing.length} selected asset(s) have labels compiled for a non-Zebra printer`
            : `${missing.length} selected asset(s) do not have ${typeLabel(labelType)} data. Please generate labels first.`,
          action: { label: 'Deselect missing', onClick: () => { setSelected((s) => s.filter((id) => !missing.includes(id))); setNotice(null); } },
        });
        return null;
      }
      const stale = staleLabelCount(selected, byEntity);
      if (stale > 0) setNotice({ type: 'info', message: `${stale} labels were generated with an older template — regenerate for the latest layout.` });
    }
    return printOrder(selected, displayed, settings);
  };

  const printBatch = async (batchNumber: number, ids: string[]) => {
    const { start, end } = batchBounds(batchNumber, settings.batchSize, ids.length);
    setBatch((b) => b && { ...b, currentBatch: batchNumber, printing: true, finishing: false, batchComplete: false, error: null });
    try {
      const { formatsSent, blanksSent } = await sendRange(ids, start, end);
      setBatch((b) => b && { ...b, finishing: true });
      await printer.waitForIdle((end - start) * (settings.copies || 1) + blanksSent, (queued) => {
        const printedThisBatch = Math.max(0, Math.min(formatsSent - queued, formatsSent));
        setBatch((b) => b && { ...b, printedCount: Math.min(start + printedThisBatch, end) });
      });
      const allDone = end >= ids.length;
      setBatch((b) => b && { ...b, printedCount: end, finishing: false, printing: false, batchComplete: true, allComplete: allDone });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Print failed';
      setBatch((b) => b && { ...b, printing: false, finishing: false, error: `Batch ${batchNumber} failed: ${message}` });
    }
  };

  const handlePrint = async () => {
    const ids = validateForPrint();
    if (!ids) return;
    if (ids.length > settings.batchSize) {
      batchIdsRef.current = ids;
      setBatch({
        total: ids.length, batchSize: settings.batchSize, currentBatch: 1, totalBatches: batchCount(ids.length, settings.batchSize),
        printedCount: 0, printing: true, finishing: false, batchComplete: false, allComplete: false,
        autoPrintNext: false, autoCountdown: null, error: null,
      });
      await printBatch(1, ids);
      return;
    }
    setPrinting(true);
    setInlineProgress({ done: 0, total: ids.length });
    setNotice({ type: 'info', message: `Printing ${ids.length} label(s)...` });
    try {
      const { formatsSent, skipped } = await sendRange(ids, 0, ids.length, (n) => setInlineProgress({ done: n, total: ids.length }));
      setNotice(skipped > 0
        ? { type: 'warning', message: `Printed ${formatsSent} label(s), skipped ${skipped} (no label data)` }
        : { type: 'success', message: `Successfully printed ${ids.length} label(s)` });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Print failed' });
    } finally {
      setPrinting(false);
      setInlineProgress(null);
    }
  };

  const printNextBatch = () => {
    const next = (batch?.currentBatch ?? 0) + 1;
    setBatch((b) => b && { ...b, autoCountdown: null });
    void printBatch(next, batchIdsRef.current);
  };
  const reprintBatch = () => { if (batch) void printBatch(batch.currentBatch, batchIdsRef.current); };
  const closeBatch = () => {
    if (batch?.allComplete) setNotice({ type: 'success', message: `Successfully printed ${batch.total} label(s)` });
    setBatch(null);
  };

  // Auto-next countdown (V2): starts when a batch completes with the toggle on.
  useEffect(() => {
    if (!batch) return;
    const shouldCount = batch.batchComplete && !batch.allComplete && batch.autoPrintNext && !batch.printing && !batch.error;
    if (shouldCount && batch.autoCountdown === null) setBatch((b) => b && { ...b, autoCountdown: AUTO_NEXT_SECONDS });
    if (!shouldCount && batch.autoCountdown !== null) setBatch((b) => b && { ...b, autoCountdown: null });
  }, [batch?.batchComplete, batch?.allComplete, batch?.autoPrintNext, batch?.printing, batch?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!batch || batch.autoCountdown === null) return undefined;
    if (batch.autoCountdown <= 0) { printNextBatch(); return undefined; }
    const timer = setTimeout(() => setBatch((b) => b && b.autoCountdown !== null ? { ...b, autoCountdown: b.autoCountdown - 1 } : b), 1000);
    return () => clearTimeout(timer);
  }, [batch?.autoCountdown]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── offline cache modal actions ──────────────────────────────────────
  const downloadForOffline = async (types: string[]) => {
    if (!initiative) return;
    setDownloading(true);
    setDownloadStatus(null);
    try {
      const rows = await listInitiativeAssets(initiative.id);
      await labelCache.putInitiative({ initiative, roster: rows });
      let labels = 0;
      for (const t of types) {
        const b = await getGeneratedLabelBundle(initiative.id, t);
        await labelCache.putBundle(b, initiative.name);
        labels += b.labels.length;
      }
      setDownloadStatus(`Cached ${types.length} types · ${labels} labels`);
      refreshCachedBundles();
    } catch (err) {
      setDownloadStatus(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const printAlignmentTest = async (zpl: string, sizeLabel: string) => {
    try {
      await sendLabel(zpl, true);
      setNotice({ type: 'success', message: `Alignment test label (${sizeLabel}) sent to printer` });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Failed to print alignment test label' });
    }
  };

  const canPrint = printer.connected && !!labelType && selected.length > 0 && !printing && !batch;
  const modified = settingsModified(settings);

  return (
    <div className="portal-page plabels-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Print Labels</h1>
          <p className="page-hint">
            Select an initiative and label type, connect a Zebra printer over USB, and print labels for the assets you choose.
          </p>
        </div>
        <div className="plabels-head-actions">
          <button type="button" className="btn-ghost" onClick={() => setCacheOpen(true)}>
            Offline cache{cachedBundles.length > 0 ? ` · ${cachedBundles.length} cached` : ''}
          </button>
          <button type="button" className="btn-ghost plabels-gear" aria-label="Print settings" title="Print settings"
                  onClick={() => setSettingsOpen(true)}>
            Settings{modified && <span className="plabels-modified" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {offlineSince && (
        <div className="plabels-notice warning">
          <p className="page-hint">
            Offline — using labels downloaded {relativeTime(offlineSince)}. Printing works; changes made elsewhere are not reflected.
          </p>
        </div>
      )}
      {notice && (
        <div className={`plabels-notice ${notice.type}`} role="status">
          <p className="page-hint">{notice.message}</p>
          <div className="plabels-notice-actions">
            {notice.action && <button type="button" className="mini-btn" onClick={notice.action.onClick}>{notice.action.label}</button>}
            <button type="button" className="mini-btn" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}

      <div className="plabels-steps">
        <StepCard step="Step 1" title="Initiative" hint="Pick the initiative whose assets you are labeling.">
          <ComboBox options={pickerOptions} value={initiativeId} onChange={(v) => { setInitiativeId(v); setNotice(null); }}
                    placeholder="Choose an initiative…" clearable />
          {initiatives && !initiative && (
            <p className="page-hint">{offlineSince ? 'Showing cached initiatives.' : `${pickerOptions.length} active initiatives available`}</p>
          )}
          {initiative && (
            <div>
              <InitiativeSummary initiative={summaryFromInitiative(initiative)} emptyText="" />
              <div className="plabels-summary-line">
                <span className="cell-sub">{rosterLoading ? 'Loading assets…' : `${roster?.length ?? 0} assets`}</span>
                {cacheStamp && !isCustom && (
                  <span className="chip tag">Cached for offline · {cacheStamp.count} labels · {relativeTime(cacheStamp.cached_at)}</span>
                )}
              </div>
            </div>
          )}
        </StepCard>

        <StepCard step="Step 2" title="Label type" hint="Choose the type of label to print.">
          <div className="rgm-choice-cards" role="radiogroup" aria-label="Label type">
            {typeChoices.map((t) => (
              <ChoiceCard key={t.key} title={t.label} selected={labelType === t.key} onSelect={() => setLabelType(t.key)}
                          description={labelType === t.key && coverage
                            ? `${coverage.have} of ${coverage.total} assets have a ${t.label}${coverage.missing > 0 ? ` · ${coverage.missing} missing` : ''}`
                            : `Printable ${t.label.toLowerCase()} for each selected asset`} />
            ))}
            <ChoiceCard title="Custom" selected={isCustom} onSelect={() => setLabelType(LABEL_TYPE_CUSTOM)}
                        description="Send raw ZPL to the printer once per selected asset" />
          </div>
          {coverage && coverage.missing > 0 && (
            <p className="page-hint"><Link to="/labels/generate">Generate labels</Link> for the assets that are missing one.</p>
          )}
          {isCustom && (
            <div className="pf-form">
              <div>
                <label htmlFor="plabels-zpl">Raw ZPL</label>
                <textarea id="plabels-zpl" className="plabels-zpl mono" rows={6} value={customZpl}
                          placeholder={'^XA\n^FO50,50^ADN,36,20^FDHello World^FS\n^XZ'}
                          onChange={(e) => setCustomZpl(e.target.value)} />
                <p className="page-hint">Enter raw ZPL code to send directly to the printer</p>
              </div>
            </div>
          )}
        </StepCard>

        <StepCard step="Step 3" title="Printer" hint="A Zebra printer connected to this computer over USB.">
          <div className="plabels-printer-status">
            <span className={`dot ${printer.connected ? 'on' : 'off'}`} />
            <span className="cell-top">
              {printer.connected ? `Printer connected${printer.productName ? ` · ${printer.productName}` : ''}` : 'No printer connected'}
            </span>
          </div>
          {!printer.supported ? (
            <p className="page-hint">USB printing needs Chrome or Edge on a secure (https or localhost) address.</p>
          ) : printer.connected ? (
            <button type="button" className="btn-ghost" onClick={() => void printer.disconnect()}>Disconnect</button>
          ) : (
            <button type="button" className="btn-solid" onClick={() => void printer.connect()}>Connect via USB</button>
          )}
          <p className="page-hint">Requires a Zebra printer connected via USB. Make sure the printer is turned on before connecting.</p>
        </StepCard>
      </div>

      <div className="plabels-card">
        <div className="plabels-card-head">
          <div>
            <span className="eyebrow">Step 4</span>
            <div className="modal-section">Assets to print</div>
          </div>
        </div>
        {!initiativeId ? (
          <div className="dir-empty">Select an initiative to view assets</div>
        ) : rosterLoading && !roster ? (
          <div className="dir-empty">Loading assets…</div>
        ) : roster && roster.length === 0 ? (
          <div className="dir-empty">No assets found on this initiative</div>
        ) : roster ? (
          <PrintAssetList rows={roster} statusOf={isCustom || !labelType ? null : statusOf} selected={selected}
                          onSelectedChange={setSelected} onDisplayedChange={setDisplayed}
                          onRefresh={() => void loadRoster(initiativeId)} refreshing={rosterLoading}
                          disabled={printing || !!batch} />
        ) : null}
      </div>

      <div className="plabels-card plabels-ready">
        <div className="plabels-ready-text">
          <div className="modal-section">Ready to print</div>
          <span className="cell-sub">
            {inlineProgress
              ? `Printing ${inlineProgress.done} of ${inlineProgress.total}…`
              : selected.length === 0 ? 'Select assets to print labels' : `${selected.length} label(s) will be printed`}
          </span>
        </div>
        <div className="plabels-ready-actions">
          <div className="plabels-ready-chips">
            <span className={`chip ${initiativeId ? 'c-green' : 'c-slate'}`}>{initiativeId ? 'Initiative selected' : 'No initiative'}</span>
            <span className={`chip ${labelType ? 'c-green' : 'c-slate'}`}>{labelType ? typeLabel(labelType) : 'No label type'}</span>
            <span className={`chip ${printer.connected ? 'c-green' : 'c-slate'}`}>{printer.connected ? 'Printer ready' : 'No printer'}</span>
          </div>
          <button type="button" className="btn-solid" disabled={!canPrint} onClick={() => void handlePrint()}>
            {printing ? 'Printing…' : `Print ${selected.length} label${selected.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {settingsOpen && (
        <PrintSettingsModal settings={settings} onChange={updateSettings} vocab={vocab}
                            printerConnected={printer.connected} onPrintAlignmentTest={printAlignmentTest}
                            onClose={() => setSettingsOpen(false)} />
      )}
      {batch && (
        <PrintBatchModal state={batch}
                         subtitle={`${initiative?.name ?? ''} · ${typeLabel(labelType)} · ${batch.total} labels in ${batch.totalBatches} batches of ${batch.batchSize}`}
                         onAutoPrintNextChange={(v) => setBatch((b) => b && { ...b, autoPrintNext: v })}
                         onPrintNext={printNextBatch} onReprint={reprintBatch} onCancel={closeBatch} onDone={closeBatch} />
      )}
      {cacheOpen && (
        <OfflineCacheModal bundles={cachedBundles}
                           selectedInitiative={initiative ? { id: initiative.id, name: initiative.name } : null}
                           labelTypes={typeChoices} downloading={downloading} downloadStatus={downloadStatus}
                           onDownload={downloadForOffline}
                           onRemove={async (i, t) => { await labelCache.deleteBundle(i, t); refreshCachedBundles(); }}
                           onClearAll={async () => { await labelCache.clearAll(); refreshCachedBundles(); setCacheStamp(null); }}
                           onClose={() => { setCacheOpen(false); setDownloadStatus(null); }} />
      )}
    </div>
  );
}
```

Notes for the implementer:
- `ChoiceCard` renders `role="radio"` with the title as its accessible name, so `getByRole('radio', { name: /Front Label/ })` works.
- The `textarea` carries `mono` for the monospace look (allowed: it's not inside a list row).
- The `Print N label(s)` button text is singular/plural; the validation and success messages keep V2's "label(s)" wording verbatim.
- `isNetworkFailure`: an `ApiError` has `status`; a `TypeError` from `fetch` doesn't → cache fallback only for network failures (a 404/403 still shows the error).

- [ ] **Step 4: Swap the route**

In `portal/src/App.tsx`: add `import PrintLabels from './pages/PrintLabels';` (alphabetically among the page imports), remove `import Placeholder from './pages/Placeholder';` if it's now unused, and replace lines 142–147 with:

```tsx
                <Route path="/labels/print" element={
                  <ProtectedRoute resource="labels"><PrintLabels /></ProtectedRoute>
                } />
```

- [ ] **Step 5: Run the tests, typecheck, guardrail, nav tests**

Run: `npx vitest run src/pages/PrintLabels.test.tsx src/styles/listTypography.test.ts src/layout/labelsNav.test.tsx && npx tsc -b`
Expected: all passed, no type errors. Common fixes: `waitFor` around the send assertions (the 100 ms delay between labels means three labels take ~300 ms; testing-library's default `waitFor` timeout of 1 s covers it — for the batch test raise it: `await screen.findByText('Batch 1 complete! Ready to print next batch.', {}, { timeout: 3000 })`), and `act` warnings from the countdown timer (only exercised when the toggle is on — not in these tests).

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/PrintLabels.tsx portal/src/pages/PrintLabels.test.tsx portal/src/App.tsx
git commit -m "feat(portal): Print Labels page — V2 flow (initiative, type, USB printer, asset pick, print/batch) with offline cache fallback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Full verification, docs, and live check

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-print-labels-design.md` only if the implementation deviated (append an "Implementation notes" section; otherwise leave it).

- [ ] **Step 1: Full portal suite + build**

Run (from `portal/`): `npx vitest run && npm run build`
Expected: every test passes (previous count ≈ 1,000+ plus the new files); `tsc -b`, `vite build`, and the two Node bundles succeed.

- [ ] **Step 2: Full API suite**

Run (from `api/`): `SS_TEST_DB=serversherpa_test_print_labels .venv/bin/python -m pytest -q -x --timeout=600` in the FOREGROUND (timeout 600000 ms on the tool call). Two pre-existing WeasyPrint-environment failures may appear on a machine without the ~/lib dylib symlinks; everything else must pass. Then `git checkout -- api/src/serversherpa/_dev_reload.py` if it churned.

- [ ] **Step 3: Live check in the browser (dev servers are usually already running on 5173/8000)**

1. Restart the API if it was running before Task 1 (new route): via the preview tool's `api` server or the running honcho stack.
2. Open `http://localhost:5173/labels/print` signed in as `claude-dev@test.example.com` / `wt-verify-2026` (login page quirk: fill fields, then `document.querySelector('form').requestSubmit()`).
3. Pick "NAP11 Hall Migration (demo)": expect "185 assets", Top Label coverage "185 of 185 assets have a Top Label", the cache chip, and the roster list with Ready chips; Front Label should read "0 of 185 … · 185 missing" with the Generate labels link.
4. Without a physical printer the Printer card shows "No printer connected" and Connect via USB (Chromium) — clicking opens the browser's device chooser (cancel → error notice "No device selected."). Confirm Print stays disabled.
5. Open Print settings: change copies to 2, close, reload the page → the gear shows the modified dot and the modal shows 2. Reset → dot gone.
6. Open Offline cache: the NAP11 · Top Label bundle is listed; Download with Top + Front checked → "Cached 2 types · 185 labels"; Remove one; Clear all.
7. Offline fallback: stop the API (or block `localhost:8000` in DevTools → Network request blocking), reload the page, pick NAP11 from the cached list → the offline banner appears and the roster + Top labels render from the cache. Restore the API.
8. Take a screenshot of the page and of each modal for the summary.

- [ ] **Step 4: Ledger + memory**

Append the task outcomes to `.superpowers/sdd/progress.md` (git-ignored ledger) and update the memory index per the memory rules (a `print-labels-feature` memory: shape, gotchas found live, follow-ups: cold-start offline, Printers page alignment link, Brother printers).

- [ ] **Step 5: Final commit (if anything changed) and summary**

```bash
git status --short
# only if the spec or docs changed:
git add docs && git commit -m "docs: Print Labels implementation notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report: suites (counts), what was verified live with evidence, and what could not be verified (a physical Zebra print).
