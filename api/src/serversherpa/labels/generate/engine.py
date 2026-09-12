"""Render one label from a resolved template + placeholder values.

Both template kinds go through the SAME code path the Variables →
Labels editor uses for preview/compile (labels/compile.py's
`compile_design`, shared with `api/routes/labels.py`) — the worker never
has its own copy of the ZPL/ESC-P/P-touch dispatch.

Unknown tokens are scanned separately from compiling (V3 deliberately
reports them in the run's error_summary instead of silently blanking
them — see docs/superpowers/specs/2026-09-11-generate-labels-design.md
§Deliberate differences): a `code` kind scans the raw code string; a
`design` kind scans every text-bearing element (text content, barcode/QR
data) after parsing. The label itself is still produced either way —
unresolved tokens compile to "" via labels/tokens.py, same as always."""

from serversherpa.db.models import LabelTemplate
from serversherpa.labels.compile import compile_parsed_design
from serversherpa.labels.model import BarcodeEl, QrEl, TextEl, parse_design
from serversherpa.labels.tokens import TOKEN_RE, apply_placeholders


def _unknown(tokens: set[str], values: dict[str, str]) -> set[str]:
    return {t for t in tokens if t not in values}


def render_label(
    template: LabelTemplate, values: dict[str, str], *,
    size_meta: dict, dpi_meta: dict, language_key: str,
) -> tuple[str, set[str]]:
    if template.kind == "code":
        code_src = template.code or ""
        tokens = set(TOKEN_RE.findall(code_src))
        return apply_placeholders(code_src, values), _unknown(tokens, values)

    design_json = template.design or {}
    # parsed ONCE — the token scan below and the compile both work off
    # this same Design object, rather than parsing design_json twice
    design = parse_design({
        **design_json,
        "size": {"w": size_meta["width_in"], "h": size_meta["height_in"]},
    })
    tokens: set[str] = set()
    for el in design.elements:
        if isinstance(el, TextEl):
            tokens |= set(TOKEN_RE.findall(el.content))
        elif isinstance(el, (BarcodeEl, QrEl)):
            tokens |= set(TOKEN_RE.findall(el.data))
    code = compile_parsed_design(design, dots=dpi_meta["dots"], language_key=language_key,
                                 subs=values)
    return code, _unknown(tokens, values)
