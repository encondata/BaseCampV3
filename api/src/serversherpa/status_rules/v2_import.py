# api/src/serversherpa/status_rules/v2_import.py
"""Import V2 process-engine rules from a legacy BaseCamp V2 pg_dump as
V3 status rules. One-shot seeding helper behind
`serversherpa import-v2-status-rules` — like people/v2_import.py, and
reusing the sites importer's INSERT-statement row streaming.

Only rules with trigger_table='moves_assets_list' are importable — the
others reference trucks, which V3 does not have. Upsert is by rule
name: first inserts land DISABLED for review in /admin/status-rules;
re-runs update fields and replace children but preserve the rule's
current enabled flag. Data wins over prose: action values import as
stored even where a V2 description says otherwise."""

from typing import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.db.models import StatusRule, StatusRuleAction, StatusValue
from serversherpa.sites.v2_import import insert_rows

RULE_COLS = ("id", "name", "description", "trigger_table",
             "trigger_status_id", "priority", "enabled", "created_at",
             "updated_at", "created_by")
COND_COLS = ("id", "rule_id", "condition_table", "field_name", "operator",
             "value", "logic", "value_min", "value_max")
ACTION_COLS = ("id", "rule_id", "action_order", "action_type",
               "target_table", "target_field", "value_source", "value",
               "expression_type", "expression_inputs")

# V2 status_options.status_name -> V3 asset-vocab key. Lookup is by the
# dump's unique id first, so duplicate names on non-asset ids can't
# collide. Verified against live status_values at import time.
V2_NAME_TO_V3_KEY = {
    "Loaded In System": "loaded_in_system",
    "Pre-Stage": "pre_stage",
    "Racked": "racked",
    "RFID 1 - Cage Exit": "rfid_1_cage_exit",
    "Labeled": "labeled",
    "RFID 2 - Loading Dock": "rfid_2_loading_dock",
    "Pack / Logistics": "pack_logistics",
    "In Container": "in_container",
    "On Truck": "on_truck",
    "Received": "received",
    "Un-Pack": "un_pack",
    "RFID 3 - Staging": "rfid_3_staging",
    "Staged": "staged",
    "RFID 4 - Into Cage": "rfid_4_into_cage",
    "Re-Racked": "re_racked",
    "Cabling": "cabling",
    "QA": "qa",
    "Complete": "complete",
    "In Transit": "in_transit",
    "e-waste": "e_waste",
    "Historical": "historical",
    "Pending Client Handover": "pending_client_handover",
}


def _rows(dump_path: str, table: str, cols: tuple) -> Iterator[dict]:
    for values in insert_rows(dump_path, table):
        if len(values) == len(cols):
            yield dict(zip(cols, values))


def _status_key(v2_id, id_to_name: dict) -> str | None:
    name = id_to_name.get(int(v2_id)) if v2_id is not None else None
    return V2_NAME_TO_V3_KEY.get(name) if name else None


def translate_action(row: dict, id_to_name: dict):
    """(v3 {action_type, params}, None) on success, (None, reason) on drop."""
    atype = row["action_type"]
    table, field = row["target_table"], row["target_field"]
    value = row["value"]
    where = f"{atype} {table}.{field}"

    if atype == "set_status" and table == "moves_assets_list" \
            and field == "asset_status":
        key = _status_key(value, id_to_name)
        if key is None:
            return None, f"{where}: unknown status id {value}"
        return {"action_type": "set_initiative_asset_status",
                "params": {"status": key}}, None
    if atype == "set_status" and table == "assets" and field == "status":
        key = _status_key(value, id_to_name)
        if key is None:
            return None, f"{where}: unknown status id {value}"
        return {"action_type": "set_asset_status",
                "params": {"status": key}}, None
    if atype == "set_field" and table == "moves_assets_list" \
            and field in ("source_verified", "destination_verified") \
            and str(value).lower() == "true":
        return {"action_type": "set_initiative_asset_verified",
                "params": {"side": field.removesuffix("_verified"),
                           "value": True}}, None
    if atype == "copy_field" and table == "assets" and field == "site" \
            and value == "trigger.scan_site":
        return {"action_type": "set_asset_location_from_scan",
                "params": {"fields": "site"}}, None
    if atype == "copy_field" and table == "assets" and field == "location" \
            and value == "trigger.scan_location":
        return {"action_type": "set_asset_location_from_scan",
                "params": {"fields": "location"}}, None
    inputs = str(row.get("expression_inputs") or "")
    if table == "assets" and field == "location" and (
            (atype == "expression"
             and row.get("expression_type") == "concat_if_exists")
            or (atype == "set_field" and row.get("value_source") == "template")):
        if "destination_" in inputs:
            return {"action_type": "set_asset_location_from_initiative",
                    "params": {"side": "destination"}}, None
        if "source_" in inputs:
            return {"action_type": "set_asset_location_from_initiative",
                    "params": {"side": "source"}}, None
        return None, f"{where}: expression references neither side"
    if atype == "clear_field" and table == "assets" and field == "location":
        return {"action_type": "clear_asset_location", "params": {}}, None
    if atype == "clear_field" and table == "assets" and field == "site":
        return {"action_type": "clear_asset_site", "params": {}}, None
    if atype == "set_field" and table == "assets" and field == "location" \
            and row.get("value_source") == "field_reference" \
            and value == "container.container_name":
        return {"action_type": "set_asset_location_from_container",
                "params": {}}, None
    return None, f"{where}: no V3 equivalent"


async def import_rules(db: AsyncSession, dump_path: str) -> dict:
    id_to_name = {int(r["id"]): r["status_name"]
                  for r in _rows(dump_path, "status_options",
                                 ("id", "status_name", "association_type",
                                  "sort_order", "process_order", "color",
                                  "metadata", "created_at", "updated_at",
                                  "list_in_dropdown", "process_type",
                                  "description"))}
    vocab = set((await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "asset"))).all())

    conditions: dict[int, list[dict]] = {}
    for c in _rows(dump_path, "process_engine_conditions", COND_COLS):
        conditions.setdefault(int(c["rule_id"]), []).append(c)
    actions: dict[int, list[dict]] = {}
    for a in _rows(dump_path, "process_engine_actions", ACTION_COLS):
        actions.setdefault(int(a["rule_id"]), []).append(a)

    stats = {"imported": 0, "updated": 0, "partial": [], "skipped": []}
    touched: list[StatusRule] = []
    rules = sorted(_rows(dump_path, "process_engine_rules", RULE_COLS),
                   key=lambda r: (int(r["priority"]), int(r["id"])))
    for rule in rules:
        name = rule["name"]
        if rule["trigger_table"] != "moves_assets_list":
            stats["skipped"].append(
                (name, f"trigger table '{rule['trigger_table']}' has no "
                       "V3 equivalent (no trucks)"))
            continue
        trigger_key = _status_key(rule["trigger_status_id"], id_to_name)
        if trigger_key is None or trigger_key not in vocab:
            stats["skipped"].append(
                (name, f"trigger status id {rule['trigger_status_id']} "
                       "not in the V3 asset vocabulary"))
            continue
        # scan_match_category conditions are absorbed by V3's trigger
        # match type; any other condition means the rule would over-fire
        # without its gate — skip it.
        blocked = [c for c in conditions.get(int(rule["id"]), [])
                   if not (c["condition_table"] == "scans_processed"
                           and c["field_name"] == "scan_match_category")]
        if blocked:
            stats["skipped"].append(
                (name, f"unmapped condition on "
                       f"{blocked[0]['condition_table']}."
                       f"{blocked[0]['field_name']}"))
            continue

        translated, dropped = [], []
        for a in sorted(actions.get(int(rule["id"]), []),
                        key=lambda a: int(a["action_order"])):
            payload, reason = translate_action(a, id_to_name)
            if payload is None:
                dropped.append(reason)
            else:
                translated.append(payload)
        if not translated:
            stats["skipped"].append((name, "no translatable actions"))
            continue
        for reason in dropped:
            stats["partial"].append((name, reason, "action dropped"))

        children = [StatusRuleAction(position=i, **{
            "action_type": p["action_type"], "params": p["params"]})
            for i, p in enumerate(translated, 1)]
        existing = await db.scalar(
            select(StatusRule)
            .options(selectinload(StatusRule.conditions),
                     selectinload(StatusRule.actions))
            .where(StatusRule.name == name))
        if existing is None:
            new_rule = StatusRule(
                name=name, description=rule["description"] or "",
                trigger_status=trigger_key, trigger_match_type="asset",
                priority=int(rule["priority"]), enabled=False,
                conditions=[], actions=children)
            db.add(new_rule)
            touched.append(new_rule)
            stats["imported"] += 1
        else:
            existing.description = rule["description"] or ""
            existing.trigger_status = trigger_key
            existing.trigger_match_type = "asset"
            existing.priority = int(rule["priority"])
            existing.conditions[:] = []
            existing.actions[:] = children          # enabled untouched
            touched.append(existing)
            stats["updated"] += 1
    await db.flush()
    # Session identity map is weak — once this function returns, nothing
    # else references the ORM objects it just touched, so they'd be
    # garbage-collected and a later `select(StatusRule)` in the caller
    # would build fresh, non-eager-loaded instances (lazy `.actions`
    # access on those raises outside a greenlet context). Keeping them
    # referenced from the returned dict keeps the caller's identity-map
    # entries alive for as long as the caller holds the stats.
    stats["_rules"] = touched
    return stats
