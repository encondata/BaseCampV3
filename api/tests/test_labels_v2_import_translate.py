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
    key, dpi, note = infer_size("^XA^PW812^LL406^XZ", SIZES)
    assert key == "4x2" and dpi == "203" and "812x406" in note
    key, dpi, _ = infer_size("^XA^PW406^LL203^XZ", SIZES)   # 2.0 x 1.0 exactly
    assert key == "2x1" and dpi == "203"
    key, dpi, _ = infer_size("^XA^PW410^LL200^XZ", SIZES)   # within 0.05in
    assert key == "2x1" and dpi == "203"


def test_infer_size_fallbacks():
    key, dpi, note = infer_size("^XA^PW999^LL999^XZ", SIZES)
    assert key == "4x2" and dpi == "203" and "no vocab match" in note
    key, dpi, note = infer_size("^XA^LL{{CALCULATED}}^PW609^XZ", SIZES)
    assert key == "4x2" and dpi == "203" and "no literal" in note


def test_infer_size_300dpi_fallback():
    key, dpi, note = infer_size("^XA^PW1200^LL600^XZ", SIZES)
    assert (key, dpi) == ("4x2", "300")
    assert "@300dpi" in note


def test_infer_size_prefers_203_when_both_match():
    # 406x203 dots: 2x1 @203 AND ~1.35x0.68 @300 (no match) -> stays 203
    key, dpi, _ = infer_size("^XA^PW406^LL203^XZ", SIZES)
    assert (key, dpi) == ("2x1", "203")


def test_map_label_type():
    assert map_label_type("asset_top") == ("top", None)
    assert map_label_type("asset_front") == ("front", None)
    assert map_label_type("manifest") == ("container", None)
    key, note = map_label_type("mystery")
    assert key == "top" and "mystery" in note
    key, note = map_label_type(None)
    assert key == "top" and note is not None
