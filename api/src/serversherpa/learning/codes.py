"""Learning codes: how a worker without an account signs in to the learn
site. A code is 6 characters of Crockford base32 (the kiosk pairing
alphabet), typed with the worker's last name, or skipped entirely with the
one-click link token from the invite email.

Neither is stored: the code as a keyed HMAC fingerprint (the move-password
pattern, its own domain), the link token as SHA-256 (the reset-link
pattern). The raw values are returned once, by `issue`, for the email and
the printable code sheet. One active code per person and initiative (or
per person, for a general code).

Nothing here commits; callers own the transaction."""
import hashlib
import hmac
import secrets
import unicodedata
import uuid
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import Initiative, Site
from serversherpa.learning.assign import _end_day
from serversherpa.learning.models import LearningCode, LearningSession
from serversherpa.learning.settings import load_settings
from serversherpa.services.audit import audit
from serversherpa.services.kiosk_pairing import CODE_ALPHABET, normalize_code
from serversherpa.services.password_reset import hash_token
from serversherpa.services.timeclock import site_zone, zone_named

CODE_LENGTH = 6
LINK_TOKEN_BYTES = 32
ISSUE_ATTEMPTS = 5
# Domain separation: the pepper keys other HMACs (move passwords), so a
# learning-code fingerprint is never comparable with anything else.
FINGERPRINT_DOMAIN = b"learning-code\0"
FINGERPRINT_INDEX = "learning_codes_fingerprint_active_uniq"
EXPIRES_AT = time(23, 59)      # a code lasts through the initiative's last day

# Phone keyboards type typographic apostrophes and hyphens; the stored
# name usually has the ASCII ones.
_PUNCTUATION = str.maketrans({"‘": "'", "’": "'", "ʼ": "'",
                              "‐": "-", "‑": "-"})


class CodeCollision(Exception):
    """Every attempt drew a code another active code already holds."""


def generate() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def fingerprint(code: str) -> bytes:
    pepper = get_settings().password_pepper.get_secret_value()
    return hmac.new(pepper.encode(), FINGERPRINT_DOMAIN + normalize_code(code).encode(),
                    hashlib.sha256).digest()


def is_well_formed(code: str) -> bool:
    """What a person typed is a possible code (after normalize_code)."""
    normalized = normalize_code(code)
    return len(normalized) == CODE_LENGTH and set(normalized) <= set(CODE_ALPHABET)


def normalize_last_name(s: str) -> str:
    """Accent-stripped (NFKD minus combining marks), casefolded, whitespace
    trimmed and collapsed. Hyphens and apostrophes are kept."""
    decomposed = unicodedata.normalize("NFKD", s.translate(_PUNCTUATION))
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return " ".join(stripped.casefold().split())


def last_name_matches(stored: str, typed: str) -> bool:
    """Constant-time on the normalized names; a blank stored name matches
    nothing (a blank answer must never sign anyone in)."""
    expected = normalize_last_name(stored)
    same = hmac.compare_digest(expected.encode(), normalize_last_name(typed).encode())
    return same and bool(expected)


def initiative_site_id(initiative: Initiative) -> uuid.UUID | None:
    """The site whose zone an initiative's local times are read in: its own
    site, else its destination, else its origin."""
    return next((s for s in (initiative.site_id, initiative.destination_site_id,
                             initiative.origin_site_id) if s is not None), None)


async def initiative_zone(db: AsyncSession, initiative: Initiative):
    """The zone an initiative's local times are read in (`initiative_site_id`'s
    zone); UTC when that site has no known zone."""
    return await site_zone(db, initiative_site_id(initiative))


async def initiative_zones(db: AsyncSession,
                           initiatives: list[Initiative]) -> dict[uuid.UUID, ZoneInfo]:
    """`initiative_zone` for many initiatives in one query."""
    site_ids = {initiative_site_id(i) for i in initiatives} - {None}
    names = dict((await db.execute(select(Site.id, Site.timezone).where(
        Site.id.in_(site_ids)))).all()) if site_ids else {}
    return {i.id: zone_named(names.get(initiative_site_id(i))) or ZoneInfo("UTC")
            for i in initiatives}


async def _expires_at(db: AsyncSession, initiative_id: uuid.UUID | None,
                      now: datetime) -> datetime | None:
    if initiative_id is None:
        days = (await load_settings(db)).general_code_days
        return now + timedelta(days=days) if days else None
    initiative = await db.get(Initiative, initiative_id)
    end = _end_day(initiative)
    if end is None:
        return None
    return datetime.combine(end, EXPIRES_AT, tzinfo=await initiative_zone(db, initiative))


# the initiative fields a code's expiry is computed from (the end day, and
# the sites whose zone it is read in)
EXPIRY_FIELDS = frozenset({"scheduled_end", "real_end_at", "site_id", "destination_site_id",
                           "origin_site_id"})


async def refresh_expiry(db: AsyncSession, initiative: Initiative) -> int:
    """Re-stamp the initiative's unrevoked codes with the expiry its dates
    give now, so moving the end day later doesn't leave codes that stop
    early (and moving it sooner ends them sooner). Returns how many changed."""
    expires_at = await _expires_at(db, initiative.id, datetime.now(UTC))
    result = await db.execute(
        update(LearningCode)
        .where(LearningCode.initiative_id == initiative.id, LearningCode.revoked_at.is_(None),
               LearningCode.expires_at.is_distinct_from(expires_at))
        .values(expires_at=expires_at))
    return result.rowcount or 0


def _same_key(person_id: uuid.UUID, initiative_id: uuid.UUID | None):
    initiative = (LearningCode.initiative_id.is_(None) if initiative_id is None
                  else LearningCode.initiative_id == initiative_id)
    return (LearningCode.person_id == person_id, initiative, LearningCode.revoked_at.is_(None))


async def issue(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID | None, *,
                actor_id: uuid.UUID | None) -> tuple[LearningCode, str, str]:
    """A new code for the person on `initiative_id` (None: a general code),
    any active one for the same key revoked first. Returns the row, the raw
    code and the raw link token — the only time either exists in the clear."""
    now = datetime.now(UTC)
    previous = (await db.scalars(select(LearningCode.id).where(
        *_same_key(person_id, initiative_id)))).all()
    for code_id in previous:
        await revoke(db, code_id, actor_id=actor_id)
    expires_at = await _expires_at(db, initiative_id, now)
    for _ in range(ISSUE_ATTEMPTS):
        code = generate()
        link_token = secrets.token_urlsafe(LINK_TOKEN_BYTES)
        row = LearningCode(person_id=person_id, initiative_id=initiative_id,
                           fingerprint=fingerprint(code), link_token_hash=hash_token(link_token),
                           expires_at=expires_at, created_by=actor_id)
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError as exc:
            if FINGERPRINT_INDEX not in str(exc.orig):
                raise
            continue            # another active code holds this fingerprint: draw again
        audit(db, actor_id=actor_id, entity_type="learning_code", entity_id=str(row.id),
              action="issue", changes={"person_id": str(person_id),
                                       "initiative_id": str(initiative_id) if initiative_id else None,
                                       "expires_at": expires_at.isoformat() if expires_at else None})
        return row, code, link_token
    raise CodeCollision()


async def revoke(db: AsyncSession, code_id: uuid.UUID, *, actor_id: uuid.UUID | None) -> None:
    """Retire a code: it, its link and every learn session it started stop
    working. Revoking a revoked code changes nothing."""
    now = datetime.now(UTC)
    revoked = await db.scalar(
        update(LearningCode)
        .where(LearningCode.id == code_id, LearningCode.revoked_at.is_(None))
        .values(revoked_at=now).returning(LearningCode.id))
    if revoked is None:
        return
    await db.execute(
        update(LearningSession)
        .where(LearningSession.code_id == code_id, LearningSession.revoked_at.is_(None))
        .values(revoked_at=now))
    audit(db, actor_id=actor_id, entity_type="learning_code", entity_id=str(code_id),
          action="revoke")
