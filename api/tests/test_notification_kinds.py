"""notifications/kinds.py: the registry, and a scan proving every kind the
codebase passes to notify() is registered (an unregistered kind would be
silently inbox-only)."""

import re
from pathlib import Path

from serversherpa.notifications.kinds import (
    CATEGORIES, CATEGORY_KEYS, KINDS, KindInfo, kind_info,
)

SRC = Path(__file__).resolve().parents[1] / "src" / "serversherpa"


def test_categories_order_and_labels():
    assert list(CATEGORIES.items()) == [
        ("approvals", "Approvals & requests"),
        ("reports", "Reports & labels"),
        ("wiki", "Wiki"),
        ("security", "Account security"),
    ]
    assert CATEGORY_KEYS == ("approvals", "reports", "wiki", "security")


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
        "password_expiring": "security", "totp_enrolled": "security",
    }
    assert {k: v.category for k, v in KINDS.items()} == expected


def test_flags_match_the_spec():
    default = KindInfo("approvals", "x")
    assert (default.brief, default.email, default.owner_always, default.urgent) == (
        False, True, False, False)
    flagged = {k: (v.brief, v.email, v.owner_always, v.urgent) for k, v in KINDS.items()
               if (v.brief, v.email, v.owner_always, v.urgent) != (False, True, False, False)}
    assert flagged == {
        "router_approval": (True, True, False, False),
        "report_failed": (True, True, False, False),
        "labels_failed": (True, True, False, False),
        "password_reset_request": (False, False, False, False),
        "password_expiring": (False, True, True, True),
        "totp_enrolled": (True, True, True, True),
    }


def test_kind_info_unknown_is_none():
    assert kind_info("nope") is None
    assert kind_info("report_ready") is KINDS["report_ready"]


# notify(db, person, "literal", ...) — the kind is the third positional argument
NOTIFY_CALL = re.compile(r"""\bnotify\(\s*[\w.]+\s*,\s*[\w.\[\]]+\s*,\s*["']([a-z_]+)["']""")
# wiki/notify.py and wiki/worker.py: kind="wiki_x" keyword arguments and wiki/worker.py `kind, event = "wiki_x", ...`
WIKI_KIND = re.compile(r"""\bkind\s*=\s*["']([a-z_]+)["']|\bkind\s*,\s*event\s*=\s*["']([a-z_]+)["']""")
KIND_CONST = re.compile(r"""^KIND\s*=\s*["']([a-z_]+)["']""", re.MULTILINE)


def _scan() -> set[str]:
    found: set[str] = set()
    for path in SRC.rglob("*.py"):
        text = path.read_text()
        found.update(NOTIFY_CALL.findall(text))
        if "notifications/reset_requests.py" in path.as_posix() or \
           "notifications/password_reminders.py" in path.as_posix():
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
            "wiki_comment", "wiki_export_ready"} <= found
    assert found == set(KINDS), (
        f"unregistered: {sorted(found - set(KINDS))}; never sent: {sorted(set(KINDS) - found)}")
