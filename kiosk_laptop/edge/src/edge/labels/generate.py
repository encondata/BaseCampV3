"""The Label Station's labels: one finished label per asset on the move,
made with the portal's OWN label code (serversherpa.labels from api/src —
label_values, fields, render and pick, never a copy), so a label printed
here is byte-equal to the one the portal generates.

Inputs come from the sync cache only: the move's assets with their
`label_context`, and the move's label template set. `build_plan` picks the
template for the station's label kind and printer DPI and computes every
asset's values; each job carries a fingerprint of everything its label
depends on, so `changed_jobs` re-renders only what changed. A design
template renders from its `design` JSON (compiled with the values, as the
portal does), never from its token-intact compiled `code`.

Two value paths, by the picked template's schema (`template_schema`): a
label builder design (schema 2) prints `fields.field_values(item,
label_context)`, the text the portal's generator prints for it, kept to
the fields the design places; a code template or an older design keeps
the placeholder catalog (`asset_label_values`). A schema newer than
SUPPORTED_SCHEMA is a design this edge's compiler predates: every label of
it is `template_unsupported` and nothing prints until the laptop is
updated (its fingerprint names SUPPORTED_SCHEMA, so the update redoes it).

Never import serversherpa.labels.generate here: that package needs
sqlalchemy, which the edge image doesn't have."""

import hashlib
import json
from datetime import date
from decimal import Decimal, InvalidOperation
from types import SimpleNamespace
from typing import NamedTuple

from serversherpa.labels.fields import design_field_keys, field_values
from serversherpa.labels.label_values import LabelAsset, LabelMove, asset_label_values
from serversherpa.labels.pick import TemplateChoice, pick_template
from serversherpa.labels.render import render_template
from serversherpa.labels.template_fonts import design_fonts, fonts_used

from edge import laptop_setup
from edge.db import Store, now_iso
from edge.sync import sync_paths

NO_TEMPLATE = "no_template_at_dpi"
TEMPLATE_FAILED = "template_failed"
TEMPLATE_UNSUPPORTED = "template_unsupported"

# The newest design schema this edge's compiler prints (labels/model.py).
SUPPORTED_SCHEMA = 2


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
    # False when the cache holds no usable asset data (no assets read yet, or
    # one from a portal without `label_context`): `assets` is then empty for
    # want of data, not because the move has none, so nothing may be pruned
    has_asset_data: bool = True
    # with no template picked: the DPIs at which the move's downloaded set
    # has one for this kind (`available_dpis`), so the kiosk can say what to
    # do; empty when a template was picked
    available_dpis: tuple[str, ...] = ()


def _dpi_sort_key(dpi: str) -> tuple:
    """DPI keys in natural order: "203" < "300" < "1200"."""
    return (0, int(dpi), "") if dpi.isdigit() else (1, 0, dpi.casefold())


def available_dpis(choices: list[TemplateChoice], kind: str) -> tuple[str, ...]:
    """The DPIs (natural order) at which `pick_template` finds a `kind`
    template among `choices`: what a printer would need for this move."""
    dpis = {t.dpi_key for t in choices if t.label_type == kind}
    return tuple(sorted((d for d in dpis if pick_template(choices, kind, d)[0] is not None),
                        key=_dpi_sort_key))


def _fingerprint(parts: list) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()


def cached(store: Store, key: str) -> dict | None:
    """A cached sync body (a JSON object), or None."""
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


def _schema(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 1


def template_schema(t: dict) -> int:
    """A synced template's design schema, read like the server's
    `kiosk_templates.design_schema` (1 for a code template, or a `schema`
    that isn't an int), or its `schema_version` when that says more (a
    kind of template this edge doesn't know yet)."""
    design = t.get("design")
    schema = (_schema(design.get("schema", 1))
              if t.get("kind") == "design" and isinstance(design, dict) else 1)
    return max(schema, _schema(t.get("schema_version", 1)))


def template_fonts(t: dict | None) -> list[str]:
    """The E: fonts a synced template prints with, the way the portal's
    kiosk font routes count them: a builder design's from its text
    elements (its `code` is ""), any other from its compiled code."""
    if t is None:
        return []
    names = (design_fonts(t.get("design")) if template_schema(t) >= 2
             else fonts_used(t.get("code") or ""))
    return sorted(names)


def _setting(raw, override, valid) -> object | None:
    value = override if override is not None else raw
    return value if valid(value) else None


def build_plan(store: Store, *, label_kind: str | None = None,
               dpi: int | None = None) -> Plan | None:
    """The station's label work from the cached move, or None when this
    laptop isn't a Label Station with usable label settings. `label_kind`
    and `dpi` override the saved ones (setup previews a choice before
    saving it); with both given, no saved settings are needed. A cached
    asset list without `label_context` (a portal from before it) gives no
    jobs and `has_asset_data` False: the values can't be rebuilt faithfully
    without it."""
    setup = laptop_setup.load(store)
    if not setup or setup.get("station_type") != "label":
        return None
    station = setup.get("label_station")
    initiative = setup.get("initiative_id")
    if not initiative:
        return None
    if not isinstance(station, dict):
        station = {}
    label_kind = _setting(station.get("label_kind"), label_kind,
                          lambda v: v in laptop_setup.LABEL_KINDS)
    dpi = _setting(station.get("dpi"), dpi,
                   lambda v: isinstance(v, int) and not isinstance(v, bool) and v > 0)
    if label_kind is None or dpi is None:
        return None
    paths = sync_paths(initiative)
    assets_body = cached(store, next(p for p in paths if p.startswith("/kiosk/sync/assets?")))
    templates_body = cached(
        store, next(p for p in paths if p.startswith("/kiosk/sync/label-templates?")))

    by_id: dict[str, dict] = {}
    choices: list[TemplateChoice] = []
    for t in (templates_body or {}).get("templates") or []:
        choice = _choice(t) if isinstance(t, dict) else None
        if choice is not None:
            by_id[choice.id] = t
            choices.append(choice)
    template, notes = pick_template(choices, label_kind, str(dpi))
    elsewhere = available_dpis(choices, label_kind) if template is None else ()
    template_json = by_id[template.id] if template else None
    rules = (template_json or {}).get("generation_rules") or None
    schema = template_schema(template_json) if template_json is not None else 1
    # a builder design's fields: the only values its label prints, so the
    # only ones its fingerprint follows (statuses move with every scan)
    placed = design_field_keys(template_json.get("design")) if schema >= 2 else set()

    context = (assets_body or {}).get("label_context")
    asset_rows = (assets_body or {}).get("assets")
    has_data = isinstance(context, dict) and isinstance(asset_rows, list)
    jobs: list[AssetJob] = []
    if has_data:
        move = LabelMove(name=context.get("move_name"), day=_day(context.get("move_day")),
                         source_site=context.get("source_site"),
                         destination_site=context.get("destination_site"))
        catalog_keys = list(context.get("catalog_keys") or [])
        for a in asset_rows:
            if not isinstance(a, dict) or not a.get("id"):
                continue
            if template is None:
                values = asset_label_values(_label_asset(a), move, catalog_keys,
                                            generation_rules=rules)
                fingerprint = _fingerprint(["no_template", dpi, label_kind])
            elif schema > SUPPORTED_SCHEMA:
                # nothing to compute: the label is an error until an update
                values = {}
                fingerprint = _fingerprint(["unsupported", template.id, template.version,
                                            schema, SUPPORTED_SCHEMA, dpi, label_kind])
            else:
                if schema >= 2:
                    every = field_values(a, context)
                    values = {k: every[k] for k in sorted(placed) if k in every}
                else:
                    values = asset_label_values(_label_asset(a), move, catalog_keys,
                                                generation_rules=rules)
                # the size/DPI vocabulary and language ride along: a vocab
                # edit changes the label without bumping the template version
                fingerprint = _fingerprint([values, template.id, template.version, dpi,
                                            label_kind, template_json.get("width_in"),
                                            template_json.get("height_in"),
                                            template_json.get("dots"),
                                            template_json.get("language_key")])
            jobs.append(AssetJob(str(a["id"]), values, fingerprint))
    return Plan(template, notes, jobs, template_json, label_kind, dpi, has_data, elsewhere)


def changed_jobs(store: Store, plan: Plan) -> list[AssetJob]:
    """The jobs whose stored label is missing or was made from other inputs."""
    have = {r["asset_id"]: r["fingerprint"]
            for r in store.all("SELECT asset_id, fingerprint FROM station_labels")}
    return [job for job in plan.assets if have.get(job.asset_id) != job.fingerprint]


def render_job(template_json: dict | None, job: AssetJob) -> tuple[str | None, str | None]:
    """`(zpl, None)`, or `(None, error)`. Unknown placeholders are not an
    error (they print blank, as on the portal). A design template whose size
    or DPI has no vocabulary details (width_in, height_in, dots) is
    template_failed, never rendered at size 0; one newer than this edge's
    compiler is template_unsupported, never guessed at."""
    if template_json is None:
        return None, NO_TEMPLATE
    if template_schema(template_json) > SUPPORTED_SCHEMA:
        return None, TEMPLATE_UNSUPPORTED
    kind = template_json.get("kind") or "code"
    if kind == "design" and not all(
            _positive(template_json.get(k)) for k in ("width_in", "height_in", "dots")):
        return None, TEMPLATE_FAILED
    source = SimpleNamespace(
        kind=kind, code=template_json.get("code") if kind == "code" else None,
        design=template_json.get("design") if kind == "design" else None,
        language_key=template_json.get("language_key") or "zpl")
    try:
        zpl, _unknown = render_template(
            source, job.values, width_in=template_json.get("width_in") or 0,
            height_in=template_json.get("height_in") or 0,
            dots=template_json.get("dots") or 0)  # 0s only reach a code template
    except Exception:  # a design the shared compiler can't handle
        return None, TEMPLATE_FAILED
    return zpl, None


def _positive(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


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
    """Drop the labels of assets no longer on the move; returns how many.
    A plan without asset data prunes nothing (it would drop every label)."""
    if not plan.has_asset_data:
        return 0
    keep = {job.asset_id for job in plan.assets}
    with store.tx() as c:
        gone = [r["asset_id"] for r in c.execute("SELECT asset_id FROM station_labels")
                if r["asset_id"] not in keep]
        for asset_id in gone:
            c.execute("DELETE FROM station_labels WHERE asset_id = ?", (asset_id,))
    return len(gone)
