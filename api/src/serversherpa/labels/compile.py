"""Vocab-free design-template compile core, shared by the compile/
convert-to-code routes (api/routes/labels.py, which resolves size/dpi/
language vocab rows and passes their meta in) and the label-generation
runner (labels/generate/engine.py, which resolves the same meta from
the template's own size_key/dpi_key/language_key). Pure — no DB, no IO.

`compile_parsed_design` is split out from `compile_design` so a caller
that already has a parsed `Design` (engine.py scans one for unknown
tokens before compiling it) can dispatch straight to the language
compiler without parsing the same JSON twice."""

from serversherpa.labels.brother_escp import compile_escp
from serversherpa.labels.brother_ptouch import compile_ptouch
from serversherpa.labels.model import Design, parse_design
from serversherpa.labels.zpl import compile_zpl


class UnsupportedLanguage(ValueError):
    """A language_key with no dispatch here — caller maps to its own
    error shape (the route: 422 unsupported_language)."""

    def __init__(self, key: str):
        super().__init__(f"unsupported language: {key}")
        self.key = key


def compile_parsed_design(design: Design, *, dots: int, language_key: str,
                          subs: dict[str, str] | None) -> str:
    """Dispatch an already-parsed Design to its language compiler."""
    if language_key == "zpl":
        return compile_zpl(design, dots, subs)
    if language_key == "escp":
        return compile_escp(design, subs)
    if language_key == "ptouch":
        return compile_ptouch(design, subs)
    raise UnsupportedLanguage(language_key)


def compile_design(design_json: dict, *, width_in: float, height_in: float,
                    dots: int, language_key: str,
                    subs: dict[str, str] | None) -> str:
    """Parse design_json (with the resolved size overridden in) and
    dispatch to the language's compiler. Raises DesignError (bad design
    JSON) or UnsupportedLanguage — both left for the caller to map."""
    design = parse_design({**design_json, "size": {"w": width_in, "h": height_in}})
    return compile_parsed_design(design, dots=dots, language_key=language_key, subs=subs)
