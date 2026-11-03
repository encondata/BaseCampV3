"""Telling people about plan tasks: the delivery rule every plan message
follows (`reach`, `send`) and the assignment notice the ops route sends
(`assignment_notices`). The reminder sweep (plans/reminders.py) sends
through the same two functions.

Delivery (spec "Due dates and reminders", *Delivery*). A plan message is
personal, so it never goes through a notification group's subscription:

- a person with a portal account gets the inbox row: `notify()`, with the
  plan kinds registered `email=False`, so notify() sends no group email;
- the direct email goes through the mail outbox to the person's contact
  email (else their login email: `learning.emails.address_for`), unless the
  plan's `reminders.email_assignees` is off;
- an account holder's own /me choice for Project plans is honored: off →
  nothing, inbox → the inbox row only, email (the default) → both. notify()
  keeps the inbox row of a kind that is never emailed even when the
  category is off, so the choice is read here first, with the helper
  notify() itself uses (`notifications.email.personal_choice`);
- someone without an account gets the email only, when they have an
  address; archived people and disabled accounts get nothing.

Nothing here commits: every row joins the caller's transaction, so a
rolled-back edit sends nothing."""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.db.models import Initiative, Person
from serversherpa.learning.emails import address_for
from serversherpa.mail.outbox import enqueue
from serversherpa.notifications.email import load_contact, personal_choice, portal_link
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info
from serversherpa.plans.floating import plan_now
from serversherpa.plans.service import PlanState
from serversherpa.plans.settings import PlanSettings

KIND = "plan_task_assigned"
# an inbox body names this many tasks, then "and N more"
BODY_TASKS = 5


@dataclass(frozen=True)
class Reach:
    """How one message reaches one person."""
    inbox: bool             # write the inbox row (an account holder)
    address: str | None     # and send the direct email here


async def reach(db: AsyncSession, person_id: uuid.UUID, kind: str, *,
                email: bool) -> Reach | None:
    """How a `kind` message reaches the person, or None when it doesn't
    (their Project plans choice is off, they are archived or disabled, or
    they have no account and no email we may use). `email` is the plan's
    `reminders.email_assignees`."""
    contact = await load_contact(db, person_id)
    if contact is None or not contact.active:
        return None
    # login_email is the account's email, which every account has
    has_account = contact.login_email is not None
    choice = personal_choice(kind_info(kind), contact) if has_account else "email"
    if choice == "off":
        return None
    address = await address_for(db, person_id) if email and choice == "email" else None
    if not has_account and address is None:
        return None
    return Reach(inbox=has_account, address=address)


async def send(db: AsyncSession, person_id: uuid.UUID, kind: str, *, email: bool,
               title: str, body: str, link: str, payload: dict, template: str,
               **ctx) -> bool:
    """One message under the delivery rule: the inbox row (`title`, `body`,
    the portal-relative `link`) and the `template` email, which gets `ctx`
    plus `person_name` and the absolute `link`. True when anything went."""
    who = await reach(db, person_id, kind, email=email)
    if who is None:
        return False
    row = None
    if who.inbox:
        row = await notify(db, person_id, kind, title, body=body, link=link, payload=payload)
        if row is None:         # notify() found the category off after all
            return False
    if who.address is not None:
        person = await db.get(Person, person_id)
        await enqueue(db, template, who.address, person_id=person_id, kind=kind,
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
    the email. Never the actor. Returns how many people were told."""
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
            "finish_label": short_day(task.finish.date(), today) if task.finish else "—",
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
