"""Pure parsing/mapping helpers of the V2 workers-dump importer."""

from serversherpa.people.v2_import import (
    is_worker, people_rows, trade_of, worker_notes, worker_status,
)


def _row(**over):
    base = {
        "id": 42, "first_name": "Ada", "last_name": "Lovelace",
        "display_name": "", "email_address": "ada@example.com",
        "phone_number": "+1 555 0100", "user_type": '{"worker": true}',
        "people_status": 27, "w_rating": None, "w_locations_available": None,
        "w_resource_partner": None, "w_work_type": None,
        "w_available_to_travel": None, "w_available_international_travel": None,
    }
    base.update(over)
    return base


# ── is_worker ───────────────────────────────────────────────────────

def test_is_worker_true_flag():
    assert is_worker(_row()) is True


def test_is_worker_user_plus_worker():
    assert is_worker(_row(user_type='{"user": true, "worker": true}')) is True


def test_is_worker_false_flag_and_non_worker_types():
    assert is_worker(_row(user_type='{"user": true, "worker": false}')) is False
    assert is_worker(_row(user_type='{"client": true}')) is False
    assert is_worker(_row(user_type=None)) is False
    assert is_worker(_row(user_type="not json")) is False


# ── trade_of ────────────────────────────────────────────────────────

def test_trade_of_normalizes_and_dedupes_flag_keys():
    row = _row(w_work_type='{"cable": true, "Cable": true, '
                           '"project_manager": true, "Hardware": false}')
    assert trade_of(row) == "Cable, Project Manager"


def test_trade_of_empty_and_null():
    assert trade_of(_row(w_work_type="{}")) is None
    assert trade_of(_row(w_work_type=None)) is None
    assert trade_of(_row(w_work_type="broken{")) is None


# ── worker_status ───────────────────────────────────────────────────

def test_worker_status_active():
    assert worker_status(_row(people_status=27)) == ("active", None, False)


def test_worker_status_blacklisted():
    assert worker_status(_row(people_status=30)) == (
        "blacklist", "V2 status: Blacklisted", False)


def test_worker_status_deleted_imports_archived():
    assert worker_status(_row(people_status=31)) == (
        "standby", "V2 status: Deleted", True)


def test_worker_status_unknown_defaults_active_with_note():
    assert worker_status(_row(people_status=99)) == (
        "active", "V2 status: unknown (99)", False)
    assert worker_status(_row(people_status=None)) == ("active", None, False)


# ── worker_notes ────────────────────────────────────────────────────

def test_worker_notes_collects_leftovers_and_history():
    row = _row(w_rating=3.5, w_locations_available="Vegas",
               w_available_to_travel=1, w_available_international_travel=None)
    assocs = [{"entity_type": "Project", "entity_id": 3,
               "work_type": "Project Manager",
               "site_worked": "NAP11 - Switch", "rating": 4}]
    notes = worker_notes(row, assocs, partner_note="V2 partner #9 not in dump")
    assert "V2 rating: 3.5" in notes
    assert "V2 locations available: Vegas" in notes
    assert "V2 available to travel: yes" in notes
    assert "V2 partner #9 not in dump" in notes
    assert "V2 work: Project #3 — Project Manager @ NAP11 - Switch (rating 4)" \
        in notes


def test_worker_notes_empty_when_nothing_to_say():
    assert worker_notes(_row(), [], None) is None


# ── people_rows (uses a tiny synthetic dump) ────────────────────────

def test_people_rows_yields_dicts_and_skips_malformed(tmp_path):
    from serversherpa.people.v2_import import PEOPLE_COLS
    good = ", ".join(["1", "'A'", "'B'"] + ["NULL"] * (len(PEOPLE_COLS) - 3))
    dump = tmp_path / "d.sql"
    dump.write_text(
        f"INSERT INTO people ({', '.join(PEOPLE_COLS)}) VALUES ({good});\n"
        "INSERT INTO people (id) VALUES (2);\n"          # malformed: too short
        "INSERT INTO people_timeclock (id) VALUES (3);\n"  # other table
    )
    rows = list(people_rows(str(dump)))
    assert len(rows) == 1
    assert rows[0]["id"] == 1
    assert rows[0]["first_name"] == "A"
