"""Company notification settings as a frozen value, and the critical rule.

Two things an admin sets for everyone (System › Notifications › Defaults),
stored in the system_config `notifications` section: the Inbox and Email
switches a person follows until they change their own, and the notification
types marked critical. The route in api/routes/notifications.py is the only
writer. Whatever the row holds, `load_company_settings` answers with every
configurable category set, so a caller never has to guess.

A kind is critical when it is account security (always, in code, never
stored) or an admin listed it. A critical email skips holding, but still
obeys the person's switches.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (sections 2 and 5)"""

from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.notifications.kinds import kind_info
from serversherpa.system.config_store import read_section

SECTION = "notifications"

# The categories an admin sets a default for. Account security is left out:
# the owner's own notices are always written and always emailed, so there is
# nothing to set. (config_store.DEFAULTS spells the same seven out.)
CONFIGURABLE_CATEGORIES: tuple[str, ...] = ("approvals", "reports", "wiki", "learning",
                                            "initiatives", "trucks", "devices")

SECURITY_CATEGORY = "security"


@dataclass(frozen=True)
class Switches:
    """One category's Inbox and Email switches."""
    inbox: bool
    email: bool


@dataclass(frozen=True)
class CompanySettings:
    """`defaults` holds a Switches for each configurable category; `critical_kinds`
    only the kinds an admin marked (the security kinds are critical without it)."""
    defaults: Mapping[str, Switches]
    critical_kinds: frozenset[str]


def _switches(stored: object) -> Switches:
    """A stored pair as Switches. Anything but a pair of real booleans (a
    wrong type, half a pair) is malformed and reads as on/on, the out-of-the-box
    default, never as a half-guess."""
    if isinstance(stored, dict):
        inbox, email = stored.get("inbox"), stored.get("email")
        if isinstance(inbox, bool) and isinstance(email, bool):
            return Switches(inbox, email)
    return Switches(True, True)


async def load_company_settings(db: AsyncSession) -> CompanySettings:
    """The saved company settings. A category that is missing or malformed is
    on/on; categories and kinds this code does not know, and kinds that can
    never be critical, are ignored (the PUT refuses them, so only a hand-edited
    row can hold one, and it must not break notify())."""
    data = await read_section(db, SECTION)
    stored = data.get("defaults")
    if not isinstance(stored, dict):
        stored = {}
    marked = data.get("critical_kinds")
    if not isinstance(marked, list):
        marked = []
    return CompanySettings(
        defaults={category: _switches(stored.get(category))
                  for category in CONFIGURABLE_CATEGORIES},
        critical_kinds=frozenset(kind for kind in marked
                                 if isinstance(kind, str) and critical_eligible(kind)))


def critical_eligible(kind: str) -> bool:
    """Whether an admin may mark this kind critical: it is registered, it is
    ever emailed (a critical notification is about skipping the wait for
    email), and it is not account security (always critical already)."""
    info = kind_info(kind)
    return info is not None and info.email and info.category != SECURITY_CATEGORY


def is_critical(kind: str, company: CompanySettings) -> bool:
    """Whether a notification of this kind skips quiet hours, days off and the
    summary. Account security always does; any other kind only when an admin
    marked it and it can be marked."""
    info = kind_info(kind)
    if info is None:
        return False
    if info.category == SECURITY_CATEGORY:
        return True
    return kind in company.critical_kinds and critical_eligible(kind)
