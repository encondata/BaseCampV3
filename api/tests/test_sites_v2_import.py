"""Pure parsing/mapping helpers of the V2 sites-dump importer."""

from decimal import Decimal

from serversherpa.sites.v2_import import (
    assemble_notes, format_locations_note, insert_rows, parse_gps,
    parse_values_tuple, slugify, split_address, summarize_metadata,
)


# ── parse_values_tuple ──────────────────────────────────────────────

def test_parse_values_tuple_plain_strings():
    assert parse_values_tuple("'hello', 'world'") == ["hello", "world"]


def test_parse_values_tuple_escaped_quote():
    assert parse_values_tuple("'Ha-Sadna''ot St 10'") == ["Ha-Sadna'ot St 10"]


def test_parse_values_tuple_null_and_numbers():
    assert parse_values_tuple("23, NULL, 1.5, -0.4280") == [23, None, 1.5, -0.428]


def test_parse_values_tuple_json_ish_string_untouched():
    raw = "'{\"a\": \"b\", \"c\": 1}'"
    result = parse_values_tuple(raw)
    assert result == ['{"a": "b", "c": 1}']


def test_parse_values_tuple_embedded_newline():
    raw = "'The Chess Building, Caxton Way\nWatford WD18 8UA, United Kingdom'"
    result = parse_values_tuple(raw)
    assert result == ["The Chess Building, Caxton Way\nWatford WD18 8UA, United Kingdom"]


def test_parse_values_tuple_full_row_example():
    raw = (
        "23, 'Watford - Digital Reality', 'The Chess Building, Caxton Way\n"
        "Watford WD18 8UA, United Kingdom', '51.6431, -0.4280', "
        '\'{"dock": "true", "country": "United Kingdom", "access_type": "badge", '
        '"dc_provider": "Digital Realty", "truck_restrictions": "none"}\', '
        "'Data Center', 40, 1, NULL, NULL"
    )
    result = parse_values_tuple(raw)
    assert result[0] == 23
    assert result[1] == "Watford - Digital Reality"
    assert result[2] == ("The Chess Building, Caxton Way\n"
                         "Watford WD18 8UA, United Kingdom")
    assert result[3] == "51.6431, -0.4280"
    assert result[4] == ('{"dock": "true", "country": "United Kingdom", '
                         '"access_type": "badge", "dc_provider": "Digital Realty", '
                         '"truck_restrictions": "none"}')
    assert result[5] == "Data Center"
    assert result[6:] == [40, 1, None, None]


# ── insert_rows ─────────────────────────────────────────────────────

def test_insert_rows_single_statement(tmp_path):
    dump = tmp_path / "dump.sql"
    dump.write_text(
        "INSERT INTO sites (id, name) VALUES (1, 'Alpha');\n"
        "INSERT INTO sites (id, name) VALUES (2, 'Beta');\n"
    )
    rows = list(insert_rows(str(dump), "sites"))
    assert rows == [[1, "Alpha"], [2, "Beta"]]


def test_insert_rows_multiline_statement(tmp_path):
    dump = tmp_path / "dump.sql"
    dump.write_text(
        "INSERT INTO sites (id, name, address) VALUES (23, 'Watford - Digital Reality', "
        "'The Chess Building, Caxton Way\n"
        "Watford WD18 8UA, United Kingdom');\n"
        "INSERT INTO sites (id, name, address) VALUES (24, 'Herzliya', "
        "'Ha-Sadna''ot St 10\n"
        "Herzliya, Israel 4672837');\n"
    )
    rows = list(insert_rows(str(dump), "sites"))
    assert len(rows) == 2
    assert rows[0] == [23, "Watford - Digital Reality",
                       "The Chess Building, Caxton Way\n"
                       "Watford WD18 8UA, United Kingdom"]
    assert rows[1] == [24, "Herzliya",
                       "Ha-Sadna'ot St 10\nHerzliya, Israel 4672837"]


def test_insert_rows_exact_table_name_only(tmp_path):
    dump = tmp_path / "dump.sql"
    dump.write_text(
        "INSERT INTO sites (id, name) VALUES (1, 'Alpha');\n"
        "INSERT INTO sites_locations (id, site_id, name, description) "
        "VALUES (5, 1, 'Rack Room', 'ground floor');\n"
    )
    rows = list(insert_rows(str(dump), "sites"))
    assert rows == [[1, "Alpha"]]


def test_insert_rows_no_matches_yields_nothing(tmp_path):
    dump = tmp_path / "dump.sql"
    dump.write_text("INSERT INTO other_table (id) VALUES (1);\n")
    assert list(insert_rows(str(dump), "sites")) == []


def test_insert_rows_empty_file(tmp_path):
    dump = tmp_path / "dump.sql"
    dump.write_text("")
    assert list(insert_rows(str(dump), "sites")) == []


def test_insert_rows_target_after_large_volume_of_other_tables(tmp_path):
    """Adversarial shape matching the real dump: the target table's rows
    appear only after a large volume of unrelated tables' INSERT
    statements. Proves unrelated lines are never buffered (the fix for
    the O(n^2) bug) while correctness of what gets yielded is preserved."""
    dump = tmp_path / "dump.sql"
    filler = "INSERT INTO other_table (id) VALUES (1);\n" * 5000
    dump.write_text(
        filler + "INSERT INTO sites (id, name) VALUES (1, 'Alpha');\n"
    )
    rows = list(insert_rows(str(dump), "sites"))
    assert rows == [[1, "Alpha"]]


# ── slugify ─────────────────────────────────────────────────────────

def test_slugify_variants():
    assert slugify("Data Center") == "data_center"
    assert slugify("Client Office") == "client_office"
    assert slugify("  --Weird!! Label__ ") == "weird_label"


# ── split_address ───────────────────────────────────────────────────

def test_split_address_multiline():
    address = "100 Server Way\nSuite 200\nReno, NV 89501"
    line1, line2, note = split_address(address)
    assert line1 == "100 Server Way"
    assert line2 == "Suite 200"
    assert note == "V2 address (full): 100 Server Way / Suite 200 / Reno, NV 89501"


def test_split_address_single_line_still_has_note():
    line1, line2, note = split_address("100 Server Way")
    assert line1 == "100 Server Way"
    assert line2 is None
    assert note == "V2 address (full): 100 Server Way"


def test_split_address_none_or_blank():
    assert split_address(None) == (None, None, None)
    assert split_address("") == (None, None, None)
    assert split_address("   ") == (None, None, None)


def test_split_address_blank_second_line_becomes_none():
    address = "123 Main St\n \nSpringfield, IL"
    line1, line2, note = split_address(address)
    assert line1 == "123 Main St"
    assert line2 is None
    assert note == "V2 address (full): 123 Main St /  / Springfield, IL"


# ── parse_gps ───────────────────────────────────────────────────────

def test_parse_gps_valid():
    lat, lon, note = parse_gps("51.6431, -0.4280")
    assert lat == Decimal("51.6431")
    assert lon == Decimal("-0.4280")
    assert note is None


def test_parse_gps_none_or_blank():
    assert parse_gps(None) == (None, None, None)
    assert parse_gps("") == (None, None, None)
    assert parse_gps("   ") == (None, None, None)


def test_parse_gps_garbage():
    lat, lon, note = parse_gps("not gps data")
    assert lat is None and lon is None
    assert note == "V2 GPS: not gps data"


def test_parse_gps_only_one_number():
    lat, lon, note = parse_gps("51.6431")
    assert lat is None and lon is None
    assert note == "V2 GPS: 51.6431"


def test_parse_gps_out_of_range():
    lat, lon, note = parse_gps("200, 50")
    assert lat is None and lon is None
    assert note == "V2 GPS: 200, 50"


# ── summarize_metadata ──────────────────────────────────────────────

def test_summarize_metadata_extracts_dc_provider():
    metadata = '{"dc_provider": "Digital Realty", "access_type": "badge"}'
    dc_provider, note = summarize_metadata(metadata, None)
    assert dc_provider == "Digital Realty"
    assert note == "V2 survey: access_type=badge"


def test_summarize_metadata_combines_metadata_and_survey():
    metadata = '{"dc_provider": "Switch", "dock": "true"}'
    survey = '{"floor": 2, "notes": "ok"}'
    dc_provider, note = summarize_metadata(metadata, survey)
    assert dc_provider == "Switch"
    assert note == "V2 survey: dock=true; floor=2; notes=ok"


def test_summarize_metadata_ignores_null_placeholder():
    metadata = '{"dc_provider": "null", "dock": "null", "access_type": "badge"}'
    dc_provider, note = summarize_metadata(metadata, None)
    assert dc_provider is None
    assert note == "V2 survey: access_type=badge"


def test_summarize_metadata_none_inputs():
    assert summarize_metadata(None, None) == (None, None)


def test_summarize_metadata_invalid_json_treated_as_empty():
    assert summarize_metadata("not json", "also not json") == (None, None)


# ── format_locations_note ───────────────────────────────────────────

def test_format_locations_note_with_and_without_description():
    note = format_locations_note([("Rack Room", "ground floor"), ("Loading Dock", "")])
    assert note == "V2 locations: Rack Room (ground floor), Loading Dock"


def test_format_locations_note_empty():
    assert format_locations_note([]) is None


# ── assemble_notes ──────────────────────────────────────────────────

def test_assemble_notes_filters_blanks():
    assert assemble_notes(["a", None, "", "b", "   "]) == "a\nb"


def test_assemble_notes_all_blank_returns_none():
    assert assemble_notes([None, "", "   "]) is None
