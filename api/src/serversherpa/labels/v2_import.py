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
from collections.abc import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.db.models import (
    LabelTemplate, LabelTemplateSite, LabelVocab, Site,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.sites.v2_import import insert_rows

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
