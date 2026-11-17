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
        ("assets", "Assets"),
        ("plans", "Project plans"),
        ("trucks", "Trucks"),
        ("devices", "Devices"),
        ("status_rules", "Status rules"),
        ("bulk_actions", "Bulk actions"),
        ("security", "Account security"),
    ]
    assert CATEGORY_KEYS == ("approvals", "reports", "wiki", "learning", "initiatives",
                             "assets", "plans", "trucks", "devices", "status_rules",
                             "bulk_actions", "security")


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
        "initiative_status_changed": "initiatives",
        "asset_watch": "assets",
        "plan_task_assigned": "plans", "plan_task_due": "plans",
        "plan_task_overdue": "plans", "plan_overdue_digest": "plans",
        "truck_status_changed": "trucks",
        "device_offline": "devices", "status_rule_matched": "status_rules",
        "bulk_action_finished": "bulk_actions", "bulk_action_failed": "bulk_actions",
        "password_expiring": "security", "totp_enrolled": "security",
        "address_blocked": "security",
    }
    assert {k: v.category for k, v in KINDS.items()} == expected
    # registry order is the order the portal shows: the new kinds follow learning, the asset
    # watch and the plan kinds beside the initiative's own
    assert list(KINDS)[-14:] == ["initiative_status_changed", "asset_watch",
                                 "plan_task_assigned", "plan_task_due", "plan_task_overdue",
                                 "plan_overdue_digest", "truck_status_changed", "device_offline",
                                 "status_rule_matched", "bulk_action_finished",
                                 "bulk_action_failed", "password_expiring", "totp_enrolled",
                                 "address_blocked"]
    assert (KINDS["initiative_status_changed"].label, KINDS["truck_status_changed"].label,
            KINDS["device_offline"].label) == (
        "Initiative status changed", "Truck status changed", "Device offline")
    assert (KINDS["bulk_action_finished"].label, KINDS["bulk_action_failed"].label) == (
        "Bulk action finished", "Bulk action failed")
    assert KINDS["status_rule_matched"].label == "Status rule matched"
    assert KINDS["asset_watch"].label == "Asset watch"
    assert {k: v.label for k, v in KINDS.items() if v.category == "plans"} == {
        "plan_task_assigned": "Assigned to a plan task",
        "plan_task_due": "Plan task due",
        "plan_task_overdue": "Plan task overdue",
        "plan_overdue_digest": "Overdue plan tasks",
    }


def test_flags_match_the_spec():
    default = KindInfo("approvals", "x")
    assert (default.brief, default.email, default.owner_always) == (False, True, False)
    flagged = {k: (v.brief, v.email, v.owner_always) for k, v in KINDS.items()
               if (v.brief, v.email, v.owner_always) != (False, True, False)}
    assert flagged == {
        "router_approval": (True, True, False),
        "report_failed": (True, True, False),
        "labels_failed": (True, True, False),
        "bulk_action_failed": (True, True, False),
        "password_reset_request": (False, False, False),
        "learning_quiz_locked": (False, False, False),
        # plans/notices.py emails the person directly through the mail outbox
        "plan_task_assigned": (False, False, False),
        "plan_task_due": (False, False, False),
        "plan_task_overdue": (False, False, False),
        "plan_overdue_digest": (False, False, False),
        "password_expiring": (False, True, True),
        "totp_enrolled": (True, True, True),
        "address_blocked": (False, False, False),
    }
    # the announced kinds are emailed in full, to whoever hears them, like the defaults
    for kind in ("initiative_status_changed", "truck_status_changed", "device_offline",
                 "status_rule_matched"):
        assert (KINDS[kind].brief, KINDS[kind].email, KINDS[kind].owner_always) == (
            False, True, False), kind
    # so is the bulk action finished notice; the failed one is title + link only, like the
    # other failure kinds (the error text behind it is internal), and the registry enforces it
    assert (KINDS["bulk_action_finished"].brief, KINDS["bulk_action_finished"].email,
            KINDS["bulk_action_finished"].owner_always) == (False, True, False)
    assert (KINDS["bulk_action_failed"].brief, KINDS["bulk_action_failed"].email,
            KINDS["bulk_action_failed"].owner_always) == (True, True, False)
    # the urgent flag is gone: critical is company-set (notifications/company.py)
    assert not hasattr(default, "urgent")


def test_reaches_and_everywhere():
    """Which kinds a watch can follow, and on what: the two status changes, Device offline
    and Status rule matched. An Everything watch may name the first three: a status rule's
    notice reaches only the rule's initiative and the scan's site, never everywhere."""
    assert {kind: (info.reaches, info.everywhere) for kind, info in KINDS.items()
            if info.reaches or info.everywhere} == {
        "initiative_status_changed": (("initiative", "site"), True),
        "truck_status_changed": (("truck", "initiative", "site"), True),
        "device_offline": (("device", "site", "initiative"), True),
        "status_rule_matched": (("initiative", "site"), False),
    }
    assert {kind for kind, info in KINDS.items() if info.watchable} == {
        "initiative_status_changed", "truck_status_changed", "device_offline",
        "status_rule_matched"}
    assert KINDS["truck_status_changed"].watchable is True
    assert KINDS["report_ready"].watchable is False
    # sent straight to whoever started the job (imports/notices.py), or to whoever set the
    # asset watch (notifications/asset_watch_check.py): nothing to watch
    for kind in ("bulk_action_finished", "bulk_action_failed", "asset_watch"):
        assert (KINDS[kind].reaches, KINDS[kind].everywhere, KINDS[kind].watchable) == (
            (), False, False), kind
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
KIND_CONST = re.compile(r"""^KIND(?:_[A-Z]+)?\s*=\s*["']([a-z_]+)["']""", re.MULTILINE)
# announce(db, "literal", ...) — the kind is the second positional argument
ANNOUNCE_CALL = re.compile(r"""\bannounce\(\s*[\w.]+\s*,\s*["']([a-z_]+)["']""")
# the modules that name their kinds in module-level KIND / KIND_<X> constants
KIND_CONST_FILES = ("notifications/reset_requests.py", "notifications/address_blocks.py", "notifications/password_reminders.py",
                    "learning/scheduler.py", "plans/reminders.py", "plans/notices.py",
                    "imports/notices.py")


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
            "device_offline", "status_rule_matched", "bulk_action_finished",
            "bulk_action_failed", "asset_watch"} <= found
    assert found == set(KINDS), (
        f"unregistered: {sorted(found - set(KINDS))}; never sent: {sorted(set(KINDS) - found)}")
