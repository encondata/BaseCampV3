"""Transportation Standards sheet for the Site & Move Survey xlsx.

Port of V2's `_parse_standards_docx` / `_append_transportation_standards`
(api/reports/site_move_survey.py, read-only reference at
/Users/jrh1812/Developer/BaseCampV2-reference) — stdlib-only XML parsing
(no `python-docx` dependency) plus an openpyxl sheet writer. The docx
itself is a `report_asset` attachment on the report definition (Task 3's
`gather.py`); parsing it is pure and cheap enough to run per build, but
it is still cached per process (see `parse_standards_cached`) since the
same definition's docx is reused across every run until someone uploads
a new one.
"""

import io
import zipfile

try:
    import defusedxml.ElementTree as ET
except ImportError:                                     # pragma: no cover
    import xml.etree.ElementTree as ET

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
PR_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

# Parsed items, keyed by attachment id — the docx is immutable once
# uploaded (a re-upload gets a new attachment id via the attachments
# route), so a given id's parse never needs to be repeated within the
# same worker process. Ports V2's module-level `_transport_standards_cache`
# (which cached the single static company doc); here it's keyed because
# each report definition can carry its own standards docx.
_parsed_cache: dict[str, list[tuple[str, object]]] = {}


def parse_standards_docx(docx_bytes: bytes) -> list[tuple[str, object]]:
    """Extract `(kind, payload)` items from the standards docx in
    document order. `kind` is one of `'heading'`, `'text'`, `'bullet'`,
    or `'image'` (`payload` is the raw image bytes for `'image'`, the
    paragraph text otherwise).

    A `'heading'` is a paragraph whose style name starts with `Heading`
    or whose first run is bold. A `'bullet'` is a `ListParagraph`-styled
    paragraph; its list level (`w:numPr/w:ilvl`, default 0) is baked into
    the payload string as leading four-space indents plus a `"• "`
    marker, exactly as V2 rendered it — the level is not carried as
    separate data, so a template-derived docx round-trips through this
    parser and back into a sheet without re-deriving indentation rules.
    Anything else non-empty is `'text'`. Images are emitted at the point
    in the paragraph stream where their `a:blip` reference appears,
    resolved through the document's own relationship map.
    """
    zf = zipfile.ZipFile(io.BytesIO(docx_bytes))
    rels: dict[str, str] = {}
    rel_root = ET.fromstring(zf.read("word/_rels/document.xml.rels"))
    for rel in rel_root.iter(f"{PR_NS}Relationship"):
        rels[rel.get("Id")] = rel.get("Target")

    items: list[tuple[str, object]] = []
    body = ET.fromstring(zf.read("word/document.xml")).find(f"{W_NS}body")
    for p in body.iter(f"{W_NS}p"):
        style_el = p.find(f"{W_NS}pPr/{W_NS}pStyle")
        style = style_el.get(f"{W_NS}val") if style_el is not None else ""
        text = "".join(t.text or "" for t in p.iter(f"{W_NS}t")).strip()
        is_bold = p.find(f"{W_NS}r/{W_NS}rPr/{W_NS}b") is not None

        for blip in p.iter(f"{A_NS}blip"):
            target = rels.get(blip.get(f"{R_NS}embed"))
            if target:
                items.append(("image", zf.read("word/" + target.lstrip("/"))))

        if not text:
            continue
        if style == "ListParagraph":
            ilvl_el = p.find(f"{W_NS}pPr/{W_NS}numPr/{W_NS}ilvl")
            level = int(ilvl_el.get(f"{W_NS}val")) if ilvl_el is not None else 0
            items.append(("bullet", "    " * level + "• " + text))
        elif is_bold or style.startswith("Heading"):
            items.append(("heading", text))
        else:
            items.append(("text", text))
    return items


def parse_standards_cached(attachment_id, docx_bytes: bytes) -> list[tuple[str, object]]:
    """`parse_standards_docx`, memoized per process by `attachment_id`
    (stringified — accepts a `uuid.UUID` or `str`). `docx_bytes` is only
    read on a cache miss; `gather.py` always fetches the bytes (Task 3's
    `SurveyData.standards_docx_bytes` is needed for other reasons too),
    so this only saves the XML-parsing work, not the storage read.
    """
    key = str(attachment_id)
    if key not in _parsed_cache:
        _parsed_cache[key] = parse_standards_docx(docx_bytes)
    return _parsed_cache[key]


def append_standards_sheet(wb, items: list[tuple[str, object]]) -> None:
    """Append a "Transportation Standards" sheet rendering `items`
    (from `parse_standards_docx`) top to bottom: bold, larger text for
    headings; wrapped body text sized to its line count for bullets/
    text; thumbnailed images (max 520x520, converted to RGB PNG) anchored
    at column B. Mutates `wb` in place; callers decide whether to call
    this at all (skipped when the toggle is off, there's no docx, or the
    template already ships its own transport sheet — see `fill.py`'s
    sheet-title check)."""
    from openpyxl.drawing.image import Image as XLImage
    from openpyxl.styles import Alignment, Font
    from PIL import Image as PILImage

    ws = wb.create_sheet("Transportation Standards")
    ws.column_dimensions["B"].width = 100
    ws.column_dimensions["A"].width = 2
    wrap = Alignment(wrap_text=True, vertical="top")

    row = 2
    for kind, payload in items:
        if kind == "image":
            try:
                pil_img = PILImage.open(io.BytesIO(payload))
                pil_img.thumbnail((520, 520))
                buf = io.BytesIO()
                pil_img.convert("RGB").save(buf, format="PNG")
                buf.seek(0)
                xl_img = XLImage(buf)
                xl_img.anchor = f"B{row}"
                ws.add_image(xl_img)
                row += int(pil_img.height / 19) + 3
            except Exception:
                continue
            continue

        cell = ws.cell(row=row, column=2)
        cell.value = payload
        cell.alignment = wrap
        if kind == "heading":
            cell.font = Font(bold=True, size=13)
            ws.row_dimensions[row].height = 24
        else:
            # Wrapped text needs taller rows: ~90 chars per line at
            # column B's width of 100.
            lines = max(1, (len(payload) + 89) // 90)
            ws.row_dimensions[row].height = 15 * lines
        row += 1
