"""notifications/kinds.py: the registry, and a scan proving every kind the
codebase passes to notify() is registered (an unregistered kind would be
silently inbox-only)."""

import re
from pathlib import Path

from serversherpa.notifications.kinds import CATEGORIES, CATEGORY_KEYS, KINDS, KindInfo, kind_info

SRC = Path(__file__).resolve().parents[1] / "src" / "serversherpa"


def test_categories_order_and_labels():
    assert list(CATEGORIES.items()) == [
        ("approvals", "Approvals & requests"),
        ("reports", "Reports & labels"),
        ("wiki", "Wiki"),
        ("learning", "Learning"),
        ("initiatives", "Initiatives"),
        ("trucks", "Trucks"),
        ("devices", "Devices"),
        ("security", "Account security"),
    ]
    assert CATEGORY_KEYS == ("approvals", "reports", "wiki", "learning", "initiatives",
                             "trucks", "devices", "security")


def test_every_kind_has_a_known_category_and_a_label():
    for kind, info in KINDS.items():
        assert info.category in CATEGORIES, kind
        assert info.label, kind


def test_kind_table_matches_the_spec():
    expected = {
        "membership_request": "approvals", "membership_decided": "approvals",
        "router_approval": "approvals", "password_reset_request": "approvals",
        "report_ready": "reports", "report_failed": "reports",
        "labels_ready": "reports", "labels_failed": "reports",
        "wiki_update": "wiki", "wiki_comment": "wiki", "wiki_mention": "wiki",
        "wiki_review_request": "wiki", "wiki_review_decision": "wiki",
        "wiki_review_due": "wiki", "wiki_export_ready": "wiki",
        "wiki_export_failed": "wiki",
        "learning_complete": "learning", "learning_overdue": "learning",
        "learning_quiz_locked": "learning",
        "initiative_status_changed": "initiatives", "truck_status_changed": "trucks",
        "device_offline": "devices",
        "password_expiring": "security", "totp_enrolled": "security",
    }
    assert {k: v.category for k, v in KINDS.items()} == expected
    # registry order is the order the portal shows: the new kinds follow learning
    assert list(KINDS)[-5:] == ["initiative_status_changed", "truck_status_changed",
                                "device_offline", "password_expiring", "totp_enrolled"]
    assert (KINDS["initiative_status_changed"].label, KINDS["truck_status_changed"].label,
            KINDS["device_offline"].label) == (
        "Initiative status changed", "Truck status changed", "Device offline")


def test_flags_match_the_spec():
    default = KindInfo("approvals", "x")
    assert (default.brief, default.email, default.owner_always) == (False, True, False)
    flagged = {k: (v.brief, v.email, v.owner_always) for k, v in KINDS.items()
               if (v.brief, v.email, v.owner_always) != (False, True, False)}
    assert flagged == {
        "router_approval": (True, True, False),
        "report_failed": (True, True, False),
        "labels_failed": (True, True, False),
        "password_reset_request": (False, False, False),
        "learning_quiz_locked": (False, False, False),
        "password_expiring": (False, True, True),
        "totp_enrolled": (True, True, True),
    }
    # the announced kinds are emailed in full, to whoever hears them, like the defaults
    for kind in ("initiative_status_changed", "truck_status_changed", "device_offline"):
        assert (KINDS[kind].brief, KINDS[kind].email, KINDS[kind].owner_always) == (
            False, True, False), kind
    # the urgent flag is gone: critical is company-set (notifications/company.py)
    assert not hasattr(default, "urgent")


def test_reaches_and_everywhere():
    """Which kinds a watch can follow, on what, and which an Everything watch may name:
    exactly the two status changes and Device offline."""
    assert {kind: (info.reaches, info.everywhere) for kind, info in KINDS.items()
            if info.reaches or info.everywhere} == {
        "initiative_status_changed": (("initiative", "site"), True),
        "truck_status_changed": (("truck", "initiative", "site"), True),
        "device_offline": (("device", "site", "initiative"), True),
    }
    assert {kind for kind, info in KINDS.items() if info.watchable} == {
        "initiative_status_changed", "truck_status_changed", "device_offline"}
    assert KINDS["truck_status_changed"].watchable is True
    assert KINDS["report_ready"].watchable is False
    # the defaults: not watchable, not named by an Everything watch
    default = KindInfo("approvals", "x")
    assert (default.reaches, default.everywhere, default.watchable) == ((), False, False)


def test_kind_info_unknown_is_none():
    assert kind_info("nope") is None
    assert kind_info("report_ready") is KINDS["report_ready"]


def test_no_two_kinds_share_a_kind_info():
    """Every kind's KindInfo is distinct, so a KindInfo names exactly one kind:
    email._kind_name() looks a kind's name up from it."""
    assert len(set(KINDS.values())) == len(KINDS)


# notify(db, person, "literal", ...) — the kind is the third positional argument
NOTIFY_CALL = re.compile(r"""\bnotify\(\s*[\w.]+\s*,\s*[\w.\[\]]+\s*,\s*["']([a-z_]+)["']""")
# wiki/notify.py and wiki/worker.py: kind="wiki_x" keyword arguments and wiki/worker.py `kind, event = "wiki_x", ...`
WIKI_KIND = re.compile(r"""\bkind\s*=\s*["']([a-z_]+)["']|\bkind\s*,\s*event\s*=\s*["']([a-z_]+)["']""")
KIND_CONST = re.compile(r"""^KIND\s*=\s*["']([a-z_]+)["']""", re.MULTILINE)
# announce(db, "literal", ...) — the kind is the second positional argument
ANNOUNCE_CALL = re.compile(r"""\bannounce\(\s*[\w.]+\s*,\s*["']([a-z_]+)["']""")
# the modules that name their kind in a module-level KIND constant
KIND_CONST_FILES = ("notifications/reset_requests.py", "notifications/password_reminders.py",
                    "learning/scheduler.py")


def _scan() -> set[str]:
    found: set[str] = set()
    for path in SRC.rglob("*.py"):
        text = path.read_text()
        found.update(NOTIFY_CALL.findall(text))
        found.update(ANNOUNCE_CALL.findall(text))
        if path.as_posix().endswith(KIND_CONST_FILES):
            found.update(KIND_CONST.findall(text))
        if path.as_posix().endswith(("wiki/notify.py", "wiki/worker.py")):
            for a, b in WIKI_KIND.findall(text):
                found.add(a or b)
    return found


def test_every_notify_kind_in_the_codebase_is_registered():
    found = _scan()
    assert found, "scan found no notify() kinds; the regexes are stale"
    # the scan reaches each place kinds are written
    assert {"report_ready", "labels_failed", "membership_request", "router_approval",
            "totp_enrolled", "password_reset_request", "password_expiring",
            "wiki_comment", "wiki_export_ready", "learning_overdue", "learning_complete",
            "learning_quiz_locked", "initiative_status_changed", "truck_status_changed",
            "device_offline"} <= found
    assert found == set(KINDS), (
        f"unregistered: {sorted(found - set(KINDS))}; never sent: {sorted(set(KINDS) - found)}")
