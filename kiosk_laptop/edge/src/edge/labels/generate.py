"""The Label Station's labels: one finished label per asset on the move,
made with the portal's OWN label code (serversherpa.labels from api/src —
label_values, render and pick, never a copy), so a label printed here is
byte-equal to the one the portal generates.

Inputs come from the sync cache only: the move's assets with their
`label_context`, and the move's label template set. `build_plan` picks the
template for the station's label kind and printer DPI and computes every
asset's values; each job carries a fingerprint of everything its label
depends on, so `changed_jobs` re-renders only what changed. A design
template renders from its `design` JSON (compiled with the values, as the
portal does), never from its token-intact compiled `code`.

Never import serversherpa.labels.generate here: that package needs
sqlalchemy, which the edge image doesn't have."""

import hashlib
import json
from datetime import date
from decimal import Decimal, InvalidOperation
from types import SimpleNamespace
from typing import NamedTuple

from serversherpa.labels.label_values import LabelAsset, LabelMove, asset_label_values
from serversherpa.labels.pick import TemplateChoice, pick_template
from serversherpa.labels.render import render_template

from edge import laptop_setup
from edge.db import Store, now_iso
from edge.sync import sync_paths

NO_TEMPLATE = "no_template_at_dpi"
TEMPLATE_FAILED = "template_failed"


class AssetJob(NamedTuple):
    asset_id: str
    values: dict[str, str]
    fingerprint: str


class Plan(NamedTuple):
    template: TemplateChoice | None
    notes: list[str]
    assets: list[AssetJob]
    # the picked template's sync payload (what render_job compiles) and the
    # station settings the rows record
    template_json: dict | None = None
    label_kind: str = ""
    dpi: int = 0


def _fingerprint(parts: list) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()


def _cached(store: Store, key: str) -> dict | None:
    row = store.one("SELECT body FROM cache WHERE key = ?", (key,))
    if row is None:
        return None
    try:
        body = json.loads(row["body"])
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _decimal(raw) -> Decimal | None:
    if raw is None or raw == "":
        return None
    try:
        return Decimal(str(raw))
    except InvalidOperation:
        return None


def _day(raw) -> date | None:
    try:
        return date.fromisoformat(raw) if isinstance(raw, str) and raw else None
    except ValueError:
        return None


def _choice(t: dict) -> TemplateChoice | None:
    try:
        return TemplateChoice(id=str(t["id"]), family=str(t["family"]),
                              label_type=str(t["label_type"]), dpi_key=str(t["dpi_key"]),
                              version=int(t["version"]), updated_at=str(t["updated_at"]),
                              scope=t.get("scope") or "global")
    except (KeyError, TypeError, ValueError):
        return None


def _label_asset(a: dict) -> LabelAsset:
    return LabelAsset(
        legacy_id=a.get("legacy_id"), name=a.get("name"), serial_number=a.get("serial_number"),
        make=a.get("make"), model=a.get("model"), source_rack=a.get("source_rack"),
        source_ru=_decimal(a.get("source_ru_raw")), source_position=a.get("source_position"),
        destination_rack=a.get("destination_rack"),
        destination_ru=_decimal(a.get("destination_ru_raw")),
        destination_position=a.get("destination_position"))


def build_plan(store: Store) -> Plan | None:
    """The station's label work from the cached move, or None when this
    laptop isn't a Label Station with its label settings saved. A cached
    asset list without `label_context` (a portal from before it) gives no
    jobs: the values can't be rebuilt faithfully without it."""
    setup = laptop_setup.load(store)
    if not setup or setup.get("station_type") != "label":
        return None
    station = setup.get("label_station")
    initiative = setup.get("initiative_id")
    if not isinstance(station, dict) or not initiative:
        return None
    label_kind, dpi = station["label_kind"], int(station["dpi"])
    paths = sync_paths(initiative)
    assets_body = _cached(store, next(p for p in paths if p.startswith("/kiosk/sync/assets?")))
    templates_body = _cached(
        store, next(p for p in paths if p.startswith("/kiosk/sync/label-templates?")))

    by_id: dict[str, dict] = {}
    choices: list[TemplateChoice] = []
    for t in (templates_body or {}).get("templates") or []:
        choice = _choice(t) if isinstance(t, dict) else None
        if choice is not None:
            by_id[choice.id] = t
            choices.append(choice)
    template, notes = pick_template(choices, label_kind, str(dpi))
    template_json = by_id[template.id] if template else None
    rules = (template_json or {}).get("generation_rules") or None

    context = (assets_body or {}).get("label_context")
    jobs: list[AssetJob] = []
    if isinstance(context, dict):
        move = LabelMove(name=context.get("move_name"), day=_day(context.get("move_day")),
                         source_site=context.get("source_site"),
                         destination_site=context.get("destination_site"))
        catalog_keys = list(context.get("catalog_keys") or [])
        for a in (assets_body or {}).get("assets") or []:
            if not isinstance(a, dict) or not a.get("id"):
                continue
            values = asset_label_values(_label_asset(a), move, catalog_keys,
                                        generation_rules=rules)
            if template is not None:
                fingerprint = _fingerprint([values, template.id, template.version, dpi,
                                            label_kind])
            else:
                fingerprint = _fingerprint(["no_template", dpi, label_kind])
            jobs.append(AssetJob(str(a["id"]), values, fingerprint))
    return Plan(template, notes, jobs, template_json, label_kind, dpi)


def changed_jobs(store: Store, plan: Plan) -> list[AssetJob]:
    """The jobs whose stored label is missing or was made from other inputs."""
    have = {r["asset_id"]: r["fingerprint"]
            for r in store.all("SELECT asset_id, fingerprint FROM station_labels")}
    return [job for job in plan.assets if have.get(job.asset_id) != job.fingerprint]


def render_job(template_json: dict | None, job: AssetJob) -> tuple[str | None, str | None]:
    """`(zpl, None)`, or `(None, error)`. Unknown placeholders are not an
    error (they print blank, as on the portal)."""
    if template_json is None:
        return None, NO_TEMPLATE
    kind = template_json.get("kind") or "code"
    source = SimpleNamespace(
        kind=kind, code=template_json.get("code") if kind == "code" else None,
        design=template_json.get("design") if kind == "design" else None,
        language_key=template_json.get("language_key") or "zpl")
    try:
        zpl, _unknown = render_template(
            source, job.values, width_in=template_json.get("width_in") or 0,
            height_in=template_json.get("height_in") or 0,
            dots=template_json.get("dots") or 0)
    except Exception:  # a design the shared compiler can't handle
        return None, TEMPLATE_FAILED
    return zpl, None


def apply(store: Store, plan: Plan, job: AssetJob, zpl: str | None, error: str | None) -> None:
    """Store one asset's finished label, replacing its old row in one write
    (the old label stays printable until the new one is ready)."""
    t = plan.template
    name = (plan.template_json or {}).get("name") if t else None
    store.run(
        "INSERT INTO station_labels (asset_id, label_kind, dpi, template_id, template_version, "
        "template_name, fingerprint, zpl, error, generated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (asset_id) DO UPDATE SET "
        "label_kind = excluded.label_kind, dpi = excluded.dpi, "
        "template_id = excluded.template_id, template_version = excluded.template_version, "
        "template_name = excluded.template_name, fingerprint = excluded.fingerprint, "
        "zpl = excluded.zpl, error = excluded.error, generated_at = excluded.generated_at",
        (job.asset_id, plan.label_kind, plan.dpi, t.id if t else None,
         t.version if t else None, name, job.fingerprint, zpl, error, now_iso()))


def prune(store: Store, plan: Plan) -> int:
    """Drop the labels of assets no longer on the move; returns how many."""
    keep = {job.asset_id for job in plan.assets}
    with store.tx() as c:
        gone = [r["asset_id"] for r in c.execute("SELECT asset_id FROM station_labels")
                if r["asset_id"] not in keep]
        for asset_id in gone:
            c.execute("DELETE FROM station_labels WHERE asset_id = ?", (asset_id,))
    return len(gone)
