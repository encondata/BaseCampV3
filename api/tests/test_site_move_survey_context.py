"""Context-building tests for the Site & Move Survey report: V2 alias
compatibility, yes/no rendering, address parts, and the full
`build_context` assembly (empty-move case included). Pure Python — no DB;
`Site`/`Partner`/`Person`/`Initiative` are constructed directly (never
flushed) purely for their attributes. See
docs/superpowers/specs/2026-09-11-site-move-survey-design.md § Report
module."""

import uuid
from datetime import datetime

import pytest

from serversherpa.db.models import Initiative, Partner, Person, Site
from serversherpa.reports.registry import OptionsError
from serversherpa.reports.site_move_survey import (
    default_options, validate_options, validate_run_options,
)
from serversherpa.reports.site_move_survey.context import (
    SiteCtxInput, build_context, site_context,
)


def _site(**kw):
    base = dict(id=uuid.uuid4(), name="Datacenter West", address_line1="300 Origin St",
                address_line2=None, city="Seattle", region="WA", postal_code="98101",
                country="USA")
    base.update(kw)
    return Site(**base)


def _partner(**kw):
    base = dict(id=uuid.uuid4(), name="Champagne Logistics")
    base.update(kw)
    return Partner(**base)


def _person(**kw):
    base = dict(id=uuid.uuid4(), first_name="Jimmy", last_name="Henderson",
                preferred_name=None, phone="(555) 100-2000", email="jimmy@cumulus.example")
    base.update(kw)
    return Person(**base)


def _initiative(**kw):
    base = dict(id=uuid.uuid4(), name="Q3 Data Center Relocation",
                scheduled_start=datetime(2026, 7, 15, 8, 30))
    base.update(kw)
    return Initiative(**base)


# ---------------------------------------------------------------------------
# site_context — V2 aliases, yes/no rendering, address parts
# ---------------------------------------------------------------------------

def test_site_context_emits_every_registry_key_and_v2_aliases():
    survey = {
        "contact_name": "Bob Origin", "dock_available": True,
        "trailer_75ft_accessible": False, "entrance_details": "Loading dock on the left",
    }
    ctx = site_context(_site(), survey)["survey"]

    # Every sites/survey.py registry key is present (even unanswered ones).
    for key in ("contact_name", "contact_phone", "contact_email", "floor",
               "elevator_available", "security_clearance_required",
               "security_details", "dock_available", "dock_hours",
               "trailer_75ft_accessible", "ground_level_entrance",
               "entrance_details", "dock_to_dc_distance_ft",
               "floor_covering_required", "forklift_required",
               "additional_notes"):
        assert key in ctx

    # V2 aliases resolve to the same rendered value as their V3 key.
    assert ctx["site_contact_name"] == ctx["contact_name"] == "Bob Origin"
    assert ctx["dock_75ft_accessible"] == ctx["trailer_75ft_accessible"] == "no"
    assert ctx["ground_level_details"] == ctx["entrance_details"] == "Loading dock on the left"


def test_site_context_renders_booleans_as_yes_no_and_none_as_empty_string():
    survey = {"dock_available": True, "elevator_available": False, "floor": 3}
    ctx = site_context(_site(), survey)["survey"]

    assert ctx["dock_available"] == "yes"
    assert ctx["elevator_available"] == "no"
    assert ctx["floor"] == 3                    # ints pass through unchanged
    assert ctx["security_clearance_required"] == ""  # unanswered bool -> ''
    assert ctx["dock_hours"] == ""                    # unanswered text -> ''


def test_site_context_mirrors_top_level_contact_fields_from_survey():
    survey = {"contact_name": "Bob Origin", "contact_phone": "(555) 111-2222",
              "contact_email": "bob@dcw.example"}
    ctx = site_context(_site(), survey)

    assert ctx["contact_name"] == "Bob Origin"
    assert ctx["contact_phone"] == "(555) 111-2222"
    assert ctx["contact_email"] == "bob@dcw.example"


def test_site_context_address_parts():
    site = _site(address_line1="300 Origin St", address_line2="Suite 4",
                city="Seattle", region="WA", postal_code="98101", country="USA")
    ctx = site_context(site, {})

    assert ctx["address"] == "300 Origin St"
    assert ctx["address_full"] == "300 Origin St, Suite 4, Seattle, WA, 98101, USA"
    assert ctx["city"] == "Seattle"
    assert ctx["state"] == "WA"
    assert ctx["zip"] == "98101"
    assert ctx["country"] == "USA"


def test_site_context_address_full_skips_empty_parts():
    site = _site(address_line1="300 Origin St", address_line2=None, city="Seattle",
                region=None, postal_code=None, country=None)
    ctx = site_context(site, {})

    assert ctx["address_full"] == "300 Origin St, Seattle"


def test_site_context_none_site_returns_blank_shape_with_survey_still_rendered():
    ctx = site_context(None, {"dock_available": True})

    assert ctx["id"] == "" and ctx["name"] == "" and ctx["address"] == ""
    assert ctx["address_full"] == "" and ctx["city"] == "" and ctx["state"] == ""
    assert ctx["zip"] == "" and ctx["country"] == "" and ctx["client_id"] == ""
    assert ctx["survey"]["dock_available"] == "yes"


def test_site_ctx_input_pairs_site_and_survey():
    site = _site()
    survey = {"dock_available": True}
    pair = SiteCtxInput(site=site, survey=survey)

    assert pair.site is site
    assert pair.survey == survey


# ---------------------------------------------------------------------------
# build_context — full assembly
# ---------------------------------------------------------------------------

def _base_kwargs(**overrides):
    base = dict(partner=_partner(), company_name="Cumulus Solutions Group",
                contact=_person(), client_address="200 Corporate Blvd, Anywhere, USA",
                initiative=_initiative(), origin=_site(), destination=_site(name="DC East"),
                origin_survey={}, destination_survey={}, assets_notes="", asset_count=1)
    base.update(overrides)
    return base


def test_build_context_partner_customer_and_client_alias():
    partner = _partner(name="Champagne Logistics")
    contact = _person(first_name="Jimmy", last_name="Henderson", preferred_name=None,
                      phone="(555) 100-2000", email="jimmy@cumulus.example")
    ctx = build_context(**_base_kwargs(partner=partner, contact=contact))

    assert ctx["partner"] == {"id": str(partner.id), "name": "Champagne Logistics"}
    assert ctx["customer"]["company"] == "Cumulus Solutions Group"
    assert ctx["customer"]["contact_name"] == "Jimmy Henderson"
    assert ctx["customer"]["phone"] == "(555) 100-2000"
    assert ctx["customer"]["email"] == "jimmy@cumulus.example"
    assert ctx["customer"]["address"] == "200 Corporate Blvd, Anywhere, USA"
    # customer and client are the SAME object (V2's dual-name aliasing).
    assert ctx["client"] is ctx["customer"]


def test_build_context_contact_prefers_preferred_name():
    # preferred_name replaces the FIRST name only (Person.display_name,
    # db/models.py) — the last name always stays on.
    contact = _person(preferred_name="Jimbo", first_name="Jimmy", last_name="Henderson")
    ctx = build_context(**_base_kwargs(contact=contact))
    assert ctx["customer"]["contact_name"] == "Jimbo Henderson"


def test_build_context_no_contact_leaves_customer_fields_blank():
    ctx = build_context(**_base_kwargs(contact=None))
    assert ctx["customer"]["contact_name"] == ""
    assert ctx["customer"]["phone"] == ""
    assert ctx["customer"]["email"] == ""


def test_build_context_move_fields_from_initiative():
    initiative = _initiative(name="Q3 Data Center Relocation",
                             scheduled_start=datetime(2026, 7, 15, 8, 30))
    ctx = build_context(**_base_kwargs(initiative=initiative, asset_count=4))

    assert ctx["move"]["id"] == str(initiative.id)
    assert ctx["move"]["name"] == "Q3 Data Center Relocation"
    assert ctx["move"]["scheduled_start"] == "2026-07-15 08:30 AM"
    assert ctx["move"]["scheduled_start_date"] == "2026-07-15"
    assert ctx["move"]["scheduled_start_time"] == "08:30 AM"
    assert ctx["move"]["asset_count"] == 4
    assert ctx["move"]["survey"] == {}   # move.survey.* stays reserved/empty


def test_build_context_empty_move_when_no_initiative():
    ctx = build_context(**_base_kwargs(initiative=None, asset_count=0))

    assert ctx["move"] == {
        "id": "", "name": "", "scheduled_start": "", "scheduled_start_date": "",
        "scheduled_start_time": "", "asset_count": "", "survey": {},
    }


def test_build_context_origin_and_destination_use_site_context():
    origin = _site(name="Datacenter West")
    destination = _site(name="Datacenter East")
    ctx = build_context(**_base_kwargs(
        origin=origin, destination=destination,
        origin_survey={"dock_available": True},
        destination_survey={"dock_available": False}))

    assert ctx["origin"]["name"] == "Datacenter West"
    assert ctx["origin"]["survey"]["dock_available"] == "yes"
    assert ctx["destination"]["name"] == "Datacenter East"
    assert ctx["destination"]["survey"]["dock_available"] == "no"


def test_build_context_assets_notes_only_when_zero_assets():
    with_assets = build_context(**_base_kwargs(assets_notes="ships separately", asset_count=2))
    assert with_assets["assets_notes"] == "" and with_assets["asset_notes"] == ""

    without_assets = build_context(**_base_kwargs(assets_notes="ships separately", asset_count=0))
    assert without_assets["assets_notes"] == "ships separately"
    assert without_assets["asset_notes"] == "ships separately"
    # both names alias the same value
    assert without_assets["assets_notes"] == without_assets["asset_notes"]


def test_build_context_no_partner_leaves_partner_blank():
    ctx = build_context(**_base_kwargs(partner=None))
    assert ctx["partner"] == {"id": "", "name": ""}


# ---------------------------------------------------------------------------
# validate_options / validate_run_options
# ---------------------------------------------------------------------------

def test_validate_options_rejects_unknown_key():
    with pytest.raises(OptionsError) as exc:
        validate_options({"not_a_real_option": True})
    assert any("not_a_real_option" in p for p in exc.value.problems)


def test_validate_options_rejects_non_bool_toggle():
    with pytest.raises(OptionsError) as exc:
        validate_options({"include_site_photos": "yes"})
    assert any("include_site_photos" in p for p in exc.value.problems)


def test_validate_options_rejects_non_string_company_name():
    with pytest.raises(OptionsError) as exc:
        validate_options({"company_name": 12345})
    assert any("company_name" in p for p in exc.value.problems)


def test_validate_options_does_not_require_partner_id():
    # A definition patch touching only the toggles/company name never
    # carries a partner — validate_options (unlike validate_run_options)
    # must not demand one.
    normalized = validate_options({"company_name": "Acme"})
    assert normalized["company_name"] == "Acme"
    assert "partner_id" not in normalized


def test_validate_options_accepts_run_only_keys_without_requiring_partner_id():
    # Shape-only: a run-only key present without partner_id is still a
    # SHAPE-valid dict for validate_options — required-ness is
    # validate_run_options's job, not this one's.
    normalized = validate_options({"asset_notes": "ships separately"})
    assert normalized["asset_notes"] == "ships separately"


def test_validate_run_options_without_partner_id_raises():
    with pytest.raises(OptionsError) as exc:
        validate_run_options({"asset_notes": "ships separately"})
    assert "option 'partner_id' is required" in exc.value.problems


def test_validate_run_options_with_partner_id_returns_normalized_dict_with_defaults():
    partner_id = str(uuid.uuid4())
    normalized = validate_run_options({"partner_id": partner_id})

    assert normalized["partner_id"] == partner_id
    # every definition-level default is still present
    for key, value in default_options().items():
        assert normalized[key] == value


def test_validate_run_options_rejects_unknown_key_like_validate_options():
    with pytest.raises(OptionsError) as exc:
        validate_run_options({"partner_id": str(uuid.uuid4()), "bogus": 1})
    assert any("bogus" in p for p in exc.value.problems)
