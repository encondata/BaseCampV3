"""Render one label from a template + placeholder values — the pure core of
labels/generate/engine.py, shared by the portal generator and the laptop
edge (which imports it straight from api/src). No serversherpa.db, no
sqlalchemy: the template is anything with the `TemplateSource` attributes.

Both template kinds go through the SAME code path the Variables →
Labels editor uses for preview/compile (labels/compile.py's
`compile_parsed_design`) — no caller has its own copy of the
ZPL/ESC-P/P-touch dispatch.

Unknown tokens are scanned separately from compiling (V3 deliberately
reports them instead of silently blanking them — see
docs/superpowers/specs/2026-09-11-generate-labels-design.md
§Deliberate differences): a `code` kind scans the raw code string; a
`design` kind scans every text-bearing element (text content, barcode/QR
data) after parsing. The label itself is still produced either way —
unresolved tokens compile to "" via labels/tokens.py, same as always.

A schema 2 design has no tokens: its elements name field keys, and the
values pass straight to the compiler. The keys it names that `values`
lacks are reported the same way (they print blank). A schema 3 design is
schema 2 plus images: `images` (element id -> dithered bitmap, resolved by
the caller) passes through to the compiler, or `image_placeholders` (every
image a crossed box), and an image is never a key, so never unknown."""

from collections.abc import Mapping
from typing import Protocol

from serversherpa.labels.compile import compile_parsed_design
from serversherpa.labels.dither import Bitmap
from serversherpa.labels.model import BarcodeEl, QrEl, TextEl, parse_design
from serversherpa.labels.tokens import TOKEN_RE, apply_placeholders


class TemplateSource(Protocol):
    kind: str
    code: str | None
    design: dict | None
    language_key: str


def _unknown(tokens: set[str], values: dict[str, str]) -> set[str]:
    return {t for t in tokens if t not in values}


def render_template(
    template: TemplateSource, values: dict[str, str], *,
    width_in: float, height_in: float, dots: int,
    images: Mapping[str, Bitmap] | None = None,
    image_placeholders: bool = False,
) -> tuple[str, set[str]]:
    """The printer code for one label and the tokens it left unresolved."""
    if template.kind == "code":
        code_src = template.code or ""
        tokens = set(TOKEN_RE.findall(code_src))
        return apply_placeholders(code_src, values), _unknown(tokens, values)

    design_json = template.design or {}
    # parsed ONCE — the token scan below and the compile both work off
    # this same Design object, rather than parsing design_json twice
    design = parse_design({**design_json, "size": {"w": width_in, "h": height_in}})
    if design.schema >= 2:
        keys = {el.field for el in design.elements if getattr(el, "field", None)}
        code = compile_parsed_design(design, dots=dots, language_key=template.language_key,
                                     subs=values, images=images,
                                     image_placeholders=image_placeholders)
        return code, _unknown(keys, values)
    tokens: set[str] = set()
    for el in design.elements:
        if isinstance(el, TextEl):
            tokens |= set(TOKEN_RE.findall(el.content))
        elif isinstance(el, (BarcodeEl, QrEl)):
            tokens |= set(TOKEN_RE.findall(el.data))
    code = compile_parsed_design(design, dots=dots, language_key=template.language_key,
                                 subs=values)
    return code, _unknown(tokens, values)
