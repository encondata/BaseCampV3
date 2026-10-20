"""The built-in ID Badge label type (`id_badge`) and the people fields
(spec docs/superpowers/specs/2026-10-20-badge-templates-design.md §4.1-4.2,
§4.11): the Person group is the only group an ID badge offers, and a custom
type gets every group but it; `person_values` turns the API's person
payload into the text each field prints; and a badge never reaches a kiosk
or a generation run."""

import uuid
from pathlib import Path

from serversherpa.db.models import LabelVocab
from serversherpa.labels import fields
from serversherpa.labels.fields import (
    ALL_LABEL_TYPES,
    FIELD_GROUPS,
    MOCK_VALUES,
    PERSON_KEYS,
    PERSON_LABEL_TYPES,
    person_values,
)
from tests.test_label_fields import _seed_raw_ft
from tests.test_sites_api import login
from tests.test_status_values_write import _make

PERSON_ID = "3f2a9c1e-7b4d-4e21-9a0c-5d6e7f809a1b"

# spec §4.2, in order
PERSON_FIELDS = [
    ("person_name", "Name"),
    ("first_name", "First name"),
    ("last_name", "Last name"),
    ("preferred_name", "Preferred name"),
    ("person_type", "Person type"),
    ("company", "Company"),
    ("parent_company", "Parent company"),
    ("job_title", "Job title"),
    ("roles", "Roles"),
    ("trade", "Trade"),
    ("level", "Level"),
    ("worker_status", "Worker status"),
    ("employee_id", "Employee ID"),
    ("email", "Email"),
    ("phone", "Phone"),
    ("person_rfid_tag", "RFID tag"),
    ("badge_id", "Badge ID"),
    ("badge_short", "Badge ID (short)"),
]
NON_PERSON_GROUPS = ["asset", "model", "move_row", "move", "sites", "container"]


def _keys(label_type):
    return set(fields.catalog_keys(label_type))


# ── the catalog ──────────────────────────────────────────────────────


def test_person_group_only_for_id_badge():
    assert PERSON_LABEL_TYPES == ["id_badge"]
    assert PERSON_KEYS == [k for k, _ in PERSON_FIELDS]
    assert len(PERSON_KEYS) == 18
    group = next(g for g in FIELD_GROUPS if g["key"] == "person")
    assert (group["label"], group["label_types"]) == ("Person", ["id_badge"])
    assert [(f["key"], f["label"]) for f in group["fields"]] == PERSON_FIELDS
    assert {f["kind"] for f in group["fields"]} == {"text"}

    assert _keys("id_badge") == set(PERSON_KEYS)
    assert [g["key"] for g in fields.groups_for("id_badge")] == ["person"]
    # a custom type (New template › Custom…) gets every group but Person
    assert "person_name" not in _keys("shelf")
    assert [g["key"] for g in fields.groups_for("shelf")] == NON_PERSON_GROUPS
    # the five kiosk types never see a person key
    for label_type in ALL_LABEL_TYPES:
        assert not _keys(label_type) & set(PERSON_KEYS), label_type
    # person keys never collide with an asset or container key
    assert "rfid_tag" not in PERSON_KEYS and "person_rfid_tag" in PERSON_KEYS


def test_mock_id_badge_has_no_ft_keys():
    values = fields.mock_field_values("id_badge", {"ft:Badge No", "asset_id"})
    assert set(values) == set(PERSON_KEYS)
    # a plausible worker
    assert values["person_name"] == "Jordan Rivera"
    assert values["company"] == "Rivera Electric"
    assert values["level"] == "L3 Technician"
    assert values["person_type"] == "Worker"
    assert str(uuid.UUID(values["badge_id"])) == values["badge_id"]
    assert values["badge_short"] == values["badge_id"][:8]
    assert all(values[k] == MOCK_VALUES[k] for k in PERSON_KEYS)
    assert not fields.allows_from_to("id_badge")
    # a custom type still mocks its From-To columns, but no person key
    shelf = fields.mock_field_values("shelf", {"ft:Badge No"})
    assert shelf["ft:Badge No"] == "Badge No" and "person_name" not in shelf
    assert fields.allows_from_to("shelf") and fields.allows_from_to("top")
    assert not fields.allows_from_to("container")


# ── person_values ────────────────────────────────────────────────────

STAFF = {
    "person": {
        "id": PERSON_ID, "first_name": "Avery", "last_name": "Chen", "preferred_name": None,
        "job_title": "Operations Manager", "external_id": "E-1001",
        "email": "avery.chen@example.com", "phone": "555-0100",
        "rfid_tag": "000000000000000000a1b2c3",
    },
    "person_type": "Staff",
    "company": "Cumulus Solutions Group",
    "parent_company": None,
    "roles": ["Staff", "Admin"],
    "trade": None,
    "level": None,
    "worker_status_label": None,
}

WORKER = {
    "person": {
        "id": uuid.UUID("9c0d2e1f-1111-4222-8333-444455556666"), "first_name": "Jordan",
        "last_name": "Rivera", "preferred_name": "Jo", "job_title": None,
        "external_id": None, "email": None, "phone": "555-0199", "rfid_tag": None,
    },
    "person_type": "Worker",
    "company": "Rivera Electric",
    "parent_company": "Rivera Holdings",
    "roles": [],
    "trade": "Electrician",
    "level": {"key": "L3", "title": "Technician"},
    "worker_status_label": "Active",
}


def test_person_values_staff_and_worker():
    assert person_values(STAFF) == {
        "person_name": "Avery Chen", "first_name": "Avery", "last_name": "Chen",
        "preferred_name": "", "person_type": "Staff",
        "company": "Cumulus Solutions Group", "parent_company": "",
        "job_title": "Operations Manager", "roles": "Admin, Staff",
        "trade": "", "level": "", "worker_status": "",
        "employee_id": "E-1001", "email": "avery.chen@example.com", "phone": "555-0100",
        "person_rfid_tag": "A1B2C3",
        "badge_id": PERSON_ID, "badge_short": "3f2a9c1e",
    }
    out = person_values(WORKER)
    assert set(out) == set(PERSON_KEYS)
    assert out["person_name"] == "Jo Rivera"          # the preferred name wins, as display_name
    assert (out["first_name"], out["preferred_name"]) == ("Jordan", "Jo")
    assert out["person_type"] == "Worker"
    assert out["company"] == "Rivera Electric"
    assert out["parent_company"] == "Rivera Holdings"
    assert out["trade"] == "Electrician"
    assert out["level"] == "L3 Technician"
    assert out["worker_status"] == "Active"
    assert out["roles"] == ""
    assert out["badge_id"] == "9c0d2e1f-1111-4222-8333-444455556666"   # a UUID prints its text
    assert out["badge_short"] == "9c0d2e1f"


def test_person_values_blank_preferred_name_is_blank():
    """A whitespace-only preferred name prints as no preferred name, in its
    own field as in person_name; a real one loses its edge spaces."""
    for spaced in ("  ", "\t", " \n "):
        out = person_values({"person": {**STAFF["person"], "preferred_name": spaced}})
        assert (out["preferred_name"], out["person_name"]) == ("", "Avery Chen"), repr(spaced)
    out = person_values({"person": {**STAFF["person"], "preferred_name": "  Ave "}})
    assert (out["preferred_name"], out["person_name"]) == ("Ave", "Ave Chen")


def test_kiosk_label_types_are_the_catalog_types():
    """The kiosk's label types are fields.ALL_LABEL_TYPES, not a hand copy:
    a type added there reaches kiosks, and a person type never does."""
    from serversherpa.labels import kiosk_templates

    assert kiosk_templates.KIOSK_LABEL_TYPES == tuple(ALL_LABEL_TYPES)
    assert not set(kiosk_templates.KIOSK_LABEL_TYPES) & set(PERSON_LABEL_TYPES)
    src = (Path(kiosk_templates.__file__)).read_text()
    assert "KIOSK_LABEL_TYPES = tuple(ALL_LABEL_TYPES)" in src


def test_person_values_roles_natural_and_once():
    out = person_values({**STAFF, "roles": ["Super Admin", "Level 10", "Admin", "Level 2", "Admin", ""]})
    assert out["roles"] == "Admin, Level 2, Level 10, Super Admin"


def test_person_values_blanks():
    bare = person_values({"person": {"id": PERSON_ID, "first_name": "Sam", "last_name": "Ortiz"}})
    assert set(bare) == set(PERSON_KEYS)
    assert bare["person_name"] == "Sam Ortiz"
    for key in ("preferred_name", "email", "phone", "job_title", "employee_id", "person_type",
                "company", "parent_company", "roles", "trade", "level", "worker_status",
                "person_rfid_tag"):
        assert bare[key] == "", key
    assert (bare["badge_id"], bare["badge_short"]) == (PERSON_ID, "3f2a9c1e")
    # nothing at all: every key, blank
    assert person_values({}) == {key: "" for key in PERSON_KEYS}
    # a status label falls back to its key; a level without a title is its key
    out = person_values({**WORKER, "worker_status_label": None, "worker_status": "standby",
                         "level": {"key": "L3", "title": None}})
    assert (out["worker_status"], out["level"]) == ("standby", "L3")
    # a blank preferred name is no preferred name
    spaced = person_values({"person": {**STAFF["person"], "preferred_name": "  "}})
    assert spaced["person_name"] == "Avery Chen"
    # an all-zero tag keeps one digit, as the portal's displayRfid does
    zeros = person_values({"person": {**STAFF["person"], "rfid_tag": "000000"}})
    assert zeros["person_rfid_tag"] == "0"


# ── GET /labels/fields ───────────────────────────────────────────────


async def test_fields_route_id_badge_no_ft_headers(client, db, seeded_user):
    await _seed_raw_ft(db)
    hdrs = await login(client)
    r = await client.get("/labels/fields", headers=hdrs, params={"label_type": "id_badge"})
    assert r.status_code == 200, r.text
    assert [g["key"] for g in r.json()["groups"]] == ["person"]
    assert r.json()["ft_headers"] == []
    person = r.json()["groups"][0]["fields"]
    assert [f["key"] for f in person] == PERSON_KEYS
    assert person[0] == {"key": "person_name", "label": "Name", "kind": "text",
                         "mock": "Jordan Rivera"}


# ── kiosk sync and generation never see a badge ──────────────────────


async def test_move_template_set_skips_badges(client, db, seeded_user):
    from serversherpa.labels.kiosk_templates import KIOSK_LABEL_TYPES, move_template_set
    from tests.test_kiosk_label_templates_sync import _get, _move, _tpl, make_tree

    assert KIOSK_LABEL_TYPES == ("top", "front", "rail", "container", "container_info")
    move, _src, dst, _other = await _move(db)
    badge = {"schema": 2, "size": {"w": 3.375, "h": 2.125}, "elements": [
        {"id": "n", "type": "field", "field": "person_name", "x": 0.1, "y": 0.1, "w": 3,
         "h": 0.4, "rotation": 0, "display": "text",
         "font": {"family": "swiss721-cond-bold", "weight": "regular"}, "sizePt": 18,
         "baselineIn": 0.3, "align": "left"}]}
    # linked to the move's destination AND "generic" in its name: either
    # would pick it if it were a kiosk type
    await make_tree(db, "Generic badge", label_type="id_badge", site_ids=[dst.id], design=badge)
    db.add(LabelVocab(kind="type", key="shelf", label="Shelf", is_active=True))
    db.add(_tpl("Generic shelf", label_type="shelf"))
    db.add(_tpl("Generic top", label_type="top"))
    await db.commit()

    picked = {p.template.name for p in await move_template_set(db, move)}
    assert picked == {"Generic top"}
    r = await _get(client, await login(client), move.id)
    assert r.status_code == 200, r.text
    assert [t["name"] for t in r.json()["templates"]] == ["Generic top"]


async def test_generate_preview_skips_person_types(client, db, seeded_user):
    from tests.test_label_generate_api import _initiative

    assert (await db.get(LabelVocab, ("type", "id_badge"))).is_active
    db.add(LabelVocab(kind="type", key="shelf", label="Shelf", is_active=True, sort_order=9))
    await db.commit()
    ini = await _initiative(db)
    r = await client.get(f"/labels/generate/preview?initiative_id={ini.id}",
                         headers=await login(client))
    assert r.status_code == 200, r.text
    keys = [t["key"] for t in r.json()["types"]]
    assert "id_badge" not in keys
    # a listed custom type still generates (it prints as an asset label)
    assert {"top", "front", "rail", "container", "container_info", "shelf"} <= set(keys)


async def test_enqueue_refuses_id_badge(client, db, seeded_user):
    import pytest

    from serversherpa.labels.generate import InvalidLabelTypes, enqueue_run
    from tests.test_label_generate_api import _initiative, _run_payload

    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-badge@test.example.com")
    r = await client.post("/labels/generate/runs", headers=hdrs,
                          json=_run_payload(ini, ["top", "id_badge"]))
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "invalid_label_types"
    assert r.json()["detail"]["problems"] == ["id_badge"]

    with pytest.raises(InvalidLabelTypes) as err:
        await enqueue_run(db, initiative_id=ini.id, label_types=["id_badge"],
                          regenerate_existing=False, requested_by=uuid.uuid4(), notify=False)
    assert err.value.problems == ["id_badge"]


async def test_the_id_badge_type_and_size_are_seeded(client, db, seeded_user):
    """conftest mirrors migration 0104: the type, after the five kiosk
    types, and the CR80 size it starts on (0042)."""
    row = await db.get(LabelVocab, ("type", "id_badge"))
    assert (row.label, row.is_active, row.sort_order) == ("ID Badge", True, 6)
    size = await db.get(LabelVocab, ("size", "id-badge"))
    assert size.meta == {"width_in": 3.375, "height_in": 2.125, "has_tab": False}
