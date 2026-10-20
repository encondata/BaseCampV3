"""Render one label from a resolved template + placeholder values.

The rendering itself lives in labels/render.py (pure, shared with the
laptop edge); this adapter keeps the portal's signature, taking the
size/DPI vocabulary rows and an explicit language key."""

from types import SimpleNamespace

from serversherpa.db.models import LabelTemplate
from serversherpa.labels.render import render_template


def render_label(
    template: LabelTemplate, values: dict[str, str], *,
    size_meta: dict, dpi_meta: dict, language_key: str,
) -> tuple[str, set[str]]:
    source = SimpleNamespace(kind=template.kind, code=template.code,
                             design=template.design, language_key=language_key)
    return render_template(source, values, width_in=size_meta["width_in"],
                           height_in=size_meta["height_in"], dots=dpi_meta["dots"])
