"""Learning emails: the invite (code + one-click link), reminders, the
completion email with the time clock QR code inline, a new document
version, and the link on its own (the time clock's "Email me the link").

Every send writes its `learning_email_log` row first. The table's unique
index (kind, person, code or none, stage) is the dedupe: a repeat inserts
nothing (ON CONFLICT DO NOTHING, so the caller's transaction survives) and
the function returns None without queueing anything. None also means the
person has no email we may use (contact email first, then the login email,
as notifications/email.py reads them; nobody archived or disabled).

Subject and intro come from the learning settings' `email_text[kind][lang]`
(then `[kind]["en"]`) when set, otherwise from the template. `lang` is the
language of the person's latest sign-off, else English.

Raw codes and link tokens are never stored on the code row (only the
fingerprint and the link hash), but like password reset links they are
in the rendered `email_outbox` bodies. Nothing here commits."""
import base64
import io
import secrets
import uuid
from datetime import UTC, date, datetime
from urllib.parse import urlsplit

import segno
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.schemas import LEARNING_SUBJECT_MAX
from serversherpa.config import learn_url
from serversherpa.db.models import EmailOutbox, Initiative, Person, UserAccount
from serversherpa.learning import codes
from serversherpa.learning.assign import OPEN_STATUSES
from serversherpa.learning.models import (
    LearningAssignment,
    LearningCode,
    LearningDocument,
    LearningDocumentVersion,
    LearningEmailLog,
    LearningSignoff,
)
from serversherpa.learning.settings import load_settings
from serversherpa.mail.outbox import enqueue
from serversherpa.notifications.email import load_contact
from serversherpa.services.password_reset import hash_token
from serversherpa.services.timezone import stored_day

TEMPLATES = {
    "invite": "learning_invite",
    "reminder": "learning_reminder",
    "complete": "learning_complete",
    "new_version": "learning_new_version",
    "link": "learning_link",
}
# an edited subject is one header line: CR/LF collapse to spaces, and it is
# capped (the settings schema enforces the same cap on save)
SUBJECT_MAX = LEARNING_SUBJECT_MAX
QR_CID = "qr"


def _now() -> datetime:
    return datetime.now(UTC)


def qr_png(value: str) -> bytes:
    """The time clock QR code as a PNG (error level M, scale 8, border 4).
    Always a full QR symbol, never a Micro QR, so every scanner reads it."""
    buf = io.BytesIO()
    segno.make_qr(value, error="m").save(buf, kind="png", scale=8, border=4)
    return buf.getvalue()


def spaced(code: str) -> str:
    """"K7QM2X" → "K7Q M2X", the way the mockup prints it."""
    return f"{code[:3]} {code[3:]}"


def day_text(day: date | None) -> str | None:
    return f"{day:%b} {day.day}, {day.year}" if day else None


def _clean_subject(subject: str) -> str:
    return " ".join(subject.split())[:SUBJECT_MAX]


async def address_for(db: AsyncSession, person_id: uuid.UUID) -> str | None:
    contact = await load_contact(db, person_id)
    if contact is None or not contact.active:
        return None
    return contact.address


# `address_for` on rows a list query already loaded (outer-joined to
# user_accounts): select these columns and pass them to `listed_address`,
# so a roster's "no email" is exactly a send's
ADDRESS_COLUMNS = (Person.email, UserAccount.email, Person.archived_at, UserAccount.disabled_at)


def listed_address(person_email: str | None, account_email: str | None,
                   archived_at: datetime | None, disabled_at: datetime | None) -> str | None:
    if archived_at is not None or disabled_at is not None:
        return None
    return person_email or account_email or None


async def preferred_language(db: AsyncSession, person_id: uuid.UUID) -> str:
    """The language of the person's latest sign-off, else English."""
    lang = await db.scalar(
        select(LearningSignoff.language).where(LearningSignoff.person_id == person_id)
        .order_by(LearningSignoff.signed_at.desc(), LearningSignoff.created_at.desc())
        .limit(1))
    return lang or "en"


async def _overrides(db: AsyncSession, kind: str, lang: str) -> tuple[str | None, str | None]:
    by_lang = (await load_settings(db)).email_text.get(kind) or {}
    entry = by_lang.get(lang) or by_lang.get("en") or {}
    subject = _clean_subject(entry.get("subject") or "")
    intro = (entry.get("intro") or "").strip()
    return subject or None, intro or None


async def log_once(db: AsyncSession, kind: str, person_id: uuid.UUID, *,
               initiative_id: uuid.UUID | None, code_id: uuid.UUID | None = None,
               stage: str = "") -> LearningEmailLog | None:
    """The dedupe row, or None when this (kind, person, code, stage) was
    already sent."""
    return (await db.scalars(
        pg_insert(LearningEmailLog)
        .values(kind=kind, person_id=person_id, initiative_id=initiative_id,
                code_id=code_id, stage=stage)
        .on_conflict_do_nothing()
        .returning(LearningEmailLog))).first()


async def _enqueue(db: AsyncSession, kind: str, person_id: uuid.UUID, address: str,
                   log: LearningEmailLog, *, attachments: list[dict] | None = None,
                   **ctx) -> EmailOutbox:
    subject, intro = await _overrides(db, kind, await preferred_language(db, person_id))
    row = await enqueue(db, TEMPLATES[kind], address, person_id=person_id,
                        attachments=attachments, subject_override=subject,
                        intro_override=intro, **ctx)
    log.outbox_id = row.id
    return row


def _name(person: Person) -> str:
    return person.preferred_name or person.first_name


def _learn_ctx() -> dict:
    origin = learn_url("")
    return {"learn_origin": origin, "learn_host": urlsplit(origin).netloc or origin}


def _link(token: str) -> str:
    return learn_url(f"/start#t={token}")


async def _open_count(db: AsyncSession, person_id: uuid.UUID,
                      initiative_id: uuid.UUID | None) -> int:
    scope = (LearningAssignment.initiative_id.is_(None) if initiative_id is None
             else LearningAssignment.initiative_id == initiative_id)
    return await db.scalar(
        select(func.count()).select_from(LearningAssignment)
        .where(LearningAssignment.person_id == person_id, scope,
               LearningAssignment.status.in_(OPEN_STATUSES))) or 0


async def active_code(db: AsyncSession, person_id: uuid.UUID,
                      initiative_id: uuid.UUID | None) -> LearningCode | None:
    """The person's working code for this key: not revoked, not expired."""
    scope = (LearningCode.initiative_id.is_(None) if initiative_id is None
             else LearningCode.initiative_id == initiative_id)
    now = _now()
    return await db.scalar(
        select(LearningCode)
        .where(LearningCode.person_id == person_id, scope, LearningCode.revoked_at.is_(None),
               (LearningCode.expires_at.is_(None)) | (LearningCode.expires_at > now))
        .order_by(LearningCode.created_at.desc()).limit(1))


def rotate_link(code_row: LearningCode) -> str:
    """A new one-click link for an existing code; the code itself (and any
    learn session it started) keeps working, the old link stops."""
    token = secrets.token_urlsafe(codes.LINK_TOKEN_BYTES)
    code_row.link_token_hash = hash_token(token)
    return token


async def _fresh_link(db: AsyncSession, person_id: uuid.UUID,
                      initiative_id: uuid.UUID | None) -> str:
    """A working link for the key: the active code's, rotated, or a newly
    issued code's when there's none."""
    code_row = await active_code(db, person_id, initiative_id)
    if code_row is not None:
        token = rotate_link(code_row)
        await db.flush()
        return token
    _, _, token = await codes.issue(db, person_id, initiative_id, actor_id=None)
    return token


async def _expires_on(db: AsyncSession, code_row: LearningCode,
                      initiative: Initiative | None) -> date | None:
    if code_row.expires_at is None:
        return None
    zone = await codes.initiative_zone(db, initiative) if initiative else UTC
    return code_row.expires_at.astimezone(zone).date()


def _start(initiative: Initiative | None) -> str | None:
    if initiative is None or initiative.scheduled_start is None:
        return None
    return day_text(stored_day(initiative.scheduled_start))


# ── the emails ───────────────────────────────────────────────────────


async def send_invite(db: AsyncSession, person: Person, code_row: LearningCode, code: str,
                      link_token: str, initiative: Initiative | None,
                      due_on: date | None) -> EmailOutbox | None:
    """The invite for a code `codes.issue` just returned (raw `code` and
    `link_token`). Deduped per code."""
    address = await address_for(db, person.id)
    if not address:
        return None
    initiative_id = initiative.id if initiative else None
    log = await log_once(db, "invite", person.id, initiative_id=initiative_id,
                     code_id=code_row.id)
    if log is None:
        return None
    return await _enqueue(
        db, "invite", person.id, address, log, **_learn_ctx(),
        name=_name(person), initiative_name=initiative.name if initiative else None,
        start_on=_start(initiative), due_on=day_text(due_on),
        expires_on=day_text(await _expires_on(db, code_row, initiative)),
        documents=await _open_count(db, person.id, initiative_id),
        code=spaced(code), link=_link(link_token))


async def send_reminder(db: AsyncSession, person: Person, code_row: LearningCode,
                        initiative: Initiative | None, due_on: date | None,
                        stage: str) -> EmailOutbox | None:
    """A reminder at `stage` (`r<offset>`), once per code. The code can't be
    repeated (it isn't stored), so the email carries a new one-click link
    for the same code."""
    address = await address_for(db, person.id)
    if not address:
        return None
    initiative_id = initiative.id if initiative else None
    log = await log_once(db, "reminder", person.id, initiative_id=initiative_id,
                     code_id=code_row.id, stage=stage)
    if log is None:
        return None
    token = rotate_link(code_row)
    return await _enqueue(
        db, "reminder", person.id, address, log, **_learn_ctx(),
        name=_name(person), initiative_name=initiative.name if initiative else None,
        start_on=_start(initiative), due_on=day_text(due_on),
        remaining=await _open_count(db, person.id, initiative_id), link=_link(token))


async def send_complete(db: AsyncSession, person_id: uuid.UUID,
                        initiative_id: uuid.UUID | None) -> EmailOutbox | None:
    """Everything is signed: the time clock QR code (`str(badge_uid)`, which
    kiosks match) inline as `cid:qr`. Once per initiative; the general set
    once per day."""
    person = await db.get(Person, person_id)
    address = await address_for(db, person_id) if person else None
    if not address:
        return None
    initiative = await db.get(Initiative, initiative_id) if initiative_id else None
    stage = str(initiative_id) if initiative_id else f"general:{_now().date().isoformat()}"
    log = await log_once(db, "complete", person_id, initiative_id=initiative_id, stage=stage)
    if log is None:
        return None
    attachment = {"cid": QR_CID, "filename": "time-clock-qr.png", "content_type": "image/png",
                  "b64": base64.b64encode(qr_png(str(person.badge_uid))).decode()}
    return await _enqueue(
        db, "complete", person_id, address, log, attachments=[attachment],
        name=_name(person), initiative_name=initiative.name if initiative else None)


async def send_link(db: AsyncSession, person_id: uuid.UUID,
                    initiative_id: uuid.UUID | None) -> EmailOutbox | None:
    """Re-issue the one-click link only (the active code is kept). At most
    one per person per minute: the stage is the ISO minute."""
    person = await db.get(Person, person_id)
    address = await address_for(db, person_id) if person else None
    if not address:
        return None
    minute = _now().replace(second=0, microsecond=0).isoformat()
    log = await log_once(db, "link", person_id, initiative_id=initiative_id, stage=minute)
    if log is None:
        return None
    initiative = await db.get(Initiative, initiative_id) if initiative_id else None
    token = await _fresh_link(db, person_id, initiative_id)
    return await _enqueue(
        db, "link", person_id, address, log, name=_name(person),
        initiative_name=initiative.name if initiative else None, link=_link(token))


async def send_new_version(db: AsyncSession, person_id: uuid.UUID,
                           document: LearningDocument) -> EmailOutbox | None:
    """A document's current version was pushed to the person outside an
    initiative: once per version, with a link on their general code."""
    person = await db.get(Person, person_id)
    address = await address_for(db, person_id) if person else None
    if not address or document.current_version_id is None:
        return None
    log = await log_once(db, "new_version", person_id, initiative_id=None,
                     stage=str(document.current_version_id))
    if log is None:
        return None
    version = await db.get(LearningDocumentVersion, document.current_version_id)
    token = await _fresh_link(db, person_id, None)
    return await _enqueue(
        db, "new_version", person_id, address, log, name=_name(person),
        title=document.title, change_note=version.change_note if version else None,
        link=_link(token))
