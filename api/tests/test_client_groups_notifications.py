"""Client groups: notifications and asset watches never carry a hidden asset
to a restricted client login. The fixture's four Acme roster rows are owned
"Platform", "storage ", blank and "Platfrom" (unmatched), so a viewer chipped
Platform sees sn-0 and sn-2, an individual chipped Storage sees sn-1 only,
and an unchipped viewer or an owner sees all four.

- `visible_among("asset", …)`, the test every notice asks, follows the
  asset rule;
- a status rule's notice names only the matched assets each person sees;
- a watch can't be set, listed or fired on a hidden asset, and a watch set
  on a move follows that move's row rule (spec item 12);
- an `asset_watch` email, queued or held, is re-checked at send time, so a
  watch that fired before chips narrowed doesn't send a hidden serial.

Spec: docs/superpowers/specs/2026-11-10-client-groups-design.md (Surfaces
that must apply the rule, items 8 and 12)"""
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from serversherpa.clientgroups import service as cg
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    AssetWatch,
    ClientContactGroup,
    EmailOutbox,
    Initiative,
    InitiativeAsset,
    Site,
)
from serversherpa.notifications.access import visible_among
from serversherpa.notifications.asset_watch_check import run_asset_watches_once
from serversherpa.notifications.asset_watches import add_asset_watch
from serversherpa.notifications.summary import run_summaries_once
from serversherpa.status_rules.engine import invalidate_cache
from tests.client_groups_fixtures import client_user, seed_grouped_client
from tests.test_mail_delivery import _run
from tests.test_notification_event_sweep import _notifications, _person, _sweep
from tests.test_status_rule_notify import _add_rule, _match, _notify
from tests.test_watch_recheck import (
    EVENING,
    MORNING,
    QUIET,
    _held,
    _recheck,
    _skipped,
    clock,  # noqa: F401 (fixture)
)

NOW = datetime(2026, 11, 10, 20, 5, tzinfo=UTC)
WATCHES = "/auth/me/asset-watches"


@pytest.fixture(autouse=True)
def _fresh_rules():
    invalidate_cache()
    yield
    invalidate_cache()


async def _chip(db, person, s, *names) -> None:
    for name in names:
        db.add(ClientContactGroup(person_id=person.id, client_id=s.client.id,
                                  group_id=s.groups[name].id))
    await db.commit()


async def _world(db):
    """The grouped client, rows matched, and four people with accounts in use:
    `plat` (viewer chipped Platform), `ind` (individual chipped Storage),
    `viewer` (unchipped) and `owner`."""
    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    s.plat = await _person(db, "Plat", role="client_viewer", client_id=s.client.id)
    await _chip(db, s.plat, s, "Platform")
    s.ind = await _person(db, "Ind", role="client_individual", client_id=s.client.id)
    await _chip(db, s.ind, s, "Storage")
    s.viewer = await _person(db, "Viewer", role="client_viewer", client_id=s.client.id)
    s.owner = await _person(db, "Owner", role="client_owner", client_id=s.client.id)
    return s


def _serials(s, ids) -> set[str]:
    return {a.serial_number for a in s.assets if a.id in ids}


async def _mails(person) -> list[EmailOutbox]:
    async with get_sessionmaker()() as session:
        return list(await session.scalars(select(EmailOutbox).where(
            EmailOutbox.person_id == person.id).order_by(EmailOutbox.created_at)))


async def _change(asset, **values) -> None:
    await _run(update(Asset).where(Asset.id == asset.id).values(**values))


async def _check() -> int:
    return await run_asset_watches_once(get_sessionmaker(), now=NOW)


async def _arm(db, person, asset, initiative=None) -> AssetWatch:
    watch = await add_asset_watch(
        db, person.id, asset_id=asset.id,
        initiative_id=initiative.id if initiative is not None else None,
        condition="next_update", status=None)
    await db.commit()
    return watch


# ── the test every notice asks ──────────────────────────────────────

async def test_visible_among_assets_follows_groups(db):
    s = await _world(db)
    ids = [a.id for a in s.assets]
    seen = await visible_among(db, "asset", ids, [s.plat.id, s.ind.id, s.viewer.id,
                                                  s.owner.id])
    assert _serials(s, seen[s.plat.id]) == {"sn-0", "sn-2"}
    assert _serials(s, seen[s.ind.id]) == {"sn-1"}
    assert _serials(s, seen[s.viewer.id]) == {"sn-0", "sn-1", "sn-2", "sn-3"}
    assert _serials(s, seen[s.owner.id]) == {"sn-0", "sn-1", "sn-2", "sn-3"}


# ── status rule notices ─────────────────────────────────────────────

async def test_status_rule_notice_skips_hidden_asset(db):
    """A rule naming four people matches Storage's sn-1: the Platform viewer
    hears nothing; the others hear of it. Then sn-0, sn-2 and sn-3 match in
    one batch: each hears only of what they see, counted, and Storage's
    individual, who sees none of them, hears nothing."""
    s = await _world(db)
    site = Site(name="Site A")
    db.add(site)
    await db.commit()
    people = [s.plat, s.ind, s.viewer, s.owner]
    await _add_rule(db, "Rule A", _notify(people=[p.id for p in people]))
    await _match(db, asset=s.assets[1].id, site=site.id)
    await db.commit()
    assert await _sweep() == 3
    assert await _notifications(s.plat) == []
    for person in (s.ind, s.viewer, s.owner):
        [note] = await _notifications(person)
        assert note.title == "Rule A: sn-1", person.last_name

    for i in (0, 2, 3):
        await _match(db, asset=s.assets[i].id, site=site.id)
    await db.commit()
    assert await _sweep() == 3
    titles = {p.last_name: (await _notifications(p))[-1].title for p in people}
    assert titles == {"Plat": "Rule A (2)", "Ind": "Rule A: sn-1", "Viewer": "Rule A (3)",
                      "Owner": "Rule A (3)"}
    assert len(await _notifications(s.ind)) == 1         # sees none of the batch


# ── setting and listing watches ─────────────────────────────────────

async def test_cannot_watch_hidden_asset(client, seeded_user, db):
    """A hidden asset is 404 to watch, on its own or on the move, exactly as
    one that isn't there; a visible one is watched as before."""
    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    h = await client_user(db, client, s.client.id, "client_viewer",
                          [s.groups["Platform"].id], email="cg-plat@test.example.com")

    def post(asset, initiative=None):
        return client.post(WATCHES, headers=h, json={
            "asset_id": str(asset.id),
            "initiative_id": str(initiative.id) if initiative is not None else None,
            "condition": "next_update", "status": None})

    for asset in (s.assets[1], s.assets[3]):
        for place in (None, s.move):
            r = await post(asset, place)
            assert r.status_code == 404, (asset.serial_number, place, r.text)
            assert r.json()["detail"]["code"] == "thing_not_found"
    for asset in (s.assets[0], s.assets[2]):
        for place in (None, s.move):
            r = await post(asset, place)
            assert r.status_code == 201, (asset.serial_number, place, r.text)
    r = await client.get(WATCHES, headers=h)
    assert sorted(w["asset_name"] for w in r.json()) == ["sn-0", "sn-0", "sn-2", "sn-2"]
    r = await client.get(f"{WATCHES}/state", headers=h,
                         params={"asset_id": str(s.assets[1].id)})
    assert r.json() == {"watching": False, "watch": None}


async def test_watches_listed_only_while_visible(client, seeded_user, db):
    """An unchipped viewer's watches on sn-0 (Platform) stop being listed
    once they are chipped Storage, and come back with the chip removed."""
    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    h = await client_user(db, client, s.client.id, "client_viewer",
                          email="cg-viewer@test.example.com")
    for place in (None, str(s.move.id)):
        r = await client.post(WATCHES, headers=h, json={
            "asset_id": str(s.assets[0].id), "initiative_id": place,
            "condition": "next_update", "status": None})
        assert r.status_code == 201, r.text
    me = (await client.get("/auth/me", headers=h)).json()["person"]["id"]
    db.add(ClientContactGroup(person_id=me, client_id=s.client.id,
                              group_id=s.groups["Storage"].id))
    await db.commit()
    assert (await client.get(WATCHES, headers=h)).json() == []
    await _run(ClientContactGroup.__table__.delete().where(
        ClientContactGroup.person_id == me))
    assert len((await client.get(WATCHES, headers=h)).json()) == 2


async def test_watch_on_move_uses_the_move_row_rule(db):
    """sn-0's newest Acme row is Platform's, so the asset rule hides it from
    Storage's individual; but on an older Acme move its row is Storage's,
    and a watch set there follows that move's row rule (spec item 12)."""
    s = await _world(db)
    old = Initiative(name="Acme old move", initiative_type="move", sub_type="migration",
                     client_id=s.client.id)
    db.add(old)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=old.id, asset_id=s.assets[0].id, owner="Storage",
                           created_at=datetime.now(UTC) - timedelta(days=30)))
    await db.commit()
    await cg.rematch_client(db, s.client.id)
    await db.commit()

    from serversherpa.notifications.asset_watches import AssetWatchError
    for place in (None, s.move):
        with pytest.raises(AssetWatchError) as exc:
            await add_asset_watch(db, s.ind.id, asset_id=s.assets[0].id,
                                  initiative_id=place.id if place else None,
                                  condition="next_update", status=None)
        assert exc.value.code == "thing_not_found"
    on_old = await _arm(db, s.ind, s.assets[0], old)
    # the Platform viewer is the other way round: sn-0 on its own and on the
    # new move, never on the old move's Storage row
    await _arm(db, s.plat, s.assets[0])
    await _arm(db, s.plat, s.assets[0], s.move)
    with pytest.raises(AssetWatchError):
        await add_asset_watch(db, s.plat.id, asset_id=s.assets[0].id, initiative_id=old.id,
                              condition="next_update", status=None)

    await _change(s.assets[0], location_detail="Dock 2")
    assert await _check() == 3
    [note] = await _notifications(s.ind)
    assert note.kind == "asset_watch" and note.title.startswith("sn-0")
    assert note.payload == {"asset_id": str(s.assets[0].id),
                            "initiative_id": str(old.id)}
    assert on_old.id not in set(await db.scalars(select(AssetWatch.id)))
    assert len(await _notifications(s.plat)) == 2


# ── firing and the email re-check ───────────────────────────────────

async def test_asset_watch_email_rechecked_after_chips_narrow(db, email_on):
    """Set as an unchipped viewer, then the viewer is chipped Storage:

    - watches that fired before the chip (sn-0 on its own and on the move)
      had their emails queued; at send time they are dropped `no_access`,
      while the owner's email about the same asset still goes;
    - a watch on Platform's asset that fires after the chip ends without a
      notice and without an email."""
    s = await _world(db)
    await _arm(db, s.viewer, s.assets[0])
    await _arm(db, s.viewer, s.assets[0], s.move)
    late = await _arm(db, s.viewer, s.assets[3])
    await _arm(db, s.owner, s.assets[0])
    await _change(s.assets[0], location_detail="Dock 2")
    assert await _check() == 3
    mails = await _mails(s.viewer)
    assert len(mails) == 2 and all(m.kind == "asset_watch" for m in mails)
    for mail in mails:
        assert await _recheck(mail) is None
    [owner_mail] = await _mails(s.owner)

    await _chip(db, s.viewer, s, "Storage")
    for mail in mails:
        assert await _recheck(mail) == "no_access"
    assert await _recheck(owner_mail) is None

    await _change(s.assets[3], location_detail="Dock 3")
    assert await _check() == 1
    assert late.id not in set(await db.scalars(select(AssetWatch.id)))
    assert len(await _notifications(s.viewer)) == 2
    assert len(await _mails(s.viewer)) == 2


async def test_held_asset_watch_email_dropped_after_chips_narrow(db, email_on, clock):  # noqa: F811
    """The same for an email held for the summary: once chips narrow, the
    summary drops it `no_access` and sends nothing."""
    s = await _world(db)
    quiet = await _person(db, "Quiet", role="client_viewer", client_id=s.client.id,
                          prefs=QUIET)
    await _arm(db, quiet, s.assets[0])
    clock(EVENING)
    await _change(s.assets[0], location_detail="Dock 2")
    assert await _check() == 1
    [held] = await _held()
    assert (held.person_id, held.kind) == (quiet.id, "asset_watch")

    await _chip(db, quiet, s, "Storage")
    clock(MORNING)
    assert await run_summaries_once(get_sessionmaker(), now=MORNING) == 0
    assert await _held() == []
    assert await _mails(quiet) == []
    [dropped] = await _skipped()
    assert (dropped.person_id, dropped.notification_id, dropped.reason) == (
        quiet.id, held.notification_id, "no_access")
