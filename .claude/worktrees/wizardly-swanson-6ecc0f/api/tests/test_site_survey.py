import pytest

from serversherpa.sites.survey import (
    FIELDS_BY_KEY, SURVEY_GROUPS, SurveyError, survey_schema, validate_survey,
)


def test_registry_covers_the_legacy_groups():
    assert [g for g, _ in SURVEY_GROUPS] == ["contact", "facility", "dock", "notes"]
    assert "contact_name" in FIELDS_BY_KEY
    assert FIELDS_BY_KEY["dock_available"].kind == "bool"
    assert FIELDS_BY_KEY["floor"].kind == "int"


def test_valid_partial_survey_passes():
    out = validate_survey({"contact_name": " Dana ", "dock_available": True,
                           "floor": 3})
    assert out == {"contact_name": "Dana", "dock_available": True, "floor": 3}


def test_empty_values_dropped():
    assert validate_survey({"contact_name": "   ", "dock_hours": None}) == {}


def test_unknown_field_rejected():
    with pytest.raises(SurveyError) as exc:
        validate_survey({"nope": "x"})
    assert exc.value.code == "unknown_survey_field"
    assert exc.value.field == "nope"


def test_wrong_type_rejected():
    with pytest.raises(SurveyError) as exc:
        validate_survey({"dock_available": "yes"})
    assert exc.value.code == "invalid_survey_value"
    assert exc.value.field == "dock_available"
    with pytest.raises(SurveyError):
        validate_survey({"floor": "three"})


def test_select_option_enforced():
    assert validate_survey({"floor_covering_required": "carpet"})
    with pytest.raises(SurveyError):
        validate_survey({"floor_covering_required": "shag"})


def test_schema_is_json_ready():
    schema = survey_schema()
    assert [g["key"] for g in schema["groups"]] == ["contact", "facility",
                                                    "dock", "notes"]
    dock = next(g for g in schema["groups"] if g["key"] == "dock")
    keys = [f["key"] for f in dock["fields"]]
    assert "dock_available" in keys and "dock_hours" in keys
