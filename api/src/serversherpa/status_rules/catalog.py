"""The single source of truth for rule semantics: operators, the
condition-field registry, and the typed action catalog. The API's
/status-rules/schema serializes THIS module; the portal renders that
payload — nothing else may define operators, fields, or actions.

Actions are real Python with validated params — never dynamic
table/field identifiers (V2's injection surface). apply() mutates ORM
objects already in the caller's session and never commits; an action
whose required context is missing returns applied=False with a reason
instead of failing the scan."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.status_rules.context import Context

# ── operators ────────────────────────────────────────────────────────


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _cmp(op: Callable[[float, float], bool]):
    def check(f: Any, v: str | None) -> bool:
        fn, vn = _num(f), _num(v)
        return fn is not None and vn is not None and op(fn, vn)
    return check


OPERATORS: dict[str, Callable[[Any, str | None], bool]] = {
    "equals": lambda f, v: (f is not None and v is not None
                            and str(f).lower() == str(v).lower()),
    "not_equals": lambda f, v: (f is not None and v is not None
                                and str(f).lower() != str(v).lower()),
    "contains": lambda f, v: (f is not None and v is not None
                              and str(v).lower() in str(f).lower()),
    "is_null": lambda f, v: f is None or f == "",
    "is_not_null": lambda f, v: f is not None and f != "",
    "greater_than": _cmp(lambda a, b: a > b),
    "greater_or_equal": _cmp(lambda a, b: a >= b),
    "less_than": _cmp(lambda a, b: a < b),
    "less_or_equal": _cmp(lambda a, b: a <= b),
}

_NO_VALUE_OPERATORS = {"is_null", "is_not_null"}


def evaluate_condition(field_value: Any, operator: str,
                       value: str | None) -> bool:
    check = OPERATORS.get(operator)
    return bool(check and check(field_value, value))


# ── condition fields ─────────────────────────────────────────────────


@dataclass(frozen=True)
class ConditionField:
    key: str
    label: str
    type: str                       # text | status | site | bool | number | uuid
    options_source: str | None = None   # 'status:<record_type>' | 'sites'


_FIELDS = [
    ConditionField("scan.scan_type", "Scan type", "status",
                   "status:scan"),
    ConditionField("scan.device_id", "Scan device", "text"),
    ConditionField("scan.site_id", "Scan site", "site", "sites"),
    ConditionField("scan.source", "Scan source", "text"),
    ConditionField("scan.operator_id", "Scan operator", "uuid"),
    ConditionField("asset.status", "Asset status", "status", "status:asset"),
    ConditionField("asset.site_id", "Asset site", "site", "sites"),
    ConditionField("asset.client_id", "Asset client", "uuid"),
    ConditionField("asset.has_rails", "Asset has rails", "bool"),
    ConditionField("container.status", "Container status", "status",
                   "status:container"),
    ConditionField("container.site_id", "Container site", "site", "sites"),
    ConditionField("person.id", "Matched person", "uuid"),
    ConditionField("initiative.initiative_type", "Initiative type", "status",
                   "status:initiative_type"),
    ConditionField("initiative.sub_type", "Initiative sub-type", "status",
                   "status:initiative_sub_type"),
    ConditionField("initiative.status", "Initiative status", "status",
                   "status:initiative"),
    ConditionField("initiative_asset.status", "Move asset status", "status",
                   "status:asset"),
    ConditionField("initiative_asset.disposition", "Move asset disposition",
                   "text"),
    ConditionField("initiative_asset.priority_wave", "Priority wave", "text"),
]
CONDITION_FIELDS: dict[str, ConditionField] = {f.key: f for f in _FIELDS}


def validate_condition(field_key: str, operator: str,
                       value: str | None) -> str | None:
    if field_key not in CONDITION_FIELDS:
        return "unknown_field"
    if operator not in OPERATORS:
        return "unknown_operator"
    if operator not in _NO_VALUE_OPERATORS and (value is None or value == ""):
        return "missing_value"
    return None


# ── typed actions ────────────────────────────────────────────────────


@dataclass(frozen=True)
class ActionOutcome:
    applied: bool
    reason: str | None = None


@dataclass(frozen=True)
class ParamField:
    name: str
    type: str                        # status | choice | bool
    options: tuple[str, ...] = ()    # for choice
    options_source: str | None = None  # for status params: 'status:<type>'


ApplyFn = Callable[[AsyncSession, Context, dict], Awaitable[ActionOutcome]]


@dataclass(frozen=True)
class ActionDef:
    key: str
    label: str
    params: tuple[ParamField, ...]
    apply: ApplyFn


_SKIP = ActionOutcome(applied=False)


def _touch(entity) -> None:
    entity.updated_at = datetime.now(UTC)


def _ru_str(ru: Decimal | None) -> str | None:
    if ru is None:
        return None
    text = format(ru.normalize(), "f")
    return f"RU{text.removesuffix('.0')}" if text.endswith(".0") else f"RU{text}"


async def _set_asset_status(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    ctx.asset.status = params["status"]
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_initiative_asset_status(db, ctx, params) -> ActionOutcome:
    if ctx.initiative_asset is None:
        return ActionOutcome(False, "no_active_initiative")
    ctx.initiative_asset.status = params["status"]
    _touch(ctx.initiative_asset)
    return ActionOutcome(True)


async def _set_container_status(db, ctx, params) -> ActionOutcome:
    if ctx.container is None:
        return ActionOutcome(False, "no_container")
    ctx.container.status = params["status"]
    _touch(ctx.container)
    return ActionOutcome(True)


async def _set_asset_location_from_scan(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    # Older rows may predate the fields param — absent means both.
    fields = params.get("fields", "both")
    if fields in ("site", "both"):
        ctx.asset.site_id = ctx.scan.site_id
    if fields in ("location", "both"):
        ctx.asset.location_detail = ctx.scan.location_detail
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_asset_location_from_initiative(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    if ctx.initiative_asset is None or ctx.initiative is None:
        return ActionOutcome(False, "no_active_initiative")
    side = params["side"]
    rack = getattr(ctx.initiative_asset, f"{side}_rack")
    ru = _ru_str(getattr(ctx.initiative_asset, f"{side}_ru"))
    parts = [p for p in (rack, ru) if p]
    if not parts:
        return ActionOutcome(False, "no_location_on_move_asset")
    ctx.asset.location_detail = " ".join(parts)
    site_attr = ("origin_site_id" if side == "source"
                 else "destination_site_id")
    site = getattr(ctx.initiative, site_attr)
    if site is not None:
        ctx.asset.site_id = site
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_initiative_asset_verified(db, ctx, params) -> ActionOutcome:
    if ctx.initiative_asset is None:
        return ActionOutcome(False, "no_active_initiative")
    setattr(ctx.initiative_asset, f"{params['side']}_verified",
            bool(params["value"]))
    _touch(ctx.initiative_asset)
    return ActionOutcome(True)


async def _touch_container_audit(db, ctx, params) -> ActionOutcome:
    if ctx.container is None:
        return ActionOutcome(False, "no_container")
    ctx.container.last_audit_at = ctx.scan.scanned_at
    ctx.container.audit_by = ctx.scan.operator_id
    _touch(ctx.container)
    return ActionOutcome(True)


async def _clear_asset_location(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    ctx.asset.location_detail = ""
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _clear_asset_site(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    ctx.asset.site_id = None
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_asset_location_from_container(db, ctx, params) -> ActionOutcome:
    """ctx.container is the asset's CONTAINING container for asset
    matches (resolved by the engine); required here."""
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    if ctx.container is None:
        return ActionOutcome(False, "not_in_container")
    ctx.asset.location_detail = ctx.container.name
    _touch(ctx.asset)
    return ActionOutcome(True)


_SIDE = ParamField("side", "choice", options=("source", "destination"))
_ACTION_LIST = [
    ActionDef("set_asset_status", "Set asset status",
              (ParamField("status", "status", options_source="status:asset"),),
              _set_asset_status),
    ActionDef("set_initiative_asset_status", "Set move asset status",
              (ParamField("status", "status", options_source="status:asset"),),
              _set_initiative_asset_status),
    ActionDef("set_container_status", "Set container status",
              (ParamField("status", "status",
                          options_source="status:container"),),
              _set_container_status),
    ActionDef("set_asset_location_from_scan",
              "Set asset location from the scan",
              (ParamField("fields", "choice", options=("site", "location", "both")),),
              _set_asset_location_from_scan),
    ActionDef("set_asset_location_from_initiative",
              "Set asset location from move asset rack/RU", (_SIDE,),
              _set_asset_location_from_initiative),
    ActionDef("set_initiative_asset_verified", "Mark move asset side verified",
              (_SIDE, ParamField("value", "bool")),
              _set_initiative_asset_verified),
    ActionDef("touch_container_audit", "Record container audit touch", (),
              _touch_container_audit),
    ActionDef("clear_asset_location", "Clear asset location", (),
              _clear_asset_location),
    ActionDef("clear_asset_site", "Clear asset site", (),
              _clear_asset_site),
    ActionDef("set_asset_location_from_container",
              "Set asset location from its container", (),
              _set_asset_location_from_container),
]
ACTIONS: dict[str, ActionDef] = {a.key: a for a in _ACTION_LIST}


def validate_action(action_type: str, params: dict) -> str | None:
    action = ACTIONS.get(action_type)
    if action is None:
        return "unknown_action"
    for p in action.params:
        if p.name not in params:
            return "missing_param"
        if p.type == "choice" and params[p.name] not in p.options:
            return "bad_param"
        if p.type == "bool" and not isinstance(params[p.name], bool):
            return "bad_param"
        if p.type == "status" and not isinstance(params[p.name], str):
            return "bad_param"
    extra = set(params) - {p.name for p in action.params}
    return "bad_param" if extra else None
