# V2 Label-Template Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `serversherpa import-v2-label-templates --dump <path> [--dry-run]` — imports the 5 Zebra V2 templates as inactive raw-code V3 templates with translated placeholders, inferred sizes, and resolved site assignments; idempotent upsert-by-name.

**Architecture:** A pure translation/mapping layer (`translate_code`, `infer_size`, maps) plus an async importer in `serversherpa/labels/v2_import.py` that streams rows via the existing `sites/v2_import.insert_rows` parser and stages writes on the session; the typer CLI commits or (dry-run) rolls back, exactly like `import-v2-status-rules`.

**Tech Stack:** Python/SQLAlchemy async/typer/pytest (real Postgres), no new deps.

**Spec:** `docs/superpowers/specs/2026-09-02-labels-v2-import-design.md`

## Global Constraints

- All suites FOREGROUND, one continuous run, `timeout: 600000` ms; NEVER background a run, never use Monitor, never end a turn "waiting". API suite: `cd api && .venv/bin/pytest` (972 tests at branch HEAD `61cffe6`).
- `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty; never commit it.
- Skip non-zebra printer_type rows (the epson twin) with a logged reason. Imports land `is_active=False`; re-runs NEVER touch `is_active`. Upsert by name; a name held by a `kind='design'` template is skipped with a warning. An update that changes nothing writes nothing (no version bump, no audit); a real change bumps `version` once. Audit `entity_type="label_template"`, `action="v2_import"`.
- Type map: `asset_top`→`top`, `asset_front`→`front`, `manifest`→`container`, unknown→`top`+note. Language: `zebra` (case-insensitive)→`zpl`. DPI: `203`. Size: `^PW`/`^LL` at 203 dpi vs active size vocab ±0.05 in, else `4x2` — logged.
- Site resolution: V2 CSV id → `Site.source_ref == "backup_20260825_193157:sites/<id>"`; misses logged + skipped; NULL/empty CSV → global.
- Placeholder translation: `{row['<alias>']}` / `{'<alias>'}` (quote chars `' " \` ‘ ’ “ ”`) and bare `{<alias>}` → V3 keys via the alias map; bare tokens already matching `^[a-z0-9_]+$` and not alias-mapped stay silently; handlebars `{{...}}` and unknown aliases stay VERBATIM and are reported by token.
- No changes to route/schema files — importer + CLI + tests only.

---

### Task 1: Pure translation + mapping functions

**Files:**
- Create: `api/src/serversherpa/labels/v2_import.py`
- Test: `api/tests/test_labels_v2_import_translate.py`

**Interfaces:**
- Consumes: nothing (pure functions; module also hosts Task 2's importer later).
- Produces: `translate_code(code: str) -> tuple[str, list[str]]` (translated code, sorted deduped untranslated-token report incl. handlebars); `infer_size(code: str, sizes: list[tuple[str, float, float]]) -> tuple[str, str]` ((size_key, note)); `map_label_type(v2_type: str | None) -> tuple[str, str | None]` ((v3 key, note-or-None)); constants `V2_ALIASES: dict[str, str]`, `V2_COLS: tuple[str, ...]`, `_SOURCE = "backup_20260825_193157"`.

- [ ] **Step 1: Write the failing tests `api/tests/test_labels_v2_import_translate.py`**

```python
"""Pure V2->V3 translation/mapping units for the label-template import."""

from serversherpa.labels.v2_import import (
    infer_size, map_label_type, translate_code,
)

SIZES = [("4x2", 4.0, 2.0), ("2x1", 2.0, 1.0), ("1x1", 1.0, 1.0)]


def test_translate_row_and_quoted_forms():
    out, missed = translate_code(
        "^FD{row['asset id']}^FS ^FD{'serial'}^FS ^FD{\"make_model\"}^FS")
    assert "^FD{asset_id}^FS" in out
    assert "^FD{serial_number}^FS" in out
    assert "^FD{make_model}^FS" in out
    assert missed == []


def test_translate_curly_quotes_and_backtick():
    out, missed = translate_code(
        "‘asset id’: {‘asset id’} and {`source`}")
    assert "{asset_id}" in out and "{source_raw}" in out
    assert missed == []


def test_translate_bare_alias_with_space():
    out, missed = translate_code("^FD{asset id} / {destination site}^FS")
    assert out == "^FD{asset_id} / {destination_site}^FS"
    assert missed == []


def test_valid_v3_bare_token_untouched_and_unreported():
    out, missed = translate_code("^FD{serial_number} {custom_field}^FS")
    assert "{serial_number}" in out and "{custom_field}" in out
    assert missed == []  # both already match ^[a-z0-9_]+$


def test_unknown_alias_reported_verbatim():
    out, missed = translate_code("^FD{row['asset track']}^FS {moves_id}")
    assert "{row['asset track']}" in out          # left verbatim
    assert "{moves_id}" in out                    # valid V3 shape, silent
    assert missed == ["{row['asset track']}"]


def test_handlebars_untouched_and_reported():
    src = "^LL{{CALCULATED}} {{#assets}}x{{/assets}} {{QRCODE:{{QR:manifestNumber}}}}"
    out, missed = translate_code(src)
    assert out == src
    assert "{{CALCULATED}}" in missed
    assert "{{#assets}}" in missed
    assert "{{QR:manifestNumber}}" in missed


def test_infer_size_exact_and_tolerance():
    key, note = infer_size("^XA^PW812^LL406^XZ", SIZES)
    assert key == "4x2" and "812x406" in note
    key, _ = infer_size("^XA^PW406^LL203^XZ", SIZES)   # 2.0 x 1.0 exactly
    assert key == "2x1"
    key, _ = infer_size("^XA^PW410^LL200^XZ", SIZES)   # within 0.05in
    assert key == "2x1"


def test_infer_size_fallbacks():
    key, note = infer_size("^XA^PW999^LL999^XZ", SIZES)
    assert key == "4x2" and "no vocab match" in note
    key, note = infer_size("^XA^LL{{CALCULATED}}^PW609^XZ", SIZES)
    assert key == "4x2" and "no literal" in note


def test_map_label_type():
    assert map_label_type("asset_top") == ("top", None)
    assert map_label_type("asset_front") == ("front", None)
    assert map_label_type("manifest") == ("container", None)
    key, note = map_label_type("mystery")
    assert key == "top" and "mystery" in note
    key, note = map_label_type(None)
    assert key == "top" and note is not None
```

- [ ] **Step 2: Run → FAIL**

Run: `cd api && .venv/bin/pytest tests/test_labels_v2_import_translate.py -v` (foreground, timeout 600000)
Expected: FAIL — `ModuleNotFoundError: serversherpa.labels.v2_import`.

- [ ] **Step 3: Create `api/src/serversherpa/labels/v2_import.py` (pure layer)**

```python
"""V2 -> V3 label-template import.

`serversherpa import-v2-label-templates` — like status_rules/v2_import.py:
stream the dump's INSERT rows, translate, upsert by name. This module's
top half is pure (translation/mapping, unit-tested without a DB); the
importer entry point (import_label_templates) stages writes on the caller's
session so the CLI can commit or roll back (--dry-run).

Placeholder policy: V2's quote-variant spellings become V3 `{key}` tokens
via the exact alias table from V2 label_generator.build_label_field_values.
Handlebars `{{...}}` (manifest loops) and unknown aliases stay VERBATIM and
are reported so review knows what to hand-fix — imports land inactive.
"""

import re

# Identifies this dump for source_ref traceability (matches sites import).
_SOURCE = "backup_20260825_193157"

V2_COLS = ("id", "template_name", "printer_type", "template_code", "sites",
           "type", "is_active", "version", "created_at", "updated_at",
           "label_generation_code", "label_generation_code_json")

V2_ALIASES: dict[str, str] = {
    "asset id": "asset_id", "asset_id": "asset_id",
    "name": "asset_name", "asset name": "asset_name",
    "asset_name": "asset_name",
    "asset_serial_number": "serial_number",
    "serial_number": "serial_number", "serial": "serial_number",
    "make": "make", "model": "model",
    "assets.make_model": "make_model", "make_model": "make_model",
    "source_raw": "source_raw", "source": "source_raw",
    "source_ru": "source_ru",
    "source site": "source_site", "source_site": "source_site",
    "destination_raw": "destination_raw", "destination": "destination_raw",
    "destination_ru": "destination_ru",
    "destination site": "destination_site",
    "destination_site": "destination_site",
    "move date": "move_date", "move_date": "move_date",
    "move_name": "move_name",
}

_TYPE_MAP = {"asset_top": "top", "asset_front": "front",
             "manifest": "container"}

_Q = "'\"`‘’“”"
# Single-brace tokens only — (?<!\{) / (?!\}) keep handlebars {{...}} inert.
_ROW_RE = re.compile(
    r"(?<!\{)\{row\[[" + _Q + r"]([^\]{}]+?)[" + _Q + r"]\]\}(?!\})")
_QUOTED_RE = re.compile(
    r"(?<!\{)\{[" + _Q + r"]([^{}" + _Q + r"]+?)[" + _Q + r"]\}(?!\})")
_BARE_RE = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")
_HANDLEBARS_RE = re.compile(r"\{\{[#/]?[^{}]*\}\}")
_V3_TOKEN_RE = re.compile(r"^[a-z0-9_]+$")


def translate_code(code: str) -> tuple[str, list[str]]:
    """Translate V2 placeholder spellings to V3 {key} tokens.

    Returns (translated code, sorted deduped report of tokens left
    verbatim — unknown aliases and handlebars blocks)."""
    missed: set[str] = set()

    def _alias(m: re.Match) -> str:
        key = V2_ALIASES.get(m.group(1).strip())
        if key is not None:
            return "{" + key + "}"
        missed.add(m.group(0))
        return m.group(0)

    def _bare(m: re.Match) -> str:
        inner = m.group(1)
        key = V2_ALIASES.get(inner.strip())
        if key is not None:
            return "{" + key + "}"
        if _V3_TOKEN_RE.match(inner):
            return m.group(0)          # already a valid V3 token — silent
        missed.add(m.group(0))
        return m.group(0)

    out = _ROW_RE.sub(_alias, code)
    out = _QUOTED_RE.sub(_alias, out)
    out = _BARE_RE.sub(_bare, out)
    missed.update(_HANDLEBARS_RE.findall(code))
    return out, sorted(missed)


def infer_size(code: str,
               sizes: list[tuple[str, float, float]]) -> tuple[str, str]:
    """Match the template's own ^PW/^LL (dots at 203 dpi) to a size key.

    `sizes` = [(key, width_in, height_in), ...] for ACTIVE size vocab rows.
    Returns (size_key, human note for the import log)."""
    pw = re.search(r"\^PW(\d+)", code)
    ll = re.search(r"\^LL(\d+)", code)
    if not pw or not ll:
        return "4x2", "no literal ^PW/^LL found — defaulted to 4x2"
    w, h = int(pw.group(1)) / 203, int(ll.group(1)) / 203
    for key, sw, sh in sizes:
        if abs(sw - w) <= 0.05 and abs(sh - h) <= 0.05:
            return key, f"^PW/^LL {pw.group(1)}x{ll.group(1)} -> {key}"
    return "4x2", (f"^PW/^LL gives {w:.2f}x{h:.2f} in — "
                   "no vocab match, defaulted to 4x2")


def map_label_type(v2_type: str | None) -> tuple[str, str | None]:
    """(v3 label_type key, note-or-None) for a V2 `type` value."""
    key = _TYPE_MAP.get(v2_type or "")
    if key is not None:
        return key, None
    return "top", f"unknown V2 type {v2_type!r} — defaulted to top"
```

- [ ] **Step 4: Run focused → PASS**

If a regex fails a test, debug the regex against the test string in a `python -c` one-liner — do not weaken the tests.

- [ ] **Step 5: Full API suite foreground → green, commit**

```bash
git add -A api && git commit -m "feat(api): V2 label-template translation + mapping layer"
```

---

### Task 2: Importer + CLI

**Files:**
- Modify: `api/src/serversherpa/labels/v2_import.py` (append the importer)
- Modify: `api/src/serversherpa/cli.py` (new command)
- Test: `api/tests/test_labels_v2_import_api.py`

**Interfaces:**
- Consumes: Task 1's pure layer; `insert_rows(dump_path, table)` from `serversherpa.sites.v2_import`; models `LabelTemplate`, `LabelTemplateSite`, `LabelVocab`, `Site`; `audit` from `serversherpa.services.audit`.
- Produces: `async import_label_templates(db, dump_path: str) -> dict` with keys `created: list[str]`, `updated: list[str]`, `unchanged: list[str]`, `skipped: list[tuple[str, str]]`, `notes: list[str]` (per-template size/type/site/translation notes, prefixed with the template name); CLI `serversherpa import-v2-label-templates --dump <path> [--dry-run]` (dry-run = stage + rollback, like import-v2-status-rules).

- [ ] **Step 1: Write the failing tests `api/tests/test_labels_v2_import_api.py`**

```python
"""End-to-end V2 label-template import against the test DB."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, LabelTemplate, LabelTemplateSite, Site,
)
from serversherpa.labels.v2_import import import_label_templates

ZPL = ("^XA\\n^PW406^LL203\\n^FO10,10^FD{row=Q=asset id=Q=}^FS\\n"
       "^FT10,110^FDTarget: {row=Q=asset track=Q=}^FS\\n^XZ").replace(
           "=Q=", "''")

DUMP_TEMPLATE = """
INSERT INTO label_templates (id, template_name, printer_type, template_code, sites, type, is_active, version, created_at, updated_at, label_generation_code, label_generation_code_json) VALUES (5, 'Vegas Destination', 'Zebra', '{zpl}', '3,99', 'asset_top', TRUE, 1, '2025-01-01 00:00:00+00', '2025-01-01 00:00:00+00', NULL, NULL);
INSERT INTO label_templates (id, template_name, printer_type, template_code, sites, type, is_active, version, created_at, updated_at, label_generation_code, label_generation_code_json) VALUES (3, 'container_manifest', 'epson', '{{{{INIT}}}}{{{{LF}}}}', NULL, 'manifest', TRUE, 1, '2025-01-01 00:00:00+00', '2025-01-01 00:00:00+00', NULL, NULL);
"""


def _write_dump(tmp_path):
    p = tmp_path / "v2.sql"
    p.write_text(DUMP_TEMPLATE.format(zpl=ZPL))
    return str(p)


async def _seed_site(db):
    s = Site(name="NAP11 - Switch",
             source_ref="backup_20260825_193157:sites/3")
    db.add(s)
    await db.commit()
    return s.id


async def test_import_creates_translated_inactive_template(db, tmp_path,
                                                           seeded_user):
    site_id = await _seed_site(db)
    stats = await import_label_templates(db, _write_dump(tmp_path))
    await db.commit()
    assert stats["created"] == ["Vegas Destination"]
    assert ("container_manifest",
            "printer_type 'epson' unsupported") in stats["skipped"]
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    assert row.kind == "code" and row.is_active is False
    assert row.language_key == "zpl" and row.dpi_key == "203"
    assert row.size_key == "2x1"            # 406x203 dots @203dpi = 2x1
    assert row.label_type == "top"
    assert "{asset_id}" in row.code
    assert "{row['asset track']}" in row.code   # unknown alias verbatim
    assert "v2 id 5" in row.description
    links = (await db.execute(select(LabelTemplateSite.site_id).where(
        LabelTemplateSite.template_id == row.id))).scalars().all()
    assert links == [site_id]               # id 99 unresolvable -> skipped
    assert any("99" in n for n in stats["notes"])
    assert any("asset track" in n for n in stats["notes"])
    audit_row = (await db.execute(select(AuditLog).where(
        AuditLog.entity_type == "label_template",
        AuditLog.action == "v2_import"))).scalars().first()
    assert audit_row is not None


async def test_reimport_is_idempotent_and_preserves_activation(
        db, tmp_path, seeded_user):
    await _seed_site(db)
    dump = _write_dump(tmp_path)
    await import_label_templates(db, dump)
    await db.commit()
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    first_version = row.version
    row.is_active = True                     # user activates it
    await db.commit()
    stats = await import_label_templates(db, dump)
    await db.commit()
    assert stats["unchanged"] == ["Vegas Destination"]
    await db.refresh(row)
    assert row.version == first_version      # no churn
    assert row.is_active is True             # activation preserved


async def test_design_kind_name_collision_is_skipped(db, tmp_path,
                                                     seeded_user):
    await _seed_site(db)
    db.add(LabelTemplate(name="Vegas Destination", label_type="top",
                         size_key="4x2", dpi_key="203", language_key="zpl",
                         kind="design",
                         design={"size": {"w": 4, "h": 2}, "elements": []}))
    await db.commit()
    stats = await import_label_templates(db, _write_dump(tmp_path))
    await db.commit()
    assert any(name == "Vegas Destination" and "design" in reason
               for name, reason in stats["skipped"])
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    assert row.kind == "design"              # untouched
```

Notes for the implementer: `AuditLog` — check the actual model name for the audit table in `db/models.py` (grep `class AuditLog`); if it differs, adapt the import/assert (do not skip the assertion). `seeded_user` is requested only to match suite conventions for fixtures that need a person; if `audit(actor_id=None, ...)` needs no person, it may be dropped.

- [ ] **Step 2: Run → FAIL (`import_label_templates` missing)**

- [ ] **Step 3: Append the importer to `api/src/serversherpa/labels/v2_import.py`**

```python
from collections.abc import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.db.models import (
    LabelTemplate, LabelTemplateSite, LabelVocab, Site,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.sites.v2_import import insert_rows

_UPDATE_FIELDS = ["code", "description", "label_type", "size_key",
                  "dpi_key", "language_key"]


def _rows(dump_path: str, table: str, cols: tuple) -> Iterator[dict]:
    for values in insert_rows(dump_path, table):
        if len(values) == len(cols):
            yield dict(zip(cols, values))


async def _active_sizes(db: AsyncSession) -> list[tuple[str, float, float]]:
    rows = (await db.execute(select(LabelVocab).where(
        LabelVocab.kind == "size", LabelVocab.is_active))).scalars().all()
    out = []
    for r in rows:
        w, h = r.meta.get("width_in"), r.meta.get("height_in")
        if isinstance(w, (int, float)) and isinstance(h, (int, float)):
            out.append((r.key, float(w), float(h)))
    return out


async def _site_map(db: AsyncSession) -> dict[str, object]:
    """V2 site id (str) -> V3 site uuid, via source_ref traceability."""
    prefix = f"{_SOURCE}:sites/"
    rows = (await db.execute(select(Site.id, Site.source_ref).where(
        Site.source_ref.like(prefix + "%")))).all()
    return {ref.removeprefix(prefix): sid for sid, ref in rows}


async def import_label_templates(db: AsyncSession, dump_path: str) -> dict:
    """Stage the import on `db` (caller commits; --dry-run rolls back)."""
    stats: dict = {"created": [], "updated": [], "unchanged": [],
                   "skipped": [], "notes": []}
    sizes = await _active_sizes(db)
    site_map = await _site_map(db)

    for row in _rows(dump_path, "label_templates", V2_COLS):
        name = row["template_name"]
        printer = str(row["printer_type"] or "").lower()
        if printer != "zebra":
            stats["skipped"].append(
                (name, f"printer_type '{row['printer_type']}' unsupported"))
            continue

        code, missed = translate_code(row["template_code"] or "")
        label_type, type_note = map_label_type(row["type"])
        size_key, size_note = infer_size(code, sizes)
        for token in missed:
            stats["notes"].append(f"{name}: untranslated {token}")
        if type_note:
            stats["notes"].append(f"{name}: {type_note}")
        stats["notes"].append(f"{name}: {size_note}")

        site_ids = []
        for v2_id in str(row["sites"] or "").split(","):
            v2_id = v2_id.strip()
            if not v2_id:
                continue
            sid = site_map.get(v2_id)
            if sid is None:
                stats["notes"].append(
                    f"{name}: V2 site {v2_id} not found in V3 — skipped")
            else:
                site_ids.append(sid)

        mapped = {"code": code,
                  "description": f"Imported from V2 backup (v2 id {row['id']}).",
                  "label_type": label_type, "size_key": size_key,
                  "dpi_key": "203", "language_key": "zpl"}

        existing = (await db.execute(select(LabelTemplate)
            .options(selectinload(LabelTemplate.site_links))
            .where(LabelTemplate.name == name))).scalar_one_or_none()

        if existing is not None and existing.kind == "design":
            stats["skipped"].append(
                (name, "a design-kind template already holds this name"))
            continue

        if existing is None:
            tpl = LabelTemplate(name=name, kind="code", is_active=False,
                                **mapped)
            db.add(tpl)
            await db.flush()
            for sid in site_ids:
                db.add(LabelTemplateSite(template_id=tpl.id, site_id=sid))
            changes = diff({}, snapshot(tpl, _UPDATE_FIELDS))
            if site_ids:
                changes["site_ids"] = {"from": [],
                                       "to": sorted(str(s) for s in site_ids)}
            audit(db, actor_id=None, entity_type="label_template",
                  entity_id=str(tpl.id), action="v2_import", changes=changes)
            stats["created"].append(name)
            continue

        before = snapshot(existing, _UPDATE_FIELDS)
        for field, value in mapped.items():
            setattr(existing, field, value)
        changes = diff(before, snapshot(existing, _UPDATE_FIELDS))
        current = sorted(str(l.site_id) for l in existing.site_links)
        incoming = sorted(str(s) for s in site_ids)
        if current != incoming:
            changes["site_ids"] = {"from": current, "to": incoming}
            existing.site_links = [
                LabelTemplateSite(template_id=existing.id, site_id=sid)
                for sid in site_ids]
        if not changes:
            stats["unchanged"].append(name)
            continue
        existing.version += 1
        audit(db, actor_id=None, entity_type="label_template",
              entity_id=str(existing.id), action="v2_import",
              changes=changes)
        stats["updated"].append(name)

    return stats
```

- [ ] **Step 4: CLI command in `api/src/serversherpa/cli.py`** (place next to `import_v2_status_rules`, mirroring its structure exactly)

```python
@app.command()
def import_v2_label_templates(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
) -> None:
    """Import V2 label templates as inactive raw-code V3 templates.
    Upserts by name; skips non-Zebra printers and design-kind name
    collisions; placeholders translated where mappable."""

    async def _run() -> None:
        from serversherpa.labels.v2_import import import_label_templates

        async with get_sessionmaker()() as db:
            stats = await import_label_templates(db, dump)
            for name, reason in stats["skipped"]:
                typer.secho(f"skipped: {name} — {reason}", fg="yellow")
            for note in stats["notes"]:
                typer.secho(f"note: {note}", fg="yellow")
            summary = (f"{len(stats['created'])} created (inactive), "
                       f"{len(stats['updated'])} updated, "
                       f"{len(stats['unchanged'])} unchanged, "
                       f"{len(stats['skipped'])} skipped")
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] {summary}", fg="yellow")
            else:
                await db.commit()
                typer.secho(summary, fg="green")
        await dispose_engine()

    asyncio.run(_run())
```

- [ ] **Step 5: Run focused → PASS, FULL API suite foreground → green**

- [ ] **Step 6: Commit**

```bash
git add -A api && git commit -m "feat(api): import-v2-label-templates CLI — translated, inactive, site-resolved"
```

---

### Task 3: Verification — run against the dev DB

**Files:** none expected (fixes only if found).

- [ ] **Step 1:** FULL API suite foreground → green (Task 2 already ran it; re-run only if anything changed since). `git status` clean.
- [ ] **Step 2:** Dry-run against the real dump:

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/serversherpa import-v2-label-templates --dump backups/backup_20260825_193157.sql --dry-run
```

Expected: `[dry-run] 5 created (inactive), 0 updated, 0 unchanged, 1 skipped`; the epson skip line; notes for size inference on all five, untranslated tokens on Vegas/Amsterdam/Generic (`asset track`, `asset tpos`) and the manifest handlebars; NO "V2 site … not found" lines (all 9 ids resolve in dev).

- [ ] **Step 3:** Real run (same command without `--dry-run`) → `5 created (inactive), …`. Re-run once more → `0 created, 0 updated, 5 unchanged` (idempotency against the live DB).
- [ ] **Step 4:** Browser spot-check (known login/scroll quirks): Templates list shows the five new rows, Inactive chips, kind "Raw code"; `Vegas Destination` Sites cell shows a name `+3`; open one in the editor — code textarea holds translated `{asset_id}`-style tokens. Screenshot as proof.
- [ ] **Step 5:** Confirm commits; leave branch unmerged.

## Out of scope (per spec)

ESC/POS language; translating manifest handlebars; importing V2 generation config.
