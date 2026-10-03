"""Admin inbox cards for password reset requests made while email is off:
fan-out to users:change holders, bump instead of duplicate, resolve on
reset (admin route or self-service)."""

from sqlalchemy import select

from serversherpa.db.models import Notification, UserAccount
from serversherpa.notifications import reset_requests

from tests.test_status_values_write import _make


async def _cards(db):
    db.expire_all()
    return list(await db.scalars(
        select(Notification).where(Notification.kind == reset_requests.KIND)))


async def test_open_fans_out_to_users_change_holders_only(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await _make(db, client, "worker", "st@test.example.com")  # worker lacks users:change (staff holds it, so it can't be the non-holder)
    n = await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    cards = await _cards(db)
    await db.refresh(seeded_user)
    assert n == len(cards) >= 1
    sa = await db.scalar(select(UserAccount).where(UserAccount.email == "sa@test.example.com"))
    st = await db.scalar(select(UserAccount).where(UserAccount.email == "st@test.example.com"))
    owners = {c.person_id for c in cards}
    assert sa.person_id in owners and st.person_id not in owners
    assert seeded_user.id not in owners
    card = cards[0]
    assert card.title == "Alice Anderson asked for a password reset"
    assert card.link == f"/people/users/{seeded_user.id}"
    assert card.payload["state"] == "open" and card.payload["count"] == 1
    assert "alice@test.example.com" not in (card.title + card.body + str(card.payload))


async def test_second_request_bumps_instead_of_duplicating(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    first = await _cards(db)
    await db.refresh(seeded_user)
    for c in first:
        c.read_at = c.created_at
    await db.commit()
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    again = await _cards(db)
    assert len(again) == len(first)
    assert all(c.payload["count"] == 2 and c.read_at is None for c in again)


async def test_resolve_marks_every_copy(client, db, seeded_user):
    await _make(db, client, "super_admin", "sa@test.example.com")
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    pid = seeded_user.id
    await reset_requests.resolve(db, pid, "Sam Admin")
    await db.commit()
    cards = await _cards(db)
    assert all(c.payload["state"] == "resolved" and c.payload["resolved_by"] == "Sam Admin"
               for c in cards)
    # a later request opens a fresh card rather than bumping a resolved one
    await db.refresh(seeded_user)
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    assert len([c for c in await _cards(db) if c.payload["state"] == "open"]) >= 1


async def test_admin_reset_route_resolves_cards(client, db, seeded_user):
    hdrs = await _make(db, client, "super_admin", "sa@test.example.com")
    await reset_requests.open_or_bump(db, seeded_user)
    await db.commit()
    resp = await client.post(f"/users/{seeded_user.id}/reset-password", headers=hdrs,
                             json={"temp_password": "TempPassw0rd!x", "must_change_password": True})
    assert resp.status_code == 204, resp.text
    cards = await _cards(db)
    assert cards and all(c.payload["state"] == "resolved" for c in cards)
    assert all(c.payload["resolved_by"] == "R X" for c in cards)   # _make's name
