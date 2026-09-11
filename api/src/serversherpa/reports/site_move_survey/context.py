"""Context building for the Site & Move Survey xlsx.

Pure functions over plain inputs (a `Site` row or `None`, a resolved
survey-answers dict, a `Partner`/`Person`/`Initiative` row or `None`) —
no DB access; Task 3's `gather.py` is the layer that reads the database
and hands this module already-resolved rows. See
docs/superpowers/specs/2026-09-11-site-move-survey-design.md § Report
module for the exact keys, and
/Users/jrh1812/Developer/BaseCampV2-reference/api/reports/site_move_survey.py
(read-only reference) for the behavior this ports (`_site_context` /
`_build_context`).
"""

from dataclasses import dataclass
from typing import Any

from serversherpa.db.models import Initiative, Partner, Person, Site
from serversherpa.sites.survey import SURVEY_FIELDS

# V2 placeholder names that don't match a V3 `sites/survey.py` registry
# key 1:1. Kept as aliases (both names resolve to the same rendered value)
# so the Champagne annotation map — and any other V2-derived template —
# keeps working without a re-annotation pass. See the design spec's
# "Report module" section and the template-annotation-guide's §10 map.
V2_SURVEY_ALIASES: dict[str, str] = {
    "site_contact_name": "contact_name",
    "dock_75ft_accessible": "trailer_75ft_accessible",
    "ground_level_details": "entrance_details",
}


def _render_survey_value(value: Any) -> Any:
    """bool -> 'yes'/'no' (matches how the Site Survey Data editor stores
    and the guide documents rendering); `None` -> ''; `int`/`str` pass
    through unchanged."""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if value is None:
        return ""
    return value


def _survey_context(survey: dict) -> dict:
    """Every `sites/survey.py` registry key (rendered), plus the V2
    aliases, so a template may use either name."""
    out = {field.key: _render_survey_value(survey.get(field.key))
           for field in SURVEY_FIELDS}
    for v2_key, v3_key in V2_SURVEY_ALIASES.items():
        out[v2_key] = out[v3_key]
    return out


@dataclass(frozen=True)
class SiteCtxInput:
    """What one side (origin/destination) of the survey needs: the `Site`
    row (or `None` — e.g. a destination not yet chosen) and its raw
    survey answers keyed by the `sites/survey.py` registry key. A
    convenience pairing for Task 3/4's gather step; `site_context` itself
    takes the two parts separately."""
    site: Site | None
    survey: dict[str, object]


def site_context(site: Site | None, survey: dict[str, object] | None) -> dict:
    """Build the `origin`/`destination` context dict for one site.

    `address` is `address_line1` (street only, matching V2's parsed
    "street" segment); `address_full` joins every non-empty address part
    with ", "; `state`/`zip` are `region`/`postal_code` under their V2
    names. `contact_name`/`contact_phone`/`contact_email` mirror the
    survey's own `contact_*` answers (there's no separate site-contact
    column in V3 — the Site Survey Data section is the only place a site
    contact is recorded).
    """
    survey = survey or {}
    survey_ctx = _survey_context(survey)
    contact_name = survey_ctx["contact_name"]
    contact_phone = survey_ctx["contact_phone"]
    contact_email = survey_ctx["contact_email"]

    if site is None:
        return {
            "id": "", "name": "", "address": "", "address_full": "",
            "city": "", "state": "", "zip": "", "country": "",
            # Sites link to clients many-to-many in V3 (the `site_clients`
            # join table) rather than by a single column, so there is no
            # single client id to surface here. `build_context`'s
            # `client_address` parameter is how the customer address is
            # actually resolved; this key stays '' for V2 template parity.
            "client_id": "",
            "contact_name": contact_name, "contact_phone": contact_phone,
            "contact_email": contact_email,
            "survey": survey_ctx,
        }

    address_full = ", ".join(str(p) for p in (
        site.address_line1, site.address_line2, site.city, site.region,
        site.postal_code, site.country,
    ) if p)

    return {
        "id": str(site.id) if site.id is not None else "",
        "name": site.name or "",
        "address": site.address_line1 or "",
        "address_full": address_full,
        "city": site.city or "",
        "state": site.region or "",
        "zip": site.postal_code or "",
        "country": site.country or "",
        "client_id": "",
        "contact_name": contact_name, "contact_phone": contact_phone,
        "contact_email": contact_email,
        "survey": survey_ctx,
    }


def _contact_context(contact: Person | None) -> dict:
    if contact is None:
        return {"contact_name": "", "phone": "", "email": ""}
    contact_name = contact.preferred_name or \
        f"{contact.first_name} {contact.last_name}".strip()
    return {"contact_name": contact_name, "phone": contact.phone or "",
            "email": contact.email or ""}


def _move_context(initiative: Initiative | None, asset_count: int) -> dict:
    if initiative is None:
        # Empty strings (not missing keys) when there's no initiative, so
        # a template referencing `{{move.scheduled_start_date}}` etc.
        # renders blank the same way whether the key is absent or empty.
        return {
            "id": "", "name": "", "scheduled_start": "",
            "scheduled_start_date": "", "scheduled_start_time": "",
            "asset_count": 0, "survey": {},
        }
    start = initiative.scheduled_start
    return {
        "id": str(initiative.id) if initiative.id is not None else "",
        "name": initiative.name or "",
        "scheduled_start": start.strftime("%Y-%m-%d %I:%M %p") if start else "",
        "scheduled_start_date": start.strftime("%Y-%m-%d") if start else "",
        "scheduled_start_time": start.strftime("%I:%M %p") if start else "",
        "asset_count": asset_count,
        # moves_survey_data doesn't exist yet in V3 either — reserved,
        # same as V2's `move.survey.*` (see the annotation guide).
        "survey": {},
    }


def build_context(*, partner: Partner | None, company_name: str,
                  contact: Person | None, client_address: str,
                  initiative: Initiative | None, origin: Site | None,
                  destination: Site | None, origin_survey: dict | None,
                  destination_survey: dict | None, assets_notes: str,
                  asset_count: int = 0) -> dict:
    """Assemble the full V2-compatible context dict.

    `client_address` and `asset_count` are resolved by the caller
    (Task 3/4's gather + build steps) since they need the DB: the
    customer's address comes from the origin site's linked client (V3
    links sites to clients many-to-many, so there's no single column to
    read here), and the asset count is `len(assets)` from the same roster
    `assets.asset_rows` condenses separately for the Equipment Listing.

    `assets_notes`/`asset_notes` in the returned dict are the run's notes
    when there are zero assets, else '' — matching the fill engine's own
    zero-assets fallback (`fill.expand_asset_rows`) so a template can
    reference either the cell the engine fills automatically or
    `{{assets_notes}}` directly.
    """
    partner_ctx = ({"id": str(partner.id) if partner.id is not None else "",
                   "name": partner.name or ""}
                  if partner is not None else {"id": "", "name": ""})

    customer_ctx = {"company": company_name, **_contact_context(contact),
                    "address": client_address or "",
                    # No single client id to surface — see client_address
                    # above; V2's customer.id came from the (single)
                    # client FK a site used to have.
                    "id": ""}

    notes = (assets_notes or "") if asset_count == 0 else ""

    return {
        "partner": partner_ctx,
        "customer": customer_ctx,
        "client": customer_ctx,
        "move": _move_context(initiative, asset_count),
        "origin": site_context(origin, origin_survey),
        "destination": site_context(destination, destination_survey),
        "assets_notes": notes,
        "asset_notes": notes,
    }
