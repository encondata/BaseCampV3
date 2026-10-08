"""The single registry of notification kinds. Every kind `notify()` is
called with is listed here with its category and email flags; a kind that
is not listed stays inbox-only (never emailed). The portal mirrors the
categories in portal/src/lib/notificationKinds.ts.

Spec: docs/superpowers/specs/2026-10-08-notification-email-design.md"""

from dataclasses import dataclass


@dataclass(frozen=True)
class KindInfo:
    category: str          # "approvals" | "reports" | "wiki" | "security"
    label: str             # "Report ready"
    brief: bool = False    # email carries title + link only, never the body
    email: bool = True     # False = never emailed
    owner_always: bool = False  # owner copies always email (decision 3)
    urgent: bool = False   # counts for a group's urgent_bypass


# Ordered: the order here is the order the portal shows.
CATEGORIES: dict[str, str] = {
    "approvals": "Approvals & requests",
    "reports": "Reports & labels",
    "wiki": "Wiki",
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
    "password_expiring": KindInfo("security", "Password expiring",
                                   owner_always=True, urgent=True),
    "totp_enrolled": KindInfo("security", "Two-factor authentication enrolled",
                               brief=True, owner_always=True, urgent=True),
}


def kind_info(kind: str) -> KindInfo | None:
    return KINDS.get(kind)
