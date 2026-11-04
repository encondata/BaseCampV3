"""One mock-data test label for a template, shared by the Label Station's
(POST /kiosk/labels/test-render) and the portal's printer tools
(POST /labels/test-render), so both print the same label for the same
template (spec docs/superpowers/specs/2026-11-03-portal-printer-tools-design.md §3).

The template is filled with fixed sample values, never a real asset's:
- a schema 2 design (a label builder child) gets the builder's own mock
  values (labels.fields.mock_field_values), never its samples;
- anything else (a code template, a v1 design) gets PLACEHOLDER_MOCK_VALUES
  plus "" for every other active placeholder, then its generation_rules
  through the label generator's own helpers.

Lives here, not in a route module: api/routes/kiosk.py imports from
api/routes/labels.py, so the two routes can't share a helper that sits in
either of them."""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelPlaceholder, LabelTemplate, LabelVocab
from serversherpa.db.ordering import natural
from serversherpa.labels.fields import (
    PLACEHOLDER_MOCK_VALUES,
    design_field_keys,
    mock_field_values,
)
from serversherpa.labels.generate.engine import render_label
from serversherpa.labels.generate.values import (
    CONTAINER_KEYS,
    _apply_length_limits,
    _apply_position_rules,
)
from serversherpa.labels.kiosk_templates import design_schema

logger = logging.getLogger(__name__)

# Fixed sample values for the mock-data test label of a code template (or
# a v1 design), one per placeholder catalog key: they live in labels/fields.py
# beside the builder's own mocks.
MOCK_VALUES = PLACEHOLDER_MOCK_VALUES


class MockRenderError(Exception):
    """The template could not be filled and rendered (a design that can't
    convert, an unknown size or DPI). Routes answer 422 `template_unconvertible`."""


async def label_catalog_keys(db: AsyncSession) -> list[str]:
    """The active label placeholder catalog, minus the container-only
    keys (labels/generate/values.py resolves those to "" for an asset
    row anyway — the runner is asset-only). Same source of truth the
    label generator reads, so the kiosk caches exactly the values a
    generated label would carry."""
    keys = list((await db.scalars(
        select(LabelPlaceholder.key)
        .where(LabelPlaceholder.is_active.is_(True))
        .order_by(LabelPlaceholder.sort_order, natural(LabelPlaceholder.key)))).all())
    return [k for k in keys if k not in CONTAINER_KEYS]


def mock_label_values(catalog_keys: list[str], generation_rules: dict | None) -> dict[str, str]:
    """MOCK_VALUES plus "" for any other active catalog key, then the
    template's generation_rules through the label generator's own helpers
    (position split, then length limits) — the same order
    `placeholder_values` applies them."""
    out = {key: "" for key in catalog_keys}
    out.update(MOCK_VALUES)
    if generation_rules:
        _apply_position_rules(out, generation_rules,
                              source_raw=MOCK_VALUES["source_raw"],
                              destination_raw=MOCK_VALUES["destination_raw"])
        _apply_length_limits(out, generation_rules)
    return out


async def render_mock_label(db: AsyncSession, template: LabelTemplate) -> str:
    """The template's ZPL (or its own language's code) filled with mock
    values and rendered by the label generator's own `render_label`, so no
    client fills placeholders itself. Raises MockRenderError when it can't
    render; the caller has already checked the template may be printed."""
    size_row = await db.get(LabelVocab, ("size", template.size_key))
    dpi_row = await db.get(LabelVocab, ("dpi", template.dpi_key))
    size_meta = (size_row.meta if size_row else None) or {}
    dpi_meta = (dpi_row.meta if dpi_row else None) or {}
    if design_schema(template) >= 2:
        # the builder's mock values, shaped like labels.fields.field_values
        values = mock_field_values(template.label_type, design_field_keys(template.design))
    else:
        values = mock_label_values(await label_catalog_keys(db), template.generation_rules)
    try:
        if template.kind != "code" and (
                size_meta.get("width_in") is None or size_meta.get("height_in") is None
                or dpi_meta.get("dots") is None):
            raise ValueError("unknown label size or DPI")
        zpl, _unknown = render_label(template, values, size_meta=size_meta,
                                     dpi_meta=dpi_meta, language_key=template.language_key)
    except Exception as exc:
        logger.warning("test label %s could not render: %s",
                       template.id, type(exc).__name__, exc_info=True)
        raise MockRenderError(type(exc).__name__) from None
    return zpl
