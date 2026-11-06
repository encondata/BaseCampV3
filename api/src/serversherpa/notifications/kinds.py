"""The single registry of notification kinds. Every kind `notify()` is
called with, and every kind `announce()` (notifications/events.py) raises
an event of, is listed here with its category and email flags; a kind that
is not listed stays inbox-only (never emailed). The portal mirrors the
categories in portal/src/lib/notificationKinds.ts.

Spec: docs/superpowers/specs/2026-10-08-notification-email-design.md"""

from dataclasses import dataclass


@dataclass(frozen=True)
class KindInfo:
    category: str          # a key of CATEGORIES
    label: str             # "Report ready"
    brief: bool = False    # email carries title + link only, never the body
    email: bool = True     # False = never emailed
    owner_always: bool = False  # owner copies always email (decision 3)
    # The kinds of thing whose watchers hear this one, in the order the portal lists
    # them ("initiative", "site", "truck"). Empty = nobody can watch for it.
    reaches: tuple[str, ...] = ()
    # Whether an Everything watch may name this kind (it needs no thing to point at).
    everywhere: bool = False

    @property
    def watchable(self) -> bool:
        return bool(self.reaches)


# Ordered: the order here is the order the portal shows.
CATEGORIES: dict[str, str] = {
    "approvals": "Approvals & requests",
    "reports": "Reports & labels",
    "wiki": "Wiki",
    "learning": "Learning",
    "initiatives": "Initiatives",
    "assets": "Assets",
    "plans": "Project plans",
    "trucks": "Trucks",
    "devices": "Devices",
    "status_rules": "Status rules",
    "bulk_actions": "Bulk actions",
    "security": "Account security",
}

CATEGORY_KEYS: tuple[str, ...] = tuple(CATEGORIES)

KINDS: dict[str, KindInfo] = {
    "membership_request": KindInfo("approvals", "Group membership request"),
    "membership_decided": KindInfo("approvals", "Group membership decision"),
    "router_approval": KindInfo("approvals", "Router waiting for approval", brief=True),
    # Exists only when email is off, so it is never emailed.
    "password_reset_request": KindInfo("approvals", "Password reset request", email=False),
    "report_ready": KindInfo("reports", "Report ready"),
    # Failure kinds carry internal error text: title + link only.
    "report_failed": KindInfo("reports", "Report failed", brief=True),
    "labels_ready": KindInfo("reports", "Labels ready"),
    "labels_failed": KindInfo("reports", "Label generation failed",
                              brief=True),
    "wiki_update": KindInfo("wiki", "Page updated"),
    "wiki_comment": KindInfo("wiki", "New comment"),
    "wiki_mention": KindInfo("wiki", "You were mentioned"),
    "wiki_review_request": KindInfo("wiki", "Review requested"),
    "wiki_review_decision": KindInfo("wiki", "Review decided"),
    "wiki_review_due": KindInfo("wiki", "Review due"),
    "wiki_export_ready": KindInfo("wiki", "Export ready"),
    "wiki_export_failed": KindInfo("wiki", "Export failed"),
    "learning_complete": KindInfo("learning", "Learning complete"),
    "learning_overdue": KindInfo("learning", "Learning overdue"),
    # A worker used every quiz attempt; a lead follows up in person.
    "learning_quiz_locked": KindInfo("learning", "Quiz locked", email=False),
    # Announced (notifications/events.py), not sent with notify(): a status change
    # reaches everyone watching the thing, or the things above and around it.
    "initiative_status_changed": KindInfo("initiatives", "Initiative status changed",
                                          reaches=("initiative", "site"), everywhere=True),
    # Sent with notify() by the asset-watch check (notifications/asset_watch_check.py) to the
    # person who set the watch, once, when what it waits for happens; then the watch ends. Not
    # announced and not watchable: an asset watch is its person's own, and the category's
    # switches are the way out.
    "asset_watch": KindInfo("assets", "Asset watch"),
    # Project plan messages are personal and reach people with no portal login,
    # so plans/notices.py emails the person directly through the mail outbox;
    # email=False keeps notify() from sending a second copy. It also keeps the
    # inbox row when the category's Inbox switch is off, so notices.py reads
    # the person's switches itself before calling notify().
    "plan_task_assigned": KindInfo("plans", "Assigned to a plan task", email=False),
    "plan_task_due": KindInfo("plans", "Plan task due", email=False),
    "plan_task_overdue": KindInfo("plans", "Plan task overdue", email=False),
    "plan_overdue_digest": KindInfo("plans", "Overdue plan tasks", email=False),
    "truck_status_changed": KindInfo("trucks", "Truck status changed",
                                     reaches=("truck", "initiative", "site"), everywhere=True),
    # Announced by the device check (notifications/device_check.py) when a covered device
    # stops checking in: it reaches the device's watchers, its site's and its move's.
    "device_offline": KindInfo("devices", "Device offline",
                               reaches=("device", "site", "initiative"), everywhere=True),
    # Announced by a status rule's Notify action (status_rules/notify.py): one event per rule
    # and initiative in a transaction (a match with no initiative is one of its own). It
    # reaches the people and groups the rule names and, with the rule's "watchers" on, the
    # watchers of its initiative (and the ones above it) and of the scan's site. Never
    # everywhere: a rule's notice is about its own initiative.
    "status_rule_matched": KindInfo("status_rules", "Status rule matched",
                                    reaches=("initiative", "site")),
    # Sent with notify() by the import worker (imports/notices.py) to the person who committed
    # a job that wrote data, and to its uploader when that's someone else, when it finishes or
    # fails. Not announced and not watchable: it reaches only those people, and the category's
    # switches are the way out. The failed notice is title + link only (brief, enforced here
    # like the other failure kinds), since the error text behind it is internal.
    "bulk_action_finished": KindInfo("bulk_actions", "Bulk action finished"),
    "bulk_action_failed": KindInfo("bulk_actions", "Bulk action failed", brief=True),
    "password_expiring": KindInfo("security", "Password expiring", owner_always=True),
    "totp_enrolled": KindInfo("security", "Two-factor authentication enrolled",
                               brief=True, owner_always=True),
}


def kind_info(kind: str) -> KindInfo | None:
    return KINDS.get(kind)
