"""Site survey field registry. Survey answers live in the site_survey_data /
raw_survey_data tables (migration 0027); the fields themselves are defined
HERE, code not DB, so the API validates what it stores and the portal
renders from the same source — the legacy version kept this list in a
client-side JS file the server never checked."""

from dataclasses import dataclass

SURVEY_GROUPS: tuple[tuple[str, str], ...] = (
    ("contact", "Site contact"),
    ("facility", "Facility"),
    ("dock", "Dock & access"),
    ("notes", "Notes"),
)


@dataclass(frozen=True)
class SurveyField:
    key: str
    label: str
    kind: str                       # 'text' | 'textarea' | 'bool' | 'int' | 'select'
    group: str
    options: tuple[str, ...] = ()


SURVEY_FIELDS: tuple[SurveyField, ...] = (
    SurveyField("contact_name", "Contact name", "text", "contact"),
    SurveyField("contact_phone", "Contact phone", "text", "contact"),
    SurveyField("contact_email", "Contact email", "text", "contact"),

    SurveyField("floor", "Floor", "int", "facility"),
    SurveyField("elevator_available", "Elevator available", "bool", "facility"),
    SurveyField("security_clearance_required", "Security clearance required",
                "bool", "facility"),
    SurveyField("security_details", "Security details", "textarea", "facility"),

    SurveyField("dock_available", "Dock available", "bool", "dock"),
    SurveyField("dock_hours", "Dock hours", "text", "dock"),
    SurveyField("trailer_75ft_accessible", "75ft trailer accessible", "bool", "dock"),
    SurveyField("ground_level_entrance", "Ground-level entrance", "bool", "dock"),
    SurveyField("entrance_details", "Entrance details", "textarea", "dock"),
    SurveyField("dock_to_dc_distance_ft", "Dock to DC distance (ft)", "int", "dock"),
    SurveyField("floor_covering_required", "Floor covering required", "select",
                "dock", options=("none", "carpet", "masonite", "other")),
    SurveyField("forklift_required", "Forklift required", "bool", "dock"),

    SurveyField("additional_notes", "Additional notes", "textarea", "notes"),
)

FIELDS_BY_KEY: dict[str, SurveyField] = {f.key: f for f in SURVEY_FIELDS}


class SurveyError(ValueError):
    def __init__(self, code: str, field: str) -> None:
        super().__init__(f"{code}: {field}")
        self.code = code
        self.field = field


def _clean(field: SurveyField, value):
    """Returns the cleaned value, or None when the value is empty (dropped)."""
    if value is None:
        return None
    if field.kind in ("text", "textarea"):
        if not isinstance(value, str):
            raise SurveyError("invalid_survey_value", field.key)
        stripped = value.strip()
        return stripped or None
    if field.kind == "bool":
        if not isinstance(value, bool):
            raise SurveyError("invalid_survey_value", field.key)
        return value
    if field.kind == "int":
        # bool is an int subclass in Python — reject it explicitly
        if isinstance(value, bool) or not isinstance(value, int):
            raise SurveyError("invalid_survey_value", field.key)
        return value
    if field.kind == "select":
        if not isinstance(value, str) or value not in field.options:
            raise SurveyError("invalid_survey_value", field.key)
        return value
    raise SurveyError("invalid_survey_value", field.key)  # unreachable


def validate_survey(data: dict) -> dict:
    """Cleaned copy of `data`. Unknown keys and wrong types raise SurveyError;
    empty values are dropped (a partial survey is normal — no field required)."""
    if not isinstance(data, dict):
        raise SurveyError("invalid_survey_value", "survey_data")
    out: dict = {}
    for key, value in data.items():
        field = FIELDS_BY_KEY.get(key)
        if field is None:
            raise SurveyError("unknown_survey_field", key)
        cleaned = _clean(field, value)
        if cleaned is not None:
            out[key] = cleaned
    return out


def survey_schema() -> dict:
    """JSON-ready registry for the portal to render from."""
    return {
        "groups": [
            {
                "key": group,
                "label": label,
                "fields": [
                    {"key": f.key, "label": f.label, "kind": f.kind,
                     "options": list(f.options)}
                    for f in SURVEY_FIELDS if f.group == group
                ],
            }
            for group, label in SURVEY_GROUPS
        ]
    }
