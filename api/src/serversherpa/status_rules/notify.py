"""The Notify action, "Send a notification" (`notify` in the catalog). A status rule that
matches tells the people and groups it names and, with its "watchers" switch on, whoever
watches the rule's initiative (or one above it) or the scan's site.

The action sends nothing itself. Each match goes through three steps:

1. **The repeat guard.** A rule notifies about the same matched thing (an asset, a container
   or a person) again only an hour after it last did. `status_rule_notified` holds the time,
   checked and set in one upsert: of two transactions racing on one rule and thing, the second
   waits for the first, then finds it within the hour. A repeat is not applied, reason
   `notified_within_hour`.
2. **The batch.** The match joins its transaction's batch for the rule and the rule's
   initiative (a match with no initiative is a batch of its own, about the thing), kept in the
   session's `info`. The first match of a batch looks up everything its notice will say; the
   ones after it only add their id.
3. **The notice, at commit.** When the transaction commits, a `before_commit` listener
   announces each batch as one `status_rule_matched` event (notifications/events.announce)
   with its final count, so a 15,000-row bulk update writes one event, once. One match says
   "{rule}: {thing}" and links to the thing; several say "{rule} ({count})" and link to the
   rule's executions.

Nothing outlives a rollback. The guard rows go with the transaction, and so do the batches: a
savepoint that rolls back takes back the matches added inside it, and the end of the
transaction (a commit, a rollback, or a close with neither) drops whatever is left.

Soft states (no rule in the context, the matched thing missing, nobody to tell) are not
applied, with a reason; they never raise, since a raise rolls back the whole scan, an off-move
sighting included. The action never commits, and only reads the rule's params: the engine's
60 s rule cache hands every scan the same dict.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 6)"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import event, literal_column
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from serversherpa.db.models import Initiative, Site, StatusRuleNotified
from serversherpa.notifications.events import EventItem, Thing, announce
from serversherpa.services.initiatives import ancestor_ids
from serversherpa.status_rules.context import Context

if TYPE_CHECKING:
    from serversherpa.status_rules.catalog import ActionOutcome

# How long a rule waits before it notifies about the same thing again: the RFID Station
# alarm's hour (kiosk_laptop/edge/src/edge/rfid/alarm.py, REPEAT_S), counted the same way,
# from the last notice, so a repeat inside the hour doesn't extend it.
REPEAT_WINDOW = timedelta(hours=1)

# The session `info` keys: the transaction's batches, and how far each batch had got when an
# open savepoint began.
NOTICES = "rule_notices"
MARKS = "rule_notice_marks"

# A matched thing's page, by the kind of thing the rule matches.
_PAGES = {"asset": "/assets?open={}", "container": "/logistics/containers?open={}",
          "person": "/people/workers/{}"}


def rule_link(rule_id: uuid.UUID) -> str:
    """The rule's executions on Status rules, where a notice about several matches links."""
    return f"/admin/status-rules?tab=executions&rule={rule_id}"


def _name(kind: str, thing) -> str:
    """The matched thing as its list shows it: an asset by its serial number, else its name,
    else its id; a container by its name; a worker by their name."""
    if kind == "asset":
        return thing.serial_number or thing.name or str(thing.id)
    if kind == "container":
        return thing.name
    return thing.display_name


def _joined(*parts: str | None) -> str:
    """A notice line: the parts that are there, " · " between them."""
    return " · ".join(part for part in parts if part)


@dataclass
class _Batch:
    """One rule's matches on one initiative, or on one thing with no initiative, in one
    transaction: what its notice says, looked up at the first match, and each match's id in
    the order they came."""

    rule_id: uuid.UUID
    rule_name: str
    subject: Thing                  # the initiative, or the thing when there is none
    matched_type: str
    initiative_id: uuid.UUID | None
    initiative_name: str | None
    title: str                      # for one match: "{rule}: {thing}"
    line: str                       # for one match: "{initiative} · {scan site}"
    link: str                       # for one match: the thing's page
    reaches: list[Thing]
    actor_id: uuid.UUID | None
    person_ids: list[uuid.UUID]
    group_ids: list[uuid.UUID]
    watchers: bool
    ids: list[uuid.UUID] = field(default_factory=list)


async def apply(db: AsyncSession, ctx: Context, params: dict) -> "ActionOutcome":
    """Notify about this match, unless the rule did about the same thing within the hour or
    there is nobody to tell. One upsert, plus the lookups of a batch's first match."""
    # The catalog imports this module for its ActionDef, so the catalog's names come late.
    from serversherpa.status_rules.catalog import ActionOutcome

    if ctx.rule_id is None:
        return ActionOutcome(False, "no_rule")
    kind = ctx.scan.match_type
    thing = {"asset": ctx.asset, "container": ctx.container, "person": ctx.person}.get(kind)
    if thing is None:
        return ActionOutcome(False, f"no_{kind}")
    # the rule's initiative: the context's, else a matched container's own move
    initiative_id = (ctx.initiative.id if ctx.initiative is not None
                     else thing.initiative_id if kind == "container" else None)
    person_ids = [uuid.UUID(value) for value in params.get("people") or ()]
    group_ids = [uuid.UUID(value) for value in params.get("groups") or ()]
    watchers = params.get("watchers") is True
    watched = initiative_id is not None or ctx.scan.site_id is not None
    if not (person_ids or group_ids or (watchers and watched)):
        return ActionOutcome(False, "nobody_to_tell")

    matched = Thing(kind, thing.id)
    if not await _first_in_the_hour(db, ctx.rule_id, matched):
        return ActionOutcome(False, "notified_within_hour")

    about = Thing("initiative", initiative_id) if initiative_id is not None else matched
    key = (ctx.rule_id, about)
    batch = db.info.get(NOTICES, {}).get(key)
    if batch is None:
        batch = await _first_match(db, ctx, about, kind, thing, initiative_id,
                                   person_ids, group_ids, watchers)
        db.info.setdefault(NOTICES, {})[key] = batch
    batch.ids.append(thing.id)
    return ActionOutcome(True)


async def _first_in_the_hour(db: AsyncSession, rule_id: uuid.UUID, thing: Thing) -> bool:
    """Record that the rule notifies about `thing` now, unless it did within the hour: True
    when it may. One statement, so two transactions on the same rule and thing can't both get
    a row back: the second waits on the first's row, then finds it within the hour. `now` is
    Python's, because Postgres's now() stays put for a whole transaction."""
    now = datetime.now(UTC)
    upsert = (pg_insert(StatusRuleNotified)
              .values(rule_id=rule_id, subject_type=thing.type, subject_id=thing.id,
                      notified_at=now)
              .on_conflict_do_update(
                  index_elements=[StatusRuleNotified.rule_id, StatusRuleNotified.subject_type,
                                  StatusRuleNotified.subject_id],
                  set_={"notified_at": now},
                  where=StatusRuleNotified.notified_at <= now - REPEAT_WINDOW)
              .returning(literal_column("1")))
    return await db.scalar(upsert) is not None


async def _first_match(db: AsyncSession, ctx: Context, about: Thing, kind: str, thing,
                       initiative_id: uuid.UUID | None, person_ids: list[uuid.UUID],
                       group_ids: list[uuid.UUID], watchers: bool) -> _Batch:
    """A new batch, with everything its notice needs: the names it says, and with watchers on
    the things it reaches (the initiative, the initiatives above it in id order, and the
    scan's site). The commit can't look anything up: its listener is not async."""
    initiative = ctx.initiative
    if initiative is None and initiative_id is not None:
        initiative = await db.get(Initiative, initiative_id)
    site_id = ctx.scan.site_id
    site = await db.get(Site, site_id) if site_id is not None else None
    reaches: list[Thing] = []
    if watchers:
        if initiative_id is not None:
            reaches += [Thing("initiative", initiative_id),
                        *(Thing("initiative", parent)
                          for parent in sorted(await ancestor_ids(db, initiative_id)))]
        if site_id is not None:
            reaches.append(Thing("site", site_id))
    initiative_name = initiative.name if initiative is not None else None
    return _Batch(
        rule_id=ctx.rule_id, rule_name=ctx.rule_name, subject=about, matched_type=kind,
        initiative_id=initiative_id, initiative_name=initiative_name,
        title=f"{ctx.rule_name}: {_name(kind, thing)}",
        line=_joined(initiative_name, site.name if site is not None else None),
        link=_PAGES[kind].format(thing.id), reaches=reaches, actor_id=ctx.scan.operator_id,
        person_ids=person_ids, group_ids=group_ids, watchers=watchers)


def _announce(session: Session, batch: _Batch) -> None:
    """The batch's one event, with its final count. Adds it to the session; the commit that is
    under way writes it."""
    count = len(batch.ids)
    if count == 1:
        title, line, link = batch.title, batch.line, batch.link
    else:
        title = f"{batch.rule_name} ({count})"
        line = _joined(batch.initiative_name, str(count))
        link = rule_link(batch.rule_id)
    announce(session, "status_rule_matched", subject=batch.subject,
             item=EventItem(title, line, link, initiative_id=batch.initiative_id,
                            matched_type=batch.matched_type, matched_ids=tuple(batch.ids)),
             reaches=batch.reaches, actor_id=batch.actor_id, person_ids=batch.person_ids,
             group_ids=batch.group_ids, watchers=batch.watchers, rule_id=batch.rule_id)


# ── the transaction's batches ───────────────────────────────────────
# Registered once, at import, on the sync Session class an AsyncSession wraps. Every session
# in the process passes through them; only one holding batches is changed.

@event.listens_for(Session, "after_transaction_create")
def _mark_savepoint(session: Session, transaction: SessionTransaction) -> None:
    """A savepoint begins: remember how far each batch had got, for its rollback."""
    if transaction.nested and session.info.get(NOTICES):
        session.info.setdefault(MARKS, {})[transaction] = {
            key: len(batch.ids) for key, batch in session.info[NOTICES].items()}


@event.listens_for(Session, "after_soft_rollback")
def _undo_savepoint(session: Session, previous_transaction: SessionTransaction) -> None:
    """A savepoint rolled back: the matches added inside it go, the ones before it stay. A
    savepoint begun with no batch has no mark, and takes them all."""
    if not previous_transaction.nested:
        return
    mark = session.info.get(MARKS, {}).pop(previous_transaction, {})
    batches = session.info.get(NOTICES, {})
    for key in list(batches):
        if mark.get(key):
            del batches[key].ids[mark[key]:]
        else:
            del batches[key]


@event.listens_for(Session, "before_commit")
def _announce_batches(session: Session) -> None:
    """The transaction commits: each batch becomes its event, for the commit's own flush to
    write. Releasing a savepoint fires this too; its batches wait for the real commit."""
    if session.in_nested_transaction():
        return
    session.info.pop(MARKS, None)
    for batch in session.info.pop(NOTICES, {}).values():
        _announce(session, batch)


@event.listens_for(Session, "after_transaction_end")
def _drop_batches(session: Session, transaction: SessionTransaction) -> None:
    """The transaction is over, committed, rolled back or closed: nothing it collected
    outlives it. (A rollback ends it here too, whether the caller asked for it or a failed
    flush did and the caller then closed the session.)"""
    if transaction.parent is None:
        session.info.pop(NOTICES, None)
        session.info.pop(MARKS, None)
