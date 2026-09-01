"""Brother first-pass compilers — regression pins (approximate until
verified on hardware)."""

from serversherpa.labels.brother_escp import compile_escp
from serversherpa.labels.brother_ptouch import compile_ptouch
from serversherpa.labels.model import parse_design

DESIGN = parse_design({"size": {"w": 2.4, "h": 1}, "elements": [
    {"id": "t2", "type": "text", "x": 0.1, "y": 0.5, "w": 2, "h": 0.25,
     "rotation": 0, "content": "SN {serial_number}", "fontSizePt": 10,
     "bold": False, "align": "left"},
    {"id": "t1", "type": "text", "x": 0.1, "y": 0.1, "w": 2, "h": 0.3,
     "rotation": 0, "content": "ACME", "fontSizePt": 14, "bold": True,
     "align": "left"},
    {"id": "b1", "type": "barcode", "x": 0.1, "y": 0.7, "w": 2, "h": 0.25,
     "rotation": 0, "symbology": "code128", "data": "{asset_id}",
     "showText": False},
    {"id": "x1", "type": "box", "x": 0, "y": 0, "w": 2.4, "h": 1,
     "rotation": 0, "strokeIn": 0.02},  # ignored by both compilers
]})

ESC = "\x1b"


def test_escp_orders_by_y_and_substitutes():
    out = compile_escp(DESIGN, {"serial_number": "C7X", "asset_id": "10482"})
    assert out.startswith(f"{ESC}@{ESC}ia\x00")
    # y-order: ACME (0.1) before SN (0.5) before barcode (0.7)
    assert out.index("ACME") < out.index("SN C7X")
    assert out.index("SN C7X") < out.index("10482")
    assert f"{ESC}E" in out and f"{ESC}F" in out  # bold on/off around ACME
    assert "\x02" not in out.split("10482")[0].rsplit(ESC, 1)[-1]


def test_escp_keeps_tokens_without_subs():
    out = compile_escp(DESIGN)
    assert "SN {serial_number}" in out
    assert "{asset_id}" in out


def test_ptouch_stream_shape():
    out = compile_ptouch(DESIGN, {"serial_number": "C7X", "asset_id": "10482"})
    assert out.startswith("^II^TS001")
    assert "^ONobj1\x00" in out and "^ONobj3\x00" in out
    assert out.endswith("^FF")
    assert "SN C7X" in out and "10482" in out


def test_ptouch_object_order_is_canvas_y_order():
    out = compile_ptouch(DESIGN)
    assert out.index("ACME") < out.index("SN {serial_number}")
