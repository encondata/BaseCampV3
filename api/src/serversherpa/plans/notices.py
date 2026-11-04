"""Telling people about plan tasks: the delivery rule every plan message
follows (`reach`, `send`) and the assignment notice the ops route sends
(`assignment_notices`). The reminder sweep (plans/reminders.py) sends
through the same two functions.

Delivery (spec "Due dates and reminders", *Delivery*). A plan message is
personal, so it never goes through a notification group's subscription:

- a person with a portal account gets the inbox row: `notify()`, with the
  plan kinds registered `email=False`, so notify() sends no email of its own;
- the direct email goes through the mail outbox to the person's contact
  email (else their login email: `learning.emails.address_for`'s rule), unless the
  plan's `reminders.email_assignees` is off;
- an account holder's Project plans switches (their own on /me, else the
  company default) are honored: Inbox off → nothing, Email off → the inbox
  row only, both on (the default) → both. notify() keeps the inbox row of a
  kind that is never emailed even when the Inbox switch is off, so the
  switches are read here first, with the helper notify() itself uses
  (`notifications.email.effective_switches`). The person's schedule (quiet
  hours, days off) holds nothing: a reminder goes at the plan's send time
  and an assignment notice when it is made, as learning's direct mail does;
- someone without an account gets the email only, when they have an
  address. That email mirrors no inbox row, so it is queued without a kind,
  as learning's is: the delivery worker's re-check (which drops a kind's
  email whose inbox row is gone) leaves it alone. Archived people and
  disabled accounts get nothing.

The rule itself is `delivery()`, which reads nothing: `reach` acts on it, and
the super-admin Check delivery tool (notifications/check.py) reports it, so the
two cannot drift.

Nothing here commits: every row joins the caller's transaction, so a
rolled-back edit sends nothing."""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.db.models import Initiative, Person
from serversherpa.mail.outbox import enqueue
from serversherpa.notifications.company import CompanySettings, load_company_settings
from serversherpa.notifications.email import (
    Contact,
    effective_switches,
    load_contact,
    portal_link,
)
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import KindInfo, kind_info
from serversherpa.plans.floating import last_day, plan_now
from serversherpa.plans.service import PlanState
from serversherpa.plans.settings import PlanSettings

KIND = "plan_task_assigned"
# an inbox body names this many tasks, then "and N more"
BODY_TASKS = 5


@dataclass(frozen=True)
class Delivery:
    """How a plan message would reach one person, and why not where it doesn't.
    The reasons are the delivery log's codes: `inbox_reason` recipient_inactive,
    category_off or no_account; `email_reason` recipient_inactive, category_off,
    category_inbox_only, email_assignees_off or no_address. Each is None where
    that part goes."""
    inbox: bool                     # the inbox row is written
    inbox_reason: str | None
    address: str | None             # the direct email goes here
    address_source: str | None      # "contact" (their own email) or "login" (the account's)
    email_reason: str | None


def delivery(info: KindInfo | None, contact: Contact | None, company: CompanySettings, *,
             email: bool) -> Delivery:
    """The delivery rule for one person, from what is already loaded (see the
    module notes). `email` is the plan's `reminders.email_assignees`."""
    if contact is None or not contact.active:
        return Delivery(False, "recipient_inactive", None, None, "recipient_inactive")
    # login_email is the account's email, which every account has
    has_account = contact.login_email is not None
    inbox_reason = email_reason = None
    if has_account:
        switches = effective_switches(info, contact, company)
        if not switches.inbox:
            return Delivery(False, "category_off", None, None, "category_off")
        if not switches.email:          # already off when Inbox is
            email_reason = "category_inbox_only"
    else:
        inbox_reason = "no_account"
    if email_reason is None and not email:
        email_reason = "email_assignees_off"
    # learning.emails.address_for's rule (contact email, else login email,
    # for an active person), read from the contact already loaded
    if email_reason is None and contact.address is None:
        email_reason = "no_address"
    if email_reason is not None:
        return Delivery(has_account, inbox_reason, None, None, email_reason)
    return Delivery(has_account, inbox_reason, contact.address,
                    "contact" if contact.contact_email else "login", None)


@dataclass(frozen=True)
class Reach:
    """How one message reaches one person."""
    inbox: bool             # write the inbox row (an account holder)
    address: str | None     # and send the direct email here


async def reach(db: AsyncSession, person_id: uuid.UUID, kind: str, *,
                email: bool) -> Reach | None:
    """How a `kind` message reaches the person, or None when it doesn't
    (their Project plans Inbox switch is off, they are archived or disabled,
    or they have no account and no email we may use). `email` is the plan's
    `reminders.email_assignees`."""
    rule = delivery(kind_info(kind), await load_contact(db, person_id),
                    await load_company_settings(db), email=email)
    if not rule.inbox and rule.address is None:
        return None
    return Reach(inbox=rule.inbox, address=rule.address)


async def send(db: AsyncSession, person_id: uuid.UUID, kind: str, *, email: bool,
               title: str, body: str, link: str, payload: dict, template: str,
               **ctx) -> bool:
    """One message under the delivery rule: the inbox row (`title`, `body`,
    the portal-relative `link`) and the `template` email, which gets `ctx`
    plus `person_name` and the absolute `link`. True when anything went."""
    who = await reach(db, person_id, kind, email=email)
    if who is None:
        return False
    # notify() returns None only for a kind it would email; plan kinds never
    # are, so the row is always written
    row = (await notify(db, person_id, kind, title, body=body, link=link, payload=payload)
           if who.inbox else None)
    if who.address is not None:
        person = await db.get(Person, person_id)
        # a kind only for mail that mirrors the inbox row (see the module notes)
        await enqueue(db, template, who.address, person_id=person_id,
                      kind=kind if row is not None else None,
                      notification_id=row.id if row is not None else None,
                      person_name=person.preferred_name or person.first_name,
                      link=portal_link(link), **ctx)
    return True


# ── wording shared with the reminders ────────────────────────────────


def task_link(initiative_id: uuid.UUID, task_id: uuid.UUID | None = None) -> str:
    """The plan tab, opened on a task when one is given."""
    link = f"/initiatives/{initiative_id}?tab=plan"
    return link if task_id is None else f"{link}&task={task_id}"


def long_day(day: date, today: date) -> str:
    """"Thursday, November 5", with the year when it is not `today`'s."""
    text = f"{day:%A}, {day:%B} {day.day}"
    return text if day.year == today.year else f"{text}, {day.year}"


def short_day(day: date, today: date) -> str:
    """"Thu, Nov 5", with the year when it is not `today`'s."""
    text = f"{day:%a}, {day:%b} {day.day}"
    return text if day.year == today.year else f"{text}, {day.year}"


def name_list(names: list[str]) -> str:
    """The first BODY_TASKS names, then "and N more"."""
    shown = ", ".join(names[:BODY_TASKS])
    rest = len(names) - BODY_TASKS
    return f"{shown} and {rest} more" if rest > 0 else shown


def tasks_word(count: int) -> str:
    return f"{count} task{'' if count == 1 else 's'}"


# ── assignment notices ───────────────────────────────────────────────


async def assignment_notices(db: AsyncSession, state: PlanState,
                             newly_assigned: dict[uuid.UUID, list[uuid.UUID]],
                             actor: AuthContext, settings: PlanSettings) -> int:
    """When the plan's `notify_on_assign` is on, tell each person an ops
    batch newly assigned (`OpResult.newly_assigned`: person -> task ids in
    outline order) about it, once for the whole batch: "You were assigned 2
    tasks in <initiative>", with each task's start, finish and deadline in
    the email (the finish as the day its work ends, `floating.last_day`).
    Never the actor. Returns how many people were told."""
    if not settings.reminders.notify_on_assign or not newly_assigned:
        return 0
    plan = state.plan
    initiative = await db.get(Initiative, plan.initiative_id)
    actor_id = actor.person.id if actor.person is not None else None
    assigned_by = actor.person.display_name if actor.person is not None else None
    today = plan_now(plan.timezone).date()
    told = 0
    for person_id, task_ids in newly_assigned.items():
        tasks = [state.tasks[tid] for tid in task_ids if tid in state.tasks]
        if person_id == actor_id or not tasks:
            continue
        link = task_link(initiative.id, tasks[0].id)
        rows = [{
            "name": task.name,
            "start_label": short_day(task.start.date(), today) if task.start else "—",
            # the day the work ends (a finish at 00:00 is the day before's end)
            "finish_label": (short_day(last_day(task.start or task.finish, task.finish), today)
                             if task.finish else "—"),
            "deadline_label": (short_day(task.deadline.date(), today)
                               if task.deadline else None),
        } for task in tasks]
        if await send(
                db, person_id, KIND, email=settings.reminders.email_assignees,
                title=f"You were assigned {tasks_word(len(tasks))} in {initiative.name}",
                body=name_list([task.name for task in tasks]), link=link,
                payload={"plan_id": str(plan.id), "initiative_id": str(initiative.id),
                         "task_ids": [str(task.id) for task in tasks]},
                template="plan_assigned", initiative_name=initiative.name, tasks=rows,
                assigned_by=assigned_by):
            told += 1
    return told
