"""PDF417 tracking-id barcode for the Move Scan History PDF footer. Port
of V2's `create_barcode_image()` (api/reports/_pdf_utils.py) — see
docs/superpowers/specs/2026-09-11-move-scan-history-design.md.
"""

import base64
from io import BytesIO

from pdf417gen import encode, render_image

_DEFAULT_COLUMNS = 6


def pdf417_png(text: str, *, columns: int = _DEFAULT_COLUMNS, scale: int = 3) -> bytes:
    """Render `text` as a PDF417 barcode, PNG-encoded.

    `pdf417gen.encode` raises `ValueError` ("Generated bar code has N
    rows. Minimum is 3 rows.") for short inputs at a high column count —
    a run id (uuid, 36 characters) encodes fine at the default 6
    columns, but a short string (a test fixture, or some future non-uuid
    tracking id) needs fewer columns to reach the 3-row minimum. Retry
    downward to 1 column before giving up.
    """
    last_error: ValueError | None = None
    codes = None
    for cols in range(max(columns, 1), 0, -1):
        try:
            codes = encode(text, columns=cols)
            break
        except ValueError as exc:
            last_error = exc
    if codes is None:
        raise last_error  # pragma: no cover — no column count worked

    image = render_image(codes, scale=scale, padding=2)
    buf = BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def pdf417_data_uri(text: str) -> str:
    png = pdf417_png(text)
    return f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}"
