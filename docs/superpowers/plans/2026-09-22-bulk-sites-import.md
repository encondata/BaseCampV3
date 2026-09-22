# Bulk Add or Update Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing sites bulk importer into the first Bulk Actions tool: match rows by name or address, let admins approve updates, export the current sites in the template layout, and give it a page at `/bulk/sites` with a column guide, downloads, upload, preview and apply.

**Architecture:** The row pipeline in `api/src/serversherpa/sites/bulk_import.py` stays; `preview_rows` gains a second index (normalized address) and conflict rules, the developer-only update coupling goes, and export writers are added beside the template writers. The portal moves the upload/preview block out of the New Site dialog into a dedicated page reached from the Bulk Actions card.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, openpyxl, pytest (asyncio auto). React 18, TypeScript, Vite, Vitest with jsdom.

Spec: `docs/superpowers/specs/2026-09-22-bulk-sites-import-design.md`.

## Global Constraints

- Work in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-sites`, branch `bulk-sites-import` (based on `bulk-actions-nav`). Never `cd` to the primary checkout. `portal/node_modules`, `api/.venv`, `.env` are symlinks; never install; never commit the `.env` symlink or `api/src/serversherpa/_dev_reload.py`.
- API tests: `SS_TEST_DB=serversherpa_test_bulksites PYTHONPATH=api/src api/.venv/bin/python -m pytest <files> -q`. One pytest at a time. Full suite once, in Task 5.
- Portal tests: `npm --prefix portal run test` and `(cd portal && node_modules/.bin/tsc --noEmit)` before committing; one file via `(cd portal && node_modules/.bin/vitest run <path>)`. The list-typography guardrail rejects font-size/line-height/font-weight on selectors containing row/chip/head/td/th and raw `<table>` outside DataTable.
- Matching rules (binding): `normalize_address` = lowercase, non-alphanumerics → space, whitespace collapsed, trimmed. Index non-archived sites by lowercased name and by normalized `address_line1` (empty skipped). Error messages exactly: `multiple existing sites named '{name}'`; `multiple existing sites at that address: {A}, {B}` (names sorted); `name matches '{A}' but address matches '{B}'`; `duplicate address within the import`. Name match wins when it agrees with the address; `matched_by` ∈ `"name" | "address" | null`; `matched_name` = the existing site's current name or null.
- Updates: no `allow_updates` parameter anywhere; `update_allowed` response field and `updates_not_allowed` error removed; per-row approval unchanged.
- Export: `GET /sites/bulk-import/export?format=csv|xlsx`, non-archived sites ordered by name, exactly `COLUMNS` order, `type`=`site_type`, `partner`=partner name, `clients`=names joined `; `, coordinates as plain decimal text (`format(value, 'f').rstrip('0').rstrip('.')`), blanks empty; XLSX has the Reference sheet; file names `sites-export.csv` / `sites-export.xlsx`.
- Portal copy: page title `Add or update sites in bulk`, eyebrow `Bulk Actions`; buttons `Template (.xlsx)`, `Template (.csv)`, `Current sites (.xlsx)`, `Current sites (.csv)`, `Preview`, `Approve all updates`, apply button `Add N sites and update M sites`; matched-by labels `name`, `address`, `new site`; action labels `Add`, `Update`, `No change`, `Error`; card title `Add or update sites in bulk`, button `Open`; Sites toolbar button `Bulk import…`.
- American English. Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ledger: `.superpowers/sdd/progress.md`.

---

### Task 1: Name-or-address matching and admin updates (API)

**Files:**
- Modify: `api/src/serversherpa/sites/bulk_import.py` (`preview_rows` ~202-306, `commit_rows` ~348-384)
- Modify: `api/src/serversherpa/api/routes/sites.py` (`bulk_import_preview`, `bulk_import_commit` ~194-231)
- Test: `api/tests/test_sites_bulk_import_service.py`, `api/tests/test_sites_bulk_import_api.py`

**Interfaces:**
- Produces: `normalize_address(text: str) -> str`; `preview_rows(db, numbered) -> dict` (no `allow_updates`), each row dict gaining `matched_by` and `matched_name`; `commit_rows(db, actor_person_id, numbered, *, approved_updates, source_label)`.

- [ ] **Step 1: Write the failing tests**

In `api/tests/test_sites_bulk_import_service.py`: every `preview_rows(db, rows, allow_updates=...)` call drops the keyword; every `commit_rows(..., allow_updates=..., ...)` call drops it. Replace `test_duplicate_admin_error_vs_developer_diff` with:

```python
async def test_duplicate_name_is_an_update_with_diff(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Exists", city="Old Town", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "exists", "city": "New Town"}])
    out = await bi.preview_rows(db, rows)
    row = out["rows"][0]
    assert row["action"] == "update" and row["site_id"]
    assert row["matched_by"] == "name" and row["matched_name"] == "Exists"
    assert row["diff"]["city"] == {"old": "Old Town", "new": "New Town"}
    assert "country" not in row["diff"]               # blank = no change
    assert "status" not in row["diff"]
```

Append:

```python
def test_normalize_address():
    assert bi.normalize_address("  607 14th St. NW, Suite 660 ") == "607 14th st nw suite 660"
    assert bi.normalize_address("100 Server-Way") == "100 server way"
    assert bi.normalize_address("") == ""


async def test_address_match_renames_and_reports_matched_by(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Old Name", address_line1="100 Server Way", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "New Name", "address_line1": "100 server-way"}])
    out = await bi.preview_rows(db, rows)
    row = out["rows"][0]
    assert row["action"] == "update"
    assert row["matched_by"] == "address" and row["matched_name"] == "Old Name"
    assert row["diff"]["name"] == {"old": "Old Name", "new": "New Name"}
    assert "address_line1" not in row["diff"]


async def test_new_row_reports_no_match(db, seeded_user):
    rows = bi.number_json_rows([{"name": "Brand New", "address_line1": "1 Nowhere Rd"}])
    out = await bi.preview_rows(db, rows)
    assert out["rows"][0]["action"] == "create"
    assert out["rows"][0]["matched_by"] is None and out["rows"][0]["matched_name"] is None


async def test_name_and_address_pointing_at_different_sites_is_error(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Site A", address_line1="1 First St", country="US", status="active"))
    db.add(Site(name="Site B", address_line1="2 Second St", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "Site A", "address_line1": "2 Second St"}])
    out = await bi.preview_rows(db, rows)
    assert out["rows"][0]["action"] == "error"
    assert out["rows"][0]["errors"] == ["name matches 'Site A' but address matches 'Site B'"]


async def test_ambiguous_address_is_error(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Twin 1", address_line1="9 Same Ave", country="US", status="active"))
    db.add(Site(name="Twin 2", address_line1="9 same ave.", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "Third", "address_line1": "9 Same Ave"}])
    out = await bi.preview_rows(db, rows)
    assert out["rows"][0]["action"] == "error"
    assert out["rows"][0]["errors"] == ["multiple existing sites at that address: Twin 1, Twin 2"]


async def test_duplicate_address_within_import_is_error(db, seeded_user):
    rows = bi.number_json_rows([{"name": "One", "address_line1": "5 Dup Ln"},
                                {"name": "Two", "address_line1": "5 dup ln"}])
    out = await bi.preview_rows(db, rows)
    assert all(r["action"] == "error" for r in out["rows"])
    assert all("duplicate address within the import" in r["errors"] for r in out["rows"])


async def test_archived_sites_are_not_matched(db, seeded_user):
    from datetime import UTC, datetime
    from serversherpa.db.models import Site
    db.add(Site(name="Gone", address_line1="7 Past Rd", country="US", status="active",
                archived_at=datetime.now(UTC)))
    await db.commit()
    rows = bi.number_json_rows([{"name": "Gone", "address_line1": "7 Past Rd"}])
    out = await bi.preview_rows(db, rows)
    assert out["rows"][0]["action"] == "create"
```

In `api/tests/test_sites_bulk_import_api.py`: replace `test_preview_admin_error_developer_update` with

```python
async def test_admin_previews_and_commits_updates(client, db, seeded_user, admin_hdrs):
    site = Site(name="Already Here", city="Old", country="US", status="active")
    db.add(site)
    await db.commit()
    rows = {"rows": [{"name": "Already Here", "city": "New"}]}
    body = (await client.post("/sites/bulk-import/preview",
                              headers=admin_hdrs, json=rows)).json()
    assert "update_allowed" not in body
    assert body["rows"][0]["action"] == "update"
    assert body["rows"][0]["matched_by"] == "name"
    assert body["rows"][0]["diff"]["city"] == {"old": "Old", "new": "New"}
    ok = await client.post("/sites/bulk-import/commit", headers=admin_hdrs,
                           json={**rows, "approved_updates": [str(site.id)]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["updated"] == 1
```

Delete `test_admin_cannot_smuggle_approved_updates`. Keep `test_commit_approval_flow` (it uses `dev_hdrs`; that still works) and update the module docstring's last sentence to "admin (60) clears it and may approve updates".

- [ ] **Step 2: Run to verify failures**

Run: `SS_TEST_DB=serversherpa_test_bulksites PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_sites_bulk_import_service.py api/tests/test_sites_bulk_import_api.py -q`
Expected: new tests FAIL (TypeError on the removed keyword, missing `matched_by`, wrong actions).

- [ ] **Step 3: Implement in `bulk_import.py`**

Add near `_split_clients`:

```python
_NON_ALNUM = re.compile(r"[^0-9a-z]+")


def normalize_address(text: str) -> str:
    """Match key for address_line1: case, punctuation and spacing noise
    removed so '607 14th St. NW' and '607 14th st nw' meet."""
    return " ".join(_NON_ALNUM.sub(" ", (text or "").lower()).split())
```

(`import re` at the top.) Rewrite the top of `preview_rows`:

```python
async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]]) -> dict:
    ref = await _reference_data(db)
    names_seen: dict[str, list[int]] = {}
    addrs_seen: dict[str, list[int]] = {}
    for n, row in numbered:
        if row["name"]:
            names_seen.setdefault(row["name"].lower(), []).append(n)
        key = normalize_address(row["address_line1"])
        if key:
            addrs_seen.setdefault(key, []).append(n)

    by_name: dict[str, list[Site]] = {}
    by_addr: dict[str, list[Site]] = {}
    for site in await db.scalars(select(Site).where(Site.archived_at.is_(None))):
        by_name.setdefault(site.name.lower(), []).append(site)
        key = normalize_address(site.address_line1 or "")
        if key:
            by_addr.setdefault(key, []).append(site)

    dup_sites = [s for sites in by_name.values() for s in sites]
```

(`dup_sites` now covers every live site, which is what the client/partner lookups below need.) Inside the per-row loop, after the in-import duplicate-name check add:

```python
        addr_key = normalize_address(row["address_line1"])
        if addr_key and len(addrs_seen[addr_key]) > 1:
            errors.append("duplicate address within the import")
```

Replace the block from `dupes = existing.get(name.lower(), []) if name else []` through the `results.append(...)` with:

```python
        name_hits = by_name.get(name.lower(), []) if name else []
        addr_hits = by_addr.get(addr_key, []) if addr_key else []
        target: Site | None = None
        matched_by: str | None = None
        if not errors:
            if len(name_hits) > 1:
                errors.append(f"multiple existing sites named '{name}'")
            elif name_hits:
                target, matched_by = name_hits[0], "name"
                if addr_hits and all(s.id != target.id for s in addr_hits):
                    errors.append(f"name matches '{target.name}' but address "
                                  f"matches '{addr_hits[0].name}'")
            elif len(addr_hits) > 1:
                names = ", ".join(sorted(s.name for s in addr_hits))
                errors.append(f"multiple existing sites at that address: {names}")
            elif addr_hits:
                target, matched_by = addr_hits[0], "address"

        action, diff_out, site_id = "create", None, None
        if errors:
            action = "error"
        elif target is not None:
            site_id = str(target.id)
            changes = _diff_row(
                target, data, blank, partner_obj, client_objs,
                current_clients.get(target.id, {}), partner_names)
            action = "update" if changes else "unchanged"
            diff_out = changes or None

        results.append({"row": n, "name": name or None, "action": action,
                        "matched_by": matched_by if action != "error" else None,
                        "matched_name": target.name if target is not None and action != "error" else None,
                        "errors": errors, "diff": diff_out, "site_id": site_id,
                        "data": data if action != "error" else None})

    can_commit = bool(results) and all(r["action"] != "error" for r in results)
    return {"rows": results, "can_commit": can_commit}
```

Remove the `elif not allow_updates` branch entirely. In `commit_rows` drop the `allow_updates` parameter and pass nothing extra to `preview_rows`. Update the module docstring's mention of the developer path if any.

- [ ] **Step 4: Routes** — in `sites.py`, `bulk_import_preview` returns `await bulk.preview_rows(db, numbered)`; in `bulk_import_commit` delete the `allow = ...` / `updates_not_allowed` lines and call `bulk.commit_rows(db, actor.person.id, numbered, approved_updates=approved, source_label=...)`.

- [ ] **Step 5: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_bulksites PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_sites_bulk_import_service.py api/tests/test_sites_bulk_import_api.py api/tests/test_sites_api.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/sites/bulk_import.py api/src/serversherpa/api/routes/sites.py api/tests/test_sites_bulk_import_service.py api/tests/test_sites_bulk_import_api.py
git commit -m "feat(sites): bulk import matches by name or address and lets admins approve updates"
```

---

### Task 2: Export current sites in the template layout (API)

**Files:**
- Modify: `api/src/serversherpa/sites/bulk_import.py` (template writers ~138-166 + new `export_rows`)
- Modify: `api/src/serversherpa/api/routes/sites.py` (route beside `bulk_import_template`)
- Test: `api/tests/test_sites_bulk_import_service.py`, `api/tests/test_sites_bulk_import_api.py`

**Interfaces:**
- Produces: `export_rows(db) -> list[dict]` (COLUMNS-shaped strings), `build_rows_csv(rows) -> str`, `build_rows_xlsx(rows, type_keys, status_keys) -> bytes`; `build_template_csv()` / `build_template_xlsx()` delegate to them with `SAMPLE_ROWS`; `GET /sites/bulk-import/export?format=csv|xlsx`.

- [ ] **Step 1: Write the failing tests**

Service:

```python
async def test_export_rows_round_trip_as_unchanged(db, seeded_user):
    from serversherpa.db.models import Client, Partner, Site, SiteClient
    p = Partner(name="ColoCo")
    c = Client(name="Acme")
    db.add_all([p, c])
    await db.flush()
    s = Site(name="Export Me", code="EXP", site_type="datacenter", status="active",
             address_line1="1 Export Way", city="Reno", region="NV", postal_code="89501",
             country="US", latitude=39.5296, longitude=-119.8138,
             timezone="America/Los_Angeles", dc_provider="Switch", partner_id=p.id,
             notes="hi")
    db.add(s)
    await db.flush()
    db.add(SiteClient(site_id=s.id, client_id=c.id))
    await db.commit()
    rows = await bi.export_rows(db)
    mine = next(r for r in rows if r["name"] == "Export Me")
    assert list(mine) == bi.COLUMNS
    assert mine["type"] == "datacenter" and mine["partner"] == "ColoCo"
    assert mine["clients"] == "Acme" and mine["latitude"] == "39.5296"
    assert mine["address_line2"] == ""
    # export -> upload previews as unchanged
    out = await bi.preview_rows(db, bi.number_json_rows(rows))
    assert {r["action"] for r in out["rows"]} == {"unchanged"}
    # the csv/xlsx writers accept the same rows
    assert bi.build_rows_csv(rows).splitlines()[0] == ",".join(bi.COLUMNS)
    parsed = bi.parse_upload("e.xlsx", bi.build_rows_xlsx(rows, ["datacenter"], ["active"]))
    assert [r for _, r in parsed][0]["name"] == rows[0]["name"]
```

Check whether `Partner`/`Client` need more required columns in this test DB (read `test_clients_diff_add_remove_and_partner` in the same file and copy its constructor style).

API (extend `test_template_formats` or add):

```python
async def test_export_formats(client, db, seeded_user, admin_hdrs):
    db.add(Site(name="Exported", country="US", status="active"))
    await db.commit()
    csv_resp = await client.get("/sites/bulk-import/export?format=csv", headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-disposition"].endswith('filename="sites-export.csv"')
    assert "Exported" in csv_resp.text
    xlsx_resp = await client.get("/sites/bulk-import/export?format=xlsx", headers=admin_hdrs)
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))
    assert wb.sheetnames == ["Sites", "Reference"]
    assert [c.value for c in next(wb["Sites"].iter_rows(max_row=1))] == bi.COLUMNS
    assert (await client.get("/sites/bulk-import/export?format=csv",
                             headers=await login(client))).status_code == 403
    assert (await client.get("/sites/bulk-import/export?format=pdf",
                             headers=admin_hdrs)).status_code == 422
```

- [ ] **Step 2: Run to verify failures** — same command as Task 1 Step 5 → new tests FAIL.

- [ ] **Step 3: Implement**

In `bulk_import.py` replace the two template builders with:

```python
def build_rows_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


def build_rows_xlsx(rows: list[dict], type_keys: list[str],
                    status_keys: list[str]) -> bytes:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sites"
    ws.append(COLUMNS)
    for row in rows:
        ws.append([row[c] for c in COLUMNS])
    ref = wb.create_sheet("Reference")
    ref.append(["Valid type keys"])
    for key in type_keys:
        ref.append([key])
    ref.append([])
    ref.append(["Valid status keys"])
    for key in status_keys:
        ref.append([key])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


def build_template_xlsx(type_keys: list[str], status_keys: list[str]) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, type_keys, status_keys)


def _coord_text(value) -> str:
    return "" if value is None else format(value, "f").rstrip("0").rstrip(".")


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live site in template shape, so an export re-uploads clean."""
    sites = list(await db.scalars(
        select(Site).where(Site.archived_at.is_(None)).order_by(Site.name)))
    partner_names = dict((await db.execute(select(Partner.id, Partner.name))).all())
    clients: dict[uuid.UUID, list[str]] = {}
    for site_id, cname in (await db.execute(
        select(SiteClient.site_id, Client.name)
        .join(Client, Client.id == SiteClient.client_id)
        .order_by(Client.name))).all():
        clients.setdefault(site_id, []).append(cname)
    out = []
    for s in sites:
        out.append({
            "name": s.name, "code": s.code or "", "type": s.site_type or "",
            "status": s.status, "address_line1": s.address_line1 or "",
            "address_line2": s.address_line2 or "", "city": s.city or "",
            "region": s.region or "", "postal_code": s.postal_code or "",
            "country": s.country or "", "latitude": _coord_text(s.latitude),
            "longitude": _coord_text(s.longitude), "timezone": s.timezone or "",
            "dc_provider": s.dc_provider or "",
            "partner": partner_names.get(s.partner_id, "") if s.partner_id else "",
            "clients": "; ".join(clients.get(s.id, [])), "notes": s.notes or "",
        })
    return out
```

Route, after `bulk_import_template`:

```python
@router.get("/bulk-import/export")
async def bulk_import_export(
    db: DbSession,
    format: str = "xlsx",
    actor: AuthContext = require_permission("sites", "add"),
):
    """The current sites in the template's layout — fill in, re-upload."""
    _require_bulk_rank(actor)
    if format not in ("csv", "xlsx"):
        raise _err(422, "unknown_format")
    rows = await bulk.export_rows(db)
    if format == "csv":
        return Response(bulk.build_rows_csv(rows), media_type="text/csv",
                        headers={"Content-Disposition":
                                 'attachment; filename="sites-export.csv"'})
    types = [t.key for t in await db.scalars(select(SiteType).order_by(SiteType.sort_order))]
    statuses = list(await db.scalars(
        select(StatusValue.key).where(StatusValue.record_type == "site")
        .order_by(StatusValue.sort_order)))
    return Response(
        bulk.build_rows_xlsx(rows, types, statuses),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="sites-export.xlsx"'})
```

- [ ] **Step 4: Run the tests** — same three files → all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/sites/bulk_import.py api/src/serversherpa/api/routes/sites.py api/tests/test_sites_bulk_import_service.py api/tests/test_sites_bulk_import_api.py
git commit -m "feat(sites): export the current sites in the bulk-import template layout"
```

---

### Task 3: Portal — upload component, column guide, Sites toolbar button

**Files:**
- Modify: `portal/src/lib/api.ts` (`BulkRowResult` + `BulkPreview` types, `downloadSiteExport`, remove `getSiteBulkSample`)
- Create: `portal/src/lib/siteBulk.ts`
- Rename: `portal/src/components/sites/SiteBulkImport.tsx` → `portal/src/components/sites/SiteBulkUpload.tsx` (rewritten body)
- Modify: `portal/src/components/sites/SiteEditModal.tsx` (remove the Bulk tab, `mode`, `canBulk`)
- Modify: `portal/src/pages/Sites.tsx` (toolbar button; drop `canBulk` prop pass)
- Modify: `portal/src/styles/sites.css` (drop the textarea rule; keep the rest)
- Test: rename `SiteBulkImport.test.tsx` → `SiteBulkUpload.test.tsx` (rewritten), create `portal/src/lib/siteBulk.test.ts`, update `SiteEditModal.test.tsx` if it references bulk

**Interfaces:**
- Produces: `BulkRowResult.matched_by: 'name' | 'address' | null`, `BulkRowResult.matched_name: string | null`, `BulkPreview` without `update_allowed`; `downloadSiteExport(format: 'csv' | 'xlsx')`; `SITE_COLUMN_GUIDE: { key, required, accepts, example }[]`; `SiteBulkUpload` props `{ onDone(counts): void }`.

- [ ] **Step 1: Types and API** — in `lib/api.ts`: add `matched_by: 'name' | 'address' | null; matched_name: string | null;` to `BulkRowResult` after `action`; remove `update_allowed` from `BulkPreview`; delete `getSiteBulkSample`; add after `downloadSiteTemplate`:

```ts
export async function downloadSiteExport(format: 'csv' | 'xlsx'): Promise<void> {
  const resp = await apiFetch(`/sites/bulk-import/export?format=${format}`);
  if (!resp.ok) throw await errorFrom(resp);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sites-export.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Column guide** — create `portal/src/lib/siteBulk.ts`:

```ts
/** What each bulk-import column accepts. Keys mirror the API's
 *  sites/bulk_import.py COLUMNS — the service test pins that list, the
 *  test beside this file pins this one, and the two must agree. */
export interface SiteColumnGuide { key: string; required: boolean; accepts: string; example: string }

export const SITE_COLUMN_GUIDE: SiteColumnGuide[] = [
  { key: 'name', required: true, accepts: 'Site name. Matches an existing site by name (case does not matter).', example: 'Example DC West' },
  { key: 'code', required: false, accepts: 'Short code, free text.', example: 'DCW' },
  { key: 'type', required: false, accepts: 'A site type key from the Reference sheet (datacenter, office, warehouse, …).', example: 'datacenter' },
  { key: 'status', required: false, accepts: 'A site status key from the Reference sheet. Blank means active for new sites.', example: 'active' },
  { key: 'address_line1', required: false, accepts: 'Street address. Also matches an existing site by address.', example: '100 Server Way' },
  { key: 'address_line2', required: false, accepts: 'Suite, floor, building.', example: '' },
  { key: 'city', required: false, accepts: 'Free text.', example: 'Reno' },
  { key: 'region', required: false, accepts: 'State or province.', example: 'NV' },
  { key: 'postal_code', required: false, accepts: 'Free text.', example: '89501' },
  { key: 'country', required: false, accepts: 'Two-letter code. Blank means US for new sites.', example: 'US' },
  { key: 'latitude', required: false, accepts: 'Decimal degrees, −90 to 90. Set with longitude or leave both blank.', example: '39.5296' },
  { key: 'longitude', required: false, accepts: 'Decimal degrees, −180 to 180.', example: '-119.8138' },
  { key: 'timezone', required: false, accepts: 'IANA zone name.', example: 'America/Los_Angeles' },
  { key: 'dc_provider', required: false, accepts: 'Free text.', example: 'Switch' },
  { key: 'partner', required: false, accepts: 'An existing partner name, exactly as listed.', example: '' },
  { key: 'clients', required: false, accepts: 'Existing client names separated by semicolons.', example: 'Acme Co; Globex' },
  { key: 'notes', required: false, accepts: 'Free text.', example: '' },
];

export const SITE_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per upload.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  rows_invalid: 'Some rows have problems — fix them and preview again.',
  forbidden: 'You do not have permission to bulk import.',
};
```

`portal/src/lib/siteBulk.test.ts`:

```ts
import { expect, it } from 'vitest';

import { SITE_COLUMN_GUIDE } from './siteBulk';

it('describes exactly the template columns, name first and required', () => {
  expect(SITE_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'name', 'code', 'type', 'status', 'address_line1', 'address_line2', 'city', 'region',
    'postal_code', 'country', 'latitude', 'longitude', 'timezone', 'dc_provider',
    'partner', 'clients', 'notes',
  ]);
  expect(SITE_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key)).toEqual(['name']);
});
```

- [ ] **Step 3: Write the failing upload tests** — `portal/src/components/sites/SiteBulkUpload.test.tsx` (port the three tests from `SiteBulkImport.test.tsx`, dropping the sample/textarea one; read that file for its mock setup):

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ previewSiteBulk: vi.fn(), commitSiteBulk: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: SiteBulkUpload } = await import('./SiteBulkUpload');

const row = (over: Record<string, unknown>) => ({
  row: 2, name: 'Site', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, site_id: null, data: { name: 'Site' }, ...over,
});

beforeEach(() => { api.previewSiteBulk.mockReset(); api.commitSiteBulk.mockReset(); });
afterEach(cleanup);

function pickFile() {
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['name\nX'], 'sites.csv', { type: 'text/csv' })] } });
}

it('previews and keeps Apply disabled while errors exist', async () => {
  api.previewSiteBulk.mockResolvedValue({ can_commit: false, rows: [
    row({ row: 2, name: 'Bad', action: 'error', errors: ['unknown type \'nope\''], data: null }),
    row({ row: 3, name: 'Good' }),
  ] });
  render(<SiteBulkUpload onDone={() => {}} />);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText("unknown type 'nope'")).toBeTruthy();
  expect(screen.getByText('new site')).toBeTruthy();
  expect(screen.getByText('1 to add · 0 to update · 0 unchanged · 1 error')).toBeTruthy();
  expect((screen.getByRole('button', { name: /Add 1 site/ }) as HTMLButtonElement).disabled).toBe(true);
});

it('gates Apply on approving every update, shows matched-by, commits approved ids', async () => {
  api.previewSiteBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'New Name', action: 'update', matched_by: 'address', matched_name: 'Old Name',
          site_id: 's1', diff: { name: { old: 'Old Name', new: 'New Name' } }, data: { name: 'New Name' } }),
    row({ row: 3, name: 'Fresh' }),
  ] });
  api.commitSiteBulk.mockResolvedValue({ created: 1, updated: 1, unchanged: 0 });
  const onDone = vi.fn();
  render(<SiteBulkUpload onDone={onDone} />);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('address')).toBeTruthy();
  const apply = screen.getByRole('button', { name: 'Add 1 site and update 1 site' }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Approve update to New Name'));
  expect(apply.disabled).toBe(false);
  fireEvent.click(apply);
  await waitFor(() => expect(api.commitSiteBulk).toHaveBeenCalledWith(
    [{ name: 'New Name' }, { name: 'Fresh' }], ['s1'], 'sites.csv'));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({ created: 1, updated: 1, unchanged: 0 }));
});
```

- [ ] **Step 4: `SiteBulkUpload.tsx`** — rewrite from `SiteBulkImport.tsx`: remove the textarea/sample/`textEdited`/`effectiveSource` logic; the source is the chosen `file` only; keep `toTemplateRow`, `describeDiff`, approval state, `DataTable`. Changes:

- imports: `SITE_BULK_ERRORS` from `../../lib/siteBulk` (delete the local `BULK_ERRORS`); no `downloadSiteTemplate`/`getSiteBulkSample`.
- `ACTION_LABEL = { create: 'Add', update: 'Update', unchanged: 'No change', error: 'Error' }`; `MATCH_LABEL = { name: 'name', address: 'address' }` with `null → 'new site'`.
- file input: `<label htmlFor="site-bulk-file">Upload a file (.csv or .xlsx)</label><input id="site-bulk-file" type="file" accept=".csv,.xlsx" …/>`.
- counts line under the preview: `{adds} to add · {updates} to update · {unchanged} unchanged · {errors} error{s}` where each count comes from `preview.rows`.
- apply button label: `Add ${adds} site${adds===1?'':'s'} and update ${updates} site${updates===1?'':'s'}` (disabled unless `preview.can_commit && allApproved && rows.some(r => r.action !== 'unchanged')`).
- table columns: Row, Name, Matched by, Action, Details; the Details cell as before.
- `runImport` calls `onDone(counts)` and clears the preview and file; no inline notice (the page shows the result).
- keep `.bulk-import`/`.bulk-actions`/`.bulk-preview`/`.bulk-row-*`/`.bulk-diff` class names; the action column is now the 4th `td` — update `sites.css` `.bulk-row-* td:nth-child(3)` to `:nth-child(4)` and delete the `.bulk-import textarea` rule.

- [ ] **Step 5: Modal and Sites toolbar** — in `SiteEditModal.tsx` remove the `SiteBulkImport` import, the `mode` state, the `canBulk` prop and its doc comment, the mode-toggle block, and the `mode === 'bulk' ? … : (` wrapper (keep the form as the only body); title back to `{title}`. In `Sites.tsx` remove `canBulk={canBulk}` from the modal, keep `canBulk` and add, next to `+ New site`:

```tsx
          {canBulk && (
            <button className="mini-btn accent" onClick={() => navigate('/bulk/sites')}>
              Bulk import…
            </button>
          )}
```

(`useNavigate` from react-router-dom; check whether `Sites.tsx` already imports it.) Delete `SiteBulkImport.tsx` and `SiteBulkImport.test.tsx`. If `SiteEditModal.test.tsx` passes `canBulk`, drop it.

- [ ] **Step 6: Run the suite and type check** → all PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add -A portal/src
git commit -m "feat(portal): SiteBulkUpload with matched-by and counts, column guide, export download; bulk tab leaves the New Site dialog"
```

---

### Task 4: Portal — `/bulk/sites` page and the Bulk Actions card

**Files:**
- Create: `portal/src/pages/BulkSites.tsx`
- Modify: `portal/src/pages/BulkActions.tsx` (first `BULK_TOOLS` entry)
- Modify: `portal/src/App.tsx` (route)
- Modify: `portal/src/styles/bulk.css`
- Test: create `portal/src/pages/BulkSites.test.tsx`; extend `portal/src/pages/BulkActions.test.tsx`

- [ ] **Step 1: Write the failing tests**

`portal/src/pages/BulkSites.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  downloadSiteTemplate: vi.fn(async () => {}), downloadSiteExport: vi.fn(async () => {}),
  previewSiteBulk: vi.fn(), commitSiteBulk: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(cleanup);
const { default: BulkSites } = await import('./BulkSites');

it('shows the column guide and the four downloads', async () => {
  render(<MemoryRouter><BulkSites /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Add or update sites in bulk' })).toBeTruthy();
  expect(screen.getByText('address_line1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Current sites (.xlsx)' }));
  await waitFor(() => expect(api.downloadSiteExport).toHaveBeenCalledWith('xlsx'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  await waitFor(() => expect(api.downloadSiteTemplate).toHaveBeenCalledWith('csv'));
});
```

In `BulkActions.test.tsx` add:

```tsx
it('lists the sites card when the viewer can add sites', () => {
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add or update sites in bulk')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
});
```

and change the existing empty-state test to mock `can: () => false` for its own render (a second `vi.mock` variant, or filter by `can` returning false for `sites`), so the empty state still has a test.

- [ ] **Step 2: Page** — `portal/src/pages/BulkSites.tsx`:

```tsx
/**
 * BulkSites — /bulk/sites: the column guide, template and export
 * downloads, then SiteBulkUpload (upload → preview → apply).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import SiteBulkUpload from '../components/sites/SiteBulkUpload';
import DataTable from '../components/DataTable';
import { downloadSiteExport, downloadSiteTemplate } from '../lib/api';
import { SITE_COLUMN_GUIDE } from '../lib/siteBulk';
import '../styles/bulk.css';
import '../styles/sites.css';

export default function BulkSites() {
  const [result, setResult] = useState<{ created: number; updated: number; unchanged: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const download = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try { await fn(); } catch { setError('Download failed — try again.'); } finally { setBusy(''); }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Bulk Actions</div>
      <h1 className="page-title">Add or update sites in bulk</h1>
      <p className="page-hint">
        Download the template or the current list, fill it in, upload it, and review every add and update before applying.
        Rows match existing sites by name or by street address.
      </p>

      <section className="bulk-section">
        <p className="eyebrow-sm">Columns</p>
        <DataTable
          ariaLabel="Template columns"
          columns={[
            { key: 'key', label: 'Column', mono: true },
            { key: 'required', label: 'Required' },
            { key: 'accepts', label: 'Accepts' },
            { key: 'example', label: 'Example', mono: true },
          ]}
          rows={SITE_COLUMN_GUIDE.map((c) => ({
            key: c.key, cells: [c.key, c.required ? 'Yes' : '', c.accepts, c.example || '—'],
          }))}
        />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Download</p>
        <div className="bulk-actions">
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-xlsx', () => downloadSiteTemplate('xlsx'))}>Template (.xlsx)</button>
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-csv', () => downloadSiteTemplate('csv'))}>Template (.csv)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-xlsx', () => downloadSiteExport('xlsx'))}>Current sites (.xlsx)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-csv', () => downloadSiteExport('csv'))}>Current sites (.csv)</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Upload</p>
        <SiteBulkUpload onDone={setResult} />
        {result && (
          <p className="set-note">
            Applied: {result.created} added, {result.updated} updated, {result.unchanged} unchanged.{' '}
            <Link to="/sites">Open Sites</Link>
          </p>
        )}
      </section>
    </div>
  );
}
```

Check `DataTable`'s row/column prop names in `portal/src/components/DataTable.tsx` and adjust. The `eyebrow-sm` class is scoped to `.detail-block` in directory.css; add the mirror rule `.bulk-section .eyebrow-sm { … }` copied from initiatives.css to `bulk.css` (and, if the list-typography guardrail objects because `.bulk-card`/`.bulk-grid` share the `bulk` family prefix, register it in `listTypography.allow.json` the way `.init-panel .eyebrow-sm` is). Also add `.bulk-section { margin-top: 18px; display: flex; flex-direction: column; gap: 10px; }`.

- [ ] **Step 3: Card and route** — in `BulkActions.tsx`:

```ts
export const BULK_TOOLS: BulkTool[] = [
  {
    key: 'sites', title: 'Add or update sites in bulk',
    description: 'Download a template or the current list, fill it in, upload it, and review adds and updates before applying.',
    resource: 'sites', action: 'add', to: '/bulk/sites', button: 'Open',
  },
];
```

In `App.tsx`, after the `/bulk` route:

```tsx
                <Route path="/bulk/sites" element={
                  <ProtectedRoute resource="sites" minRank={ADMIN_RANK}><BulkSites /></ProtectedRoute>
                } />
```

with the import in alphabetical position.

- [ ] **Step 4: Run the suite and type check** → all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src
git commit -m "feat(portal): /bulk/sites page with column guide, downloads and upload; first Bulk Actions card"
```

---

### Task 6: Review summary after Apply

**Files:**
- Modify: `api/src/serversherpa/sites/bulk_import.py` (`_create_site` returns the site; `commit_rows` returns `rows`)
- Modify: `api/src/serversherpa/api/schemas.py` only if a response model exists for commit (it does not today — the route returns a dict; keep it a dict)
- Modify: `portal/src/lib/api.ts` (`commitSiteBulk` return type)
- Create: `portal/src/components/sites/BulkApplySummary.tsx`
- Modify: `portal/src/components/sites/SiteBulkUpload.tsx` (keep the result, render the summary, `onDone(result)`)
- Modify: `portal/src/pages/BulkSites.tsx` (drop its own "Applied:" line; the summary carries the Open Sites link)
- Test: `api/tests/test_sites_bulk_import_service.py`, `api/tests/test_sites_bulk_import_api.py`, `portal/src/components/sites/SiteBulkUpload.test.tsx`, `portal/src/pages/BulkSites.test.tsx`

**Interfaces:**
- Produces: `commit_rows` → `{"created", "updated", "unchanged", "rows": [{"row": n, "name": str, "site_id": str, "action": "created"|"updated"|"unchanged", "diff": dict|None}]}` in upload order; `BulkCommitResult` / `BulkAppliedRow` types; `BulkApplySummary` props `{ result: BulkCommitResult }`; `SiteBulkUpload.onDone(result: BulkCommitResult)`.

- [ ] **Step 1: Write the failing tests**

Service — in `test_commit_creates_sites_links_and_audit` (and any other test asserting the exact commit return value) change the equality on counts to also expect `rows`; add:

```python
async def test_commit_returns_per_row_results(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Keep Me", city="Old", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "Keep Me", "city": "New"},
                                {"name": "Fresh One"},
                                {"name": "Keep Me 2"}])
    keep = (await bi.preview_rows(db, rows))["rows"][0]["site_id"]
    out = await bi.commit_rows(db, seeded_user.id, rows, approved_updates={keep},
                               source_label="t.csv")
    assert (out["created"], out["updated"], out["unchanged"]) == (2, 1, 0)
    assert [r["action"] for r in out["rows"]] == ["updated", "created", "created"]
    assert out["rows"][0] == {"row": 1, "name": "Keep Me", "site_id": keep,
                              "action": "updated", "diff": {"city": {"old": "Old", "new": "New"}}}
    assert all(r["site_id"] for r in out["rows"])
    assert out["rows"][1]["diff"] is None
```

API — in `test_commit_end_to_end` change the exact-equality assertion to check the three counts and `len(body["rows"]) == 2` with actions `["created", "created"]` and non-null `site_id`s.

Portal — `SiteBulkUpload.test.tsx`: in the approval test, make `commitSiteBulk` resolve `{ created: 1, updated: 1, unchanged: 0, rows: [ { row: 2, name: 'New Name', site_id: 's1', action: 'updated', diff: { name: { old: 'Old Name', new: 'New Name' } } }, { row: 3, name: 'Fresh', site_id: 's2', action: 'created', diff: null } ] }`, assert `onDone` receives that object, and add assertions that the summary renders: `screen.getByText('Applied: 1 added · 1 updated · 0 unchanged')`, a link with text `New Name` whose `href` ends with `/sites?open=s1`, the text `name: Old Name → New Name`, the row text `Added` for Fresh, and a button `Download summary (.csv)`. Mock `exportCsv` from `../../lib/listTools` (hoisted) and assert it is called with `'sites-bulk-summary'`, four columns, and the two rows when the button is clicked. Add a test that choosing a new file clears the summary. `BulkSites.test.tsx`: remove any assertion about the page's own "Applied:" text if present.

- [ ] **Step 2: Run to verify failures** (API: the two bulk test files on `serversherpa_test_bulksites`; portal: the two files) → FAIL.

- [ ] **Step 3: API** — in `bulk_import.py`: `_create_site` ends with `return site`. In `commit_rows`, build `applied: list[dict] = []`; for each preview row append `{"row": r["row"], "name": r["name"], "site_id": <str(site.id) for created / r["site_id"] otherwise>, "action": "unchanged"|"created"|"updated", "diff": r["diff"] if updated else None}`; return `{"created": ..., "updated": ..., "unchanged": ..., "rows": applied}`. Include `"rows": len(applied)` nowhere in the audit (keep the audit changes as they are).

- [ ] **Step 4: Portal types** — in `lib/api.ts`:

```ts
export interface BulkAppliedRow {
  row: number; name: string; site_id: string;
  action: 'created' | 'updated' | 'unchanged';
  diff: BulkRowResult['diff'];
}
export interface BulkCommitResult { created: number; updated: number; unchanged: number; rows: BulkAppliedRow[] }
```

and `commitSiteBulk(...): Promise<BulkCommitResult>`.

- [ ] **Step 5: `BulkApplySummary.tsx`**

```tsx
/**
 * BulkApplySummary — what a bulk apply actually did, one row per site, with
 * a CSV download so the run can be attached to a ticket. Server truth: it
 * renders the commit response, never the pre-apply preview.
 */
import { Link } from 'react-router-dom';

import type { BulkCommitResult } from '../../lib/api';
import { exportCsv } from '../../lib/listTools';
import DataTable from '../DataTable';

const RESULT_LABEL = { created: 'Added', updated: 'Updated', unchanged: 'No change' } as const;

export function changesText(diff: BulkCommitResult['rows'][number]['diff']): string {
  if (!diff) return '';
  return Object.entries(diff).map(([field, change]) => {
    if (field === 'clients') {
      const add = (change.add ?? []).map((n) => `+${n}`);
      const remove = (change.remove ?? []).map((n) => `−${n}`);
      return `clients: ${[...add, ...remove].join(', ')}`;
    }
    const from = change.old === null || change.old === undefined ? '—' : String(change.old);
    return `${field}: ${from} → ${String(change.new)}`;
  }).join('; ');
}

export default function BulkApplySummary({ result }: { result: BulkCommitResult }) {
  const download = () => exportCsv('sites-bulk-summary', [
    ['Row', (r) => String(r.row)],
    ['Site', (r) => r.name],
    ['Result', (r) => RESULT_LABEL[r.action]],
    ['Changes', (r) => changesText(r.diff)],
  ], result.rows);

  return (
    <div className="bulk-summary">
      <div className="bulk-actions">
        <b>Applied: {result.created} added · {result.updated} updated · {result.unchanged} unchanged</b>
        <button className="mini-btn" type="button" onClick={download}>Download summary (.csv)</button>
        <Link className="mini-btn" to="/sites">Open Sites</Link>
      </div>
      <DataTable
        ariaLabel="Apply summary"
        className="bulk-preview"
        columns={[
          { key: 'row', label: 'Row', width: '64px', mono: true },
          { key: 'site', label: 'Site' },
          { key: 'result', label: 'Result' },
          { key: 'changes', label: 'Changes' },
        ]}
        rows={result.rows.map((r) => ({
          key: String(r.row),
          className: `bulk-row-${r.action === 'created' ? 'create' : r.action === 'updated' ? 'update' : 'unchanged'}`,
          cells: [
            r.row,
            <Link key="site" to={`/sites?open=${r.site_id}`}>{r.name}</Link>,
            RESULT_LABEL[r.action],
            changesText(r.diff) || '—',
          ],
        }))}
      />
    </div>
  );
}
```

Check `DataTable` cell typing accepts a `ReactNode` (it did for the preview's Details cell). The Result column is the 3rd `td` here; add `.bulk-summary .bulk-row-update td:nth-child(3)` / `create` color rules in `sites.css` mirroring the preview's, or (simpler) give the summary table its own class `bulk-summary-table` and rules keyed on it. No typography properties.

- [ ] **Step 6: Wire `SiteBulkUpload`** — state `const [result, setResult] = useState<BulkCommitResult | null>(null)`; `runImport` sets `setResult(counts)` and calls `onDone(counts)`; choosing a file sets `setResult(null)`; render `{result && <BulkApplySummary result={result} />}` below the actions and above where the preview would be. `BulkSites.tsx`: `onDone` no longer needs to store counts; delete the `result` state and the "Applied:" paragraph (the summary component has the Open Sites link).

- [ ] **Step 7: Run** the API files (`SS_TEST_DB=serversherpa_test_bulksites …`), the whole portal suite and `tsc` → all PASS.

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/sites/bulk_import.py api/tests/test_sites_bulk_import_service.py api/tests/test_sites_bulk_import_api.py portal/src
git commit -m "feat(sites): bulk apply returns per-row results; review summary with CSV download after Apply"
```

---

### Task 5: Full suites

- [ ] `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib SS_TEST_DB=serversherpa_test_bulksites PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests -q` → all PASS.
- [ ] `npm --prefix portal run test` and `(cd portal && node_modules/.bin/tsc --noEmit)` → all PASS.
- [ ] Append `Task 5: full suites green` to `.superpowers/sdd/progress.md`.
