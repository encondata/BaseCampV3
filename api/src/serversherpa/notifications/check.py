"""Check delivery: what would happen right now if one person got a
notification of one registered kind, without writing anything. The email
answer is decide_email(), the same decision maybe_email() acts on, so the
tool and the sender cannot drift; the inbox answer is notify()'s rule, read
off the same effective switches. Beside them it shows the person's switches
for the category and where each comes from, their schedule and its state
right now, whether the kind is critical, and for a kind anyone can watch the
watches of the person that would hear it.

A project plan notice (category `plans`) is answered with the plans' own rule
instead (plans/notices.py `delivery`): plans email the person directly, so
notify() and decide_email() play no part in it.

Spec: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md (section 9) and
docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (section 7)"""

import uuid
from datetime import datetime, time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Person, UserAccount
from serversherpa.mail.outbox import email_enabled
from serversherpa.notifications.company import (
    CompanySettings,
    is_critical,
    load_company_settings,
)
from serversherpa.notifications.email import (
    Contact,
    EffectiveSwitches,
    contact_schedule,
    decide_email,
    effective_switches,
    load_contact,
)
from serversherpa.notifications.kinds import KINDS, KindInfo
from serversherpa.notifications.schedule import DAYS, state_at
from serversherpa.notifications.watches import WatchView, watches_hearing
from serversherpa.plans.notices import delivery as plan_delivery

# project plan notices follow the plans' own delivery rule (plans/notices.py)
PLANS_CATEGORY = "plans"


def _clock(value: time | None) -> str | None:
    """A quiet-hours bound as "HH:MM", as the preference stores it."""
    return value.strftime("%H:%M") if value is not None else None


def _watch_entry(view: WatchView) -> dict:
    """A watch as Check delivery lists it: what it is on (`thing` is "everything" for an
    Everything watch, which has no id or name), the events it names (empty: every one that
    applies) and whose it is: `you` for the person's own, else the group."""
    group = view.group
    via = ({"type": "you", "id": None, "name": None} if group is None
           else {"type": "group", "id": group.id, "name": group.name})
    return {"thing": view.thing, "thing_id": view.thing_id, "thing_name": view.thing_name,
            "kinds": list(view.watch.kinds), "via": via}


async def check_delivery(db: AsyncSession, person_id: uuid.UUID, kind: str, *,
                         owner_copy: bool | None = None, now: datetime) -> dict:
    """The DeliveryCheckOut fields for this person and kind at `now` (aware).
    `kind` must be registered and the person must exist: the route answers
    422 and 404 before calling. For a kind the account owner always receives
    (owner_always), the owner's own copy is modeled unless `owner_copy` is
    False, which asks for an admin's copy (that one stays in the inbox).
    `outcome` is now, held (until `summary_at`) or not_sent (`reason` says
    why; for a held email, the schedule state that holds it), or for a
    project plan notice `direct`. `inbox_reason` says why the inbox row is
    not written.
    `after_summary` marks an email sent now only because it falls in the
    last hour before the person is back online, when that morning's summary
    has already gone. `watches` is None for a kind nobody can watch; for one
    anyone can, every watch of the person that would hear it, whether or not
    they can open its thing (watches.watches_hearing). Reads only."""
    info = KINDS[kind]
    person = await db.get(Person, person_id)
    has_account = await db.scalar(select(UserAccount.person_id).where(
        UserAccount.person_id == person_id)) is not None
    contact = await load_contact(db, person_id)
    company = await load_company_settings(db)
    switches = effective_switches(info, contact, company)
    owner_notice = info.owner_always and owner_copy is not False
    if info.category == PLANS_CATEGORY:
        answer = _plan_answer(info, contact, company)
    else:
        answer = await _notify_answer(db, person_id, info, switches, owner_notice=owner_notice,
                                      contact=contact, company=company, now=now)
    schedule = contact_schedule(contact)
    watches = ([_watch_entry(view) for view in await watches_hearing(db, person_id, kind)]
               if info.watchable else None)
    return {
        "person_id": person_id,
        "person_name": person.display_name,
        "kind": kind,
        "kind_label": info.label,
        "category": info.category,
        "owner_copy": owner_notice,
        "active": contact is not None and contact.active,
        "has_account": has_account,
        "inbox_source": switches.inbox_source,
        "email_enabled": email_enabled(),
        "critical": is_critical(kind, company),
        "switches": {
            "inbox": {"on": switches.inbox, "source": switches.inbox_source},
            "email": {"on": switches.email, "source": switches.email_source},
        },
        "schedule": {
            "timezone": schedule.zone.key,
            "days": [day for day in DAYS if day in schedule.days],
            "quiet_start": _clock(schedule.quiet_start),
            "quiet_end": _clock(schedule.quiet_end),
            "state": state_at(schedule, now),
        },
        **answer,
        "watches": watches,
    }


async def _notify_answer(db: AsyncSession, person_id: uuid.UUID, info: KindInfo,
                         switches: EffectiveSwitches, *, owner_notice: bool,
                         contact: Contact | None, company: CompanySettings,
                         now: datetime) -> dict:
    """The inbox and email answer for a notification sent with notify()."""
    decision = await decide_email(db, person_id, info, owner_notice=owner_notice,
                                  contact=contact, company=company, now=now)
    if decision.queue:
        outcome = "now"
    elif decision.hold:
        outcome = "held"
    else:
        outcome = "not_sent"
    # notify()'s rule: an Inbox switched off drops the inbox row too,
    # except for a kind that is never emailed
    inbox_reason = "category_off" if not switches.inbox and info.email else None
    return {
        "inbox": "suppressed" if inbox_reason else "written",
        "inbox_reason": inbox_reason,
        "outcome": outcome,
        "after_summary": decision.after_summary,
        "send_at": decision.send_at,
        "summary_at": decision.summary_at,
        "reason": decision.reason,
        "address": decision.address,
        "address_source": decision.address_source,
    }


def _plan_answer(info: KindInfo, contact: Contact | None, company: CompanySettings) -> dict:
    """The inbox and email answer for a project plan notice, by the rule its
    sender acts on (plans/notices.py `delivery`). Its email is `direct`: it goes
    when the plan sends it (a reminder at the plan's send time, an assignment
    notice when it is made), and the person's schedule never holds it. A plan
    can also turn emailing assignees off; that is one plan's setting, so it is
    not part of this answer."""
    rule = plan_delivery(info, contact, company, email=True)
    reason = "email_not_set_up" if not email_enabled() else rule.email_reason
    return {
        "inbox": "written" if rule.inbox else "suppressed",
        "inbox_reason": rule.inbox_reason,
        "outcome": "not_sent" if reason else "direct",
        "after_summary": False,
        "send_at": None,
        "summary_at": None,
        "reason": reason,
        "address": None if reason else rule.address,
        "address_source": None if reason else rule.address_source,
    }
