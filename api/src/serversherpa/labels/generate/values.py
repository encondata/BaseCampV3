"""Per-asset placeholder catalog — the V3 port of V2's `field_values`
dict (portal_routes.py `process_label_generation_job`), plus the
`generation_rules` position-split/length-limit port of V2's
`label_generation_code`.

The catalog itself lives in labels/label_values.py (pure, shared with the
laptop edge); this module adapts the portal's DB rows to it and resolves
the move's day with `stored_day`. Output is unchanged."""

from dataclasses import dataclass
from decimal import Decimal
from typing import NamedTuple

from serversherpa.db.models import Initiative, Site
# Re-exported: api/routes/kiosk.py imports these helpers from here.
from serversherpa.labels.label_values import (  # noqa: F401
    UNTAGGED_LABEL, LabelAsset, LabelMove, _apply_length_limits,
    _apply_position_rules, _format_ru, asset_label_values, container_label_values,
    make_model_text,
)
# report_timezone is no longer read by this module's own logic (move_date/
# move_date_long now read the UTC date parts directly — see stored_day) but
# kept importable so test_label_generate_values.py can monkeypatch it to
# prove that: the test patches this name to a non-UTC zone and asserts the
# result is unaffected.
from serversherpa.services.timezone import report_timezone, stored_day  # noqa: F401

CONTAINER_KEYS = ("container_name", "container_id")


class AssetRow(NamedTuple):
    """One roster row's worth of fields `placeholder_values` needs —
    built by the runner from the Asset/InitiativeAsset/AssetModel join."""

    asset_id: object                    # uuid.UUID — GeneratedLabel.entity_id
    legacy_id: int | None
    name: str | None
    serial_number: str | None
    make: str | None
    model: str | None
    source_rack: str | None
    source_ru: Decimal | None
    source_position: str | None
    destination_rack: str | None
    destination_ru: Decimal | None
    destination_position: str | None
    # the row as /kiosk/sync/assets sends it (payloads.asset_payload): what a
    # label builder template's field values come from
    payload: dict | None = None

    @property
    def entity_id(self) -> object:
        """The `generated_labels.entity_id` for this row. Named the same on
        ContainerRow so the runner never branches on row type."""
        return self.asset_id


class ContainerRow(NamedTuple):
    """One container's worth of fields `container_placeholder_values` needs —
    built by the runner from the Container table."""

    container_uuid: object              # uuid.UUID — GeneratedLabel.entity_id
    legacy_id: int | None
    name: str | None
    label_tag: str | None
    # payloads.container_payload's dict, as for AssetRow.payload
    payload: dict | None = None

    @property
    def entity_id(self) -> object:
        return self.container_uuid


@dataclass(frozen=True)
class Sites:
    """The initiative's origin/destination Site rows (either may be
    None — an initiative need not have both, or either, set)."""

    origin: Site | None
    destination: Site | None


def _move(initiative: Initiative, sites: Sites) -> LabelMove:
    """The LabelMove for an initiative: its day read with `stored_day`."""
    day = (stored_day(initiative.scheduled_start)
           if initiative.scheduled_start is not None else None)
    return LabelMove(
        name=initiative.name, day=day,
        source_site=sites.origin.name if sites.origin else None,
        destination_site=sites.destination.name if sites.destination else None)


def placeholder_values(
    asset_row: AssetRow, initiative: Initiative, sites: Sites,
    catalog_keys: list[str], *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """Every requested catalog key, computed from the roster row +
    initiative + sites; unrecognized keys and missing data both resolve
    to `""` (V2 parity). `generation_rules` (a template's position-split
    + length-limit rules) is applied AFTER the catalog is built, adding
    its own named tokens on top — those are not filtered by
    `catalog_keys` since they are template-specific, not part of the
    fixed placeholder catalog."""
    asset = LabelAsset(
        legacy_id=asset_row.legacy_id, name=asset_row.name,
        serial_number=asset_row.serial_number, make=asset_row.make,
        model=asset_row.model, source_rack=asset_row.source_rack,
        source_ru=asset_row.source_ru, source_position=asset_row.source_position,
        destination_rack=asset_row.destination_rack,
        destination_ru=asset_row.destination_ru,
        destination_position=asset_row.destination_position)
    return asset_label_values(asset, _move(initiative, sites), catalog_keys,
                              generation_rules=generation_rules)


def container_placeholder_values(
    row: ContainerRow, initiative: Initiative, sites: Sites,
    catalog_keys: list[str], *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """The container counterpart of `placeholder_values`. Same contract:
    every requested catalog key is present, and anything this row kind has
    no value for resolves to "" rather than raising — so an asset-only key
    on a container template is blank, not an error."""
    return container_label_values(
        legacy_id=row.legacy_id, name=row.name, label_tag=row.label_tag,
        move=_move(initiative, sites), catalog_keys=catalog_keys,
        generation_rules=generation_rules)


def values_for_row(
    row, initiative: Initiative, sites: Sites, catalog_keys: list[str],
    *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """Dispatch a roster row to its own value builder, so the runner stays
    free of row-kind branching."""
    if isinstance(row, ContainerRow):
        return container_placeholder_values(
            row, initiative, sites, catalog_keys, generation_rules=generation_rules)
    return placeholder_values(
        row, initiative, sites, catalog_keys, generation_rules=generation_rules)
