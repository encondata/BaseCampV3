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
