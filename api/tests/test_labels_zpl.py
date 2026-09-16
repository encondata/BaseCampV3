"""ZPL golden tests. Numbers assume round(v * dpi) with Python rounding."""

from serversherpa.labels.model import parse_design
from serversherpa.labels.zpl import compile_zpl

SIMPLE = {"size": {"w": 4, "h": 2}, "elements": [
    {"id": "t1", "type": "text", "x": 0.25, "y": 0.5, "w": 2, "h": 0.3,
     "rotation": 0, "content": "Hello", "fontSizePt": 12,
     "bold": False, "align": "left"}]}


def test_simple_text_203():
    out = compile_zpl(parse_design(SIMPLE), 203)
    assert out == (
        "^XA\n"
        "^PW812\n"
        "^LL406\n"
        "^CI28\n"
        "^FO51,102^A0N,34,34^FH_^FDHello^FS\n"
        "^XZ")


def test_dpi_scales_without_redesign():
    out = compile_zpl(parse_design(SIMPLE), 300)
    assert "^PW1200" in out and "^LL600" in out
    assert "^FO75,150^A0N,50,50" in out  # 0.25*300=75; 12pt*300/72=50


def test_tokens_kept_then_substituted():
    d = parse_design({"size": {"w": 4, "h": 2}, "elements": [
        {"id": "t1", "type": "text", "x": 0, "y": 0, "w": 2, "h": 0.3,
         "rotation": 0, "content": "SN: {serial_number}", "fontSizePt": 10,
         "bold": False, "align": "left"}]})
    kept = compile_zpl(d, 203)
    assert "^FDSN: {serial_number}^FS" in kept
    sub = compile_zpl(d, 203, {"serial_number": "C7X-0042"})
    assert "^FDSN: C7X-0042^FS" in sub


def test_literal_control_chars_are_hex_escaped():
    d = parse_design({"size": {"w": 2, "h": 1}, "elements": [
        {"id": "t1", "type": "text", "x": 0, "y": 0, "w": 2, "h": 0.3,
         "rotation": 0, "content": "a^b~c_d", "fontSizePt": 10,
         "bold": False, "align": "left"}]})
    out = compile_zpl(d, 203)
    assert "^FDa_5eb_7ec_5fd^FS" in out


def test_kitchen_sink_203():
    d = parse_design({"size": {"w": 4, "h": 2}, "elements": [
        {"id": "b1", "type": "barcode", "x": 0.1, "y": 0.6, "w": 3, "h": 0.8,
         "rotation": 0, "symbology": "code128", "data": "{asset_id}",
         "showText": True},
        {"id": "b2", "type": "barcode", "x": 0.1, "y": 1.5, "w": 3, "h": 0.3,
         "rotation": 0, "symbology": "code39", "data": "A1", "showText": False},
        {"id": "q1", "type": "qr", "x": 3.2, "y": 0.2, "w": 0.7, "h": 0.7,
         "rotation": 0, "data": "{asset_id}"},
        {"id": "l1", "type": "line", "x": 0, "y": 0.5, "w": 4, "h": 0,
         "rotation": 0, "strokeIn": 0.01},
        {"id": "x1", "type": "box", "x": 0.05, "y": 0.05, "w": 3.9, "h": 1.9,
         "rotation": 0, "strokeIn": 0.02},
        {"id": "t1", "type": "text", "x": 0.1, "y": 0.1, "w": 3.8, "h": 0.3,
         "rotation": 0, "content": "MID", "fontSizePt": 10, "bold": True,
         "align": "center"}]})
    out = compile_zpl(d, 203)
    assert "^FO20,122^BY2^BCN,162,Y,N,N^FH_^FD{asset_id}^FS" in out
    assert "^FO20,304^BY2^B3N,N,61,N,N^FH_^FDA1^FS" in out
    assert "^FO650,41^BQN,2,6^FH_^FDQA,{asset_id}^FS" in out
    assert "^FO0,102^GB812,2,2^FS" in out          # line: h clamped to stroke
    assert "^FO10,10^GB792,386,4^FS" in out
    assert "^FO20,20^FB771,1,0,C,0^A0N,28,34^FH_^FDMID^FS" in out


def test_rotation_letters():
    d = parse_design({"size": {"w": 2, "h": 2}, "elements": [
        {"id": "t1", "type": "text", "x": 0, "y": 0, "w": 1, "h": 0.3,
         "rotation": 90, "content": "R", "fontSizePt": 10,
         "bold": False, "align": "left"}]})
    assert "^A0R,28,28" in compile_zpl(d, 203)


def test_qr_rotation_passthrough():
    d = parse_design({"size": {"w": 2, "h": 2}, "elements": [
        {"id": "q1", "type": "qr", "x": 0, "y": 0, "w": 0.7, "h": 0.7,
         "rotation": 90, "data": "{asset_id}"}]})
    assert "^BQR,2," in compile_zpl(d, 203)


def test_reverse_text_emits_field_reverse():
    d = parse_design({"size": {"w": 4, "h": 6}, "elements": [
        {"id": "t1", "type": "text", "x": 0.2, "y": 0.5, "w": 3.6, "h": 0.36,
         "rotation": 0, "content": "PRIORITY", "fontSizePt": 26,
         "bold": True, "align": "center", "reverse": True}]})
    out = compile_zpl(d, 203)
    assert "^FR^FH_^FDPRIORITY^FS" in out


def test_lines_wraps_and_forces_a_field_block_even_when_left_aligned():
    d = parse_design({"size": {"w": 4, "h": 6}, "elements": [
        {"id": "t1", "type": "text", "x": 0.2, "y": 0.5, "w": 3.6, "h": 1.0,
         "rotation": 0, "content": "{container_name}", "fontSizePt": 28,
         "bold": True, "align": "left", "lines": 2}]})
    assert "^FB731,2,0,L,0" in compile_zpl(d, 203)


def test_module_in_sets_narrow_bar_width_per_dpi():
    design = {"size": {"w": 4, "h": 6}, "elements": [
        {"id": "b1", "type": "barcode", "x": 0.8, "y": 1.6, "w": 2.4, "h": 1.2,
         "rotation": 0, "symbology": "code128", "data": "crate-17",
         "showText": False, "moduleIn": 0.01}]}
    assert "^BY2^BCN,244,N,N,N" in compile_zpl(parse_design(design), 203)
    assert "^BY3^BCN,360,N,N,N" in compile_zpl(parse_design(design), 300)


def test_absent_properties_compile_byte_identically():
    """Absent-means-unchanged: the three new properties must not perturb any
    design that does not use them."""
    out = compile_zpl(parse_design(SIMPLE), 203)
    assert out == (
        "^XA\n"
        "^PW812\n"
        "^LL406\n"
        "^CI28\n"
        "^FO51,102^A0N,34,34^FH_^FDHello^FS\n"
        "^XZ")
    bare = {"size": {"w": 4, "h": 2}, "elements": [
        {"id": "b1", "type": "barcode", "x": 0.1, "y": 0.6, "w": 3, "h": 0.8,
         "rotation": 0, "symbology": "code128", "data": "A1", "showText": True}]}
    assert "^BY2^BCN,162,Y,N,N" in compile_zpl(parse_design(bare), 203)
