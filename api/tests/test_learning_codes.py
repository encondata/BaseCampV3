"""Learning codes: the 6-character code, its HMAC fingerprint, last-name
matching, issuing (one active code per person and initiative) and expiry."""
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Initiative, Person, Site, SystemConfig
from serversherpa.learning import codes
from serversherpa.learning.models import LearningCode
from serversherpa.services.kiosk_pairing import CODE_ALPHABET
from serversherpa.services.password_reset import hash_token

END = date(2026, 12, 4)


def _midnight(day: date) -> datetime:
    """Date-only initiative fields are stored as midnight UTC."""
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


async def _worker(db, last="Núñez"):
    person = Person(first_name="Wanda", last_name=last,
                    email=f"{uuid.uuid4().hex[:8]}@test.example.com")
    db.add(person)
    await db.commit()
    return person


async def _initiative(db, *, zone=None, end=END):
    site = None
    if zone is not None:
        site = Site(name=f"Site {uuid.uuid4().hex[:6]}", timezone=zone)
        db.add(site)
        await db.flush()
    move = Initiative(name="Move", initiative_type="move", site_id=site.id if site else None,
                      scheduled_start=_midnight(END - timedelta(days=3)),
                      scheduled_end=_midnight(end) if end else None)
    db.add(move)
    await db.commit()
    return move


def test_generate_alphabet_and_length():
    seen = {codes.generate() for _ in range(200)}
    assert len(seen) > 190                     # random, not a fixed value
    for code in seen:
        assert len(code) == 6
        assert set(code) <= set(CODE_ALPHABET)
    assert not set("ILOU") & set(CODE_ALPHABET)


@pytest.mark.parametrize("raw,expected", [
    ("Núñez", "nunez"),
    (" Van  Der Berg ", "van der berg"),
    ("O'Neil", "o'neil"),
    ("O’Neil", "o'neil"),                 # a phone keyboard's curly apostrophe
    ("Smith-Jones", "smith-jones"),
    ("Straße", "strasse"),
])
def test_normalize_last_name(raw, expected):
    assert codes.normalize_last_name(raw) == expected


def test_last_name_matches():
    assert codes.last_name_matches("Núñez", "  NUNEZ ")
    assert not codes.last_name_matches("Núñez", "Nunes")
    assert not codes.last_name_matches("", "   ")      # a blank answer never signs in


def test_fingerprint_is_keyed_normalized_and_domain_separated():
    assert codes.fingerprint("k7q m2x") == codes.fingerprint("K7QM2X")
    assert codes.fingerprint("K7QM2X") != codes.fingerprint("K7QM2Y")
    assert isinstance(codes.fingerprint("K7QM2X"), bytes)
    assert len(codes.fingerprint("K7QM2X")) == 32


async def test_issue_revokes_previous(db):
    person = await _worker(db)
    move = await _initiative(db)
    actor = (await _worker(db, "Admin")).id
    first, code1, link1 = await codes.issue(db, person.id, move.id, actor_id=actor)
    await db.commit()
    second, code2, link2 = await codes.issue(db, person.id, move.id, actor_id=actor)
    await db.commit()
    await db.refresh(first)
    assert first.revoked_at is not None and second.revoked_at is None
    assert second.fingerprint == codes.fingerprint(code2)
    assert second.link_token_hash == hash_token(link2) and link1 != link2
    # neither the code nor the link token is stored or audited in the clear
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "learning_code"))).all()
    assert {r.action for r in rows} >= {"issue", "revoke"}
    for row in rows:
        assert code1 not in str(row.changes) and code2 not in str(row.changes)
    # a general code is its own key: issuing one leaves the initiative code alone
    general, _, _ = await codes.issue(db, person.id, None, actor_id=actor)
    await db.commit()
    await db.refresh(second)
    assert second.revoked_at is None and general.initiative_id is None
    again, _, _ = await codes.issue(db, person.id, None, actor_id=actor)
    await db.commit()
    await db.refresh(general)
    assert general.revoked_at is not None and again.revoked_at is None


async def test_issue_retries_a_fingerprint_collision(db, monkeypatch):
    a, b = await _worker(db), await _worker(db, "Other")
    move = await _initiative(db)
    picks = iter(["AAAAAA", "AAAAAA", "BBBBBB"])
    monkeypatch.setattr(codes, "generate", lambda: next(picks))
    _, first, _ = await codes.issue(db, a.id, move.id, actor_id=None)
    await db.commit()
    row, second, _ = await codes.issue(db, b.id, move.id, actor_id=None)
    await db.commit()
    assert (first, second) == ("AAAAAA", "BBBBBB")
    assert row.fingerprint == codes.fingerprint("BBBBBB")


async def test_issue_gives_up_after_five_collisions(db, monkeypatch):
    a, b = await _worker(db), await _worker(db, "Other")
    move = await _initiative(db)
    monkeypatch.setattr(codes, "generate", lambda: "AAAAAA")
    await codes.issue(db, a.id, move.id, actor_id=None)
    await db.commit()
    with pytest.raises(codes.CodeCollision):
        await codes.issue(db, b.id, move.id, actor_id=None)


async def test_expiry_is_initiative_end_2359_in_site_zone(db):
    person = await _worker(db)
    chicago = await _initiative(db, zone="America/Chicago")
    row, _, _ = await codes.issue(db, person.id, chicago.id, actor_id=None)
    assert row.expires_at == datetime.combine(END, time(23, 59), tzinfo=ZoneInfo("America/Chicago"))
    # no site (or a zone this host doesn't know): UTC
    for move in (await _initiative(db), await _initiative(db, zone="Mars/Olympus")):
        row, _, _ = await codes.issue(db, person.id, move.id, actor_id=None)
        assert row.expires_at == datetime.combine(END, time(23, 59), tzinfo=UTC)
    # no end date: valid until revoked
    row, _, _ = await codes.issue(db, person.id, (await _initiative(db, end=None)).id, actor_id=None)
    assert row.expires_at is None


async def test_general_code_expiry_follows_setting(db):
    person = await _worker(db)
    row, _, _ = await codes.issue(db, person.id, None, actor_id=None)
    assert row.expires_at is None                       # general_code_days is null by default
    await db.commit()
    db.add(SystemConfig(section="learning", data={"general_code_days": 30}))
    await db.commit()
    before = datetime.now(UTC)
    row, _, _ = await codes.issue(db, person.id, None, actor_id=None)
    assert before + timedelta(days=30) <= row.expires_at <= datetime.now(UTC) + timedelta(days=30)


async def test_revoke(db):
    person = await _worker(db)
    row, _, _ = await codes.issue(db, person.id, None, actor_id=None)
    await db.commit()
    await codes.revoke(db, row.id, actor_id=person.id)
    await db.commit()
    stored = await db.scalar(select(LearningCode).where(LearningCode.id == row.id))
    await db.refresh(stored)
    assert stored.revoked_at is not None
