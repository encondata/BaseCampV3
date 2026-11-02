"""Who can see a thing (notifications/access.py). `viewers` has to make exactly the decision a
thing's own page makes, for people other than the one asking. So the equivalence tests here sign
real people in, ask the page (GET /initiatives, /sites or /trucks/{id}) and compare the people who
got a 200 with what `viewers` says for the same people.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (Anti-goals and section 4)"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.db.models import (
    Client,
    Initiative,
    Partner,
    PermissionOverride,
    Person,
    PersonRole,
    Site,
    Truck,
    UserAccount,
)
from serversherpa.notifications.access import VIEWABLE_THINGS, active_ids, thing_exists, viewers
from serversherpa.notifications.events import Thing
from tests.test_sites_api import make_login

PAGES = {"initiative": "/initiatives", "site": "/sites", "truck": "/trucks"}


@dataclass(frozen=True)
class Login:
    """A person who can sign in: their id and the auth header for page requests."""

    id: uuid.UUID
    headers: dict


async def _person(db, name, role=None, *, client_id=None, partner_id=None, view=None):
    """Person `name`, holding `role` (anchored to a client or a partner when one is given) and
    a view override for each resource in `view` ({resource: allow}). Committed, no account."""
    person = Person(first_name="Person", last_name=name, email=f"{name}@test.example.com")
    db.add(person)
    await db.flush()
    if role is not None:
        db.add(PersonRole(person_id=person.id, role=role, client_id=client_id,
                          partner_id=partner_id))
    for resource, allow in (view or {}).items():
        db.add(PermissionOverride(person_id=person.id, resource=resource, action="view",
                                  allow=allow))
    await db.commit()
    return person


async def _signed_in(db, client, name, role=None, **kwargs) -> Login:
    person = await _person(db, name, role, **kwargs)
    return Login(person.id, await make_login(db, client, person, person.email))


async def _people(db, client, client_a, client_b, partner) -> dict[str, Login]:
    """Everyone the equivalence tests ask, signed in. Most differ in one way, and sites and
    trucks each have a person denied just that one, so a mix-up between the resources shows."""
    people = {}
    for name, spec in {
        "admin": {"role": "admin"},
        "staff": {"role": "staff"},
        "client_a": {"role": "client_viewer", "client_id": client_a.id},
        "client_b": {"role": "client_viewer", "client_id": client_b.id},
        "partner": {"role": "vendor_viewer", "partner_id": partner.id},
        "worker": {"role": "worker"},
        "staff_denied_initiatives": {"role": "staff", "view": {"initiatives": False}},
        "staff_denied_sites": {"role": "staff", "view": {"sites": False}},
        "staff_denied_trucks": {"role": "staff", "view": {"trucks": False}},
        # Sites and trucks are global-only: no override opens them to a client's user.
        "client_a_granted": {"role": "client_viewer", "client_id": client_a.id,
                             "view": {"sites": True, "trucks": True}},
    }.items():
        people[name] = await _signed_in(db, client, name, **spec)
    return people


def _who(people, *names) -> set[uuid.UUID]:
    return {people[name].id for name in names}


async def _page_viewers(client, people, path) -> set[uuid.UUID]:
    """The people the page lets in: those whose GET of `path` answers 200. Everyone else must
    be refused outright (403 or 404), never met with an error."""
    seen = set()
    for login in people.values():
        status = (await client.get(path, headers=login.headers)).status_code
        assert status in (200, 403, 404), (path, status)
        if status == 200:
            seen.add(login.id)
    return seen


def _row(kind, name, **fields):
    """An unsaved initiative, site or truck."""
    if kind == "initiative":
        return Initiative(name=name, initiative_type="move", **fields)
    return {"site": Site, "truck": Truck}[kind](name=name, **fields)


async def _world(db):
    """Client A, Client B and Partner A, committed."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    partner = Partner(name="Partner A")
    db.add_all([client_a, client_b, partner])
    await db.commit()
    return client_a, client_b, partner


# ── the same answer as the page ─────────────────────────────────────

async def test_initiative_viewers_match_the_page(client, db):
    client_a, client_b, partner = await _world(db)
    initiative_a = _row("initiative", "Initiative A", client_id=client_a.id)
    initiative_b = _row("initiative", "Initiative B", client_id=client_b.id)
    no_client = _row("initiative", "Initiative C")
    db.add_all([initiative_a, initiative_b, no_client])
    await db.commit()
    people = await _people(db, client, client_a, client_b, partner)
    everyone = [login.id for login in people.values()]
    # Staff are global, so the denied-sites and denied-trucks ones still see initiatives.
    staff_side = ("admin", "staff", "staff_denied_sites", "staff_denied_trucks")

    for initiative, expected in (
        # a client's initiative: its own users and staff, not another client's, a partner's,
        # a worker or a staff member denied initiatives
        (initiative_a, staff_side + ("client_a", "client_a_granted")),
        (initiative_b, staff_side + ("client_b",)),
        # one with no client belongs to staff alone: both clients' users are out
        (no_client, staff_side),
    ):
        seen = await _page_viewers(client, people, f"/initiatives/{initiative.id}")
        assert seen == _who(people, *expected), initiative.name
        found = await viewers(db, Thing("initiative", initiative.id), everyone)
        assert found == seen, initiative.name


async def test_site_and_truck_viewers_match_the_pages(client, db):
    client_a, client_b, partner = await _world(db)
    site, truck = _row("site", "Site A"), _row("truck", "Truck A")
    db.add_all([site, truck])
    await db.commit()
    people = await _people(db, client, client_a, client_b, partner)
    everyone = [login.id for login in people.values()]

    for kind, row, expected in (
        ("site", site, ("admin", "staff", "staff_denied_initiatives", "staff_denied_trucks")),
        ("truck", truck, ("admin", "staff", "staff_denied_initiatives", "staff_denied_sites")),
    ):
        seen = await _page_viewers(client, people, f"{PAGES[kind]}/{row.id}")
        assert seen == _who(people, *expected), kind
        found = await viewers(db, Thing(kind, row.id), everyone)
        assert found == seen, kind


@pytest.mark.parametrize("kind", VIEWABLE_THINGS)
async def test_archived_things_stay_visible(client, db, kind):
    """The pages read an archived row like any other, so `viewers` does too."""
    admin = await _signed_in(db, client, "admin", "admin")
    row = _row(kind, "Thing A", archived_at=datetime.now(UTC))
    db.add(row)
    await db.commit()

    assert (await client.get(f"{PAGES[kind]}/{row.id}", headers=admin.headers)).status_code == 200
    assert await viewers(db, Thing(kind, row.id), [admin.id]) == {admin.id}


# ── a thing that is not there, and one that cannot be asked about ───

@pytest.mark.parametrize("kind", VIEWABLE_THINGS)
async def test_missing_thing_has_no_viewers(db, kind):
    admin = await _person(db, "admin", "admin")
    row = _row(kind, "Thing A")
    db.add(row)
    await db.commit()
    thing = Thing(kind, row.id)
    assert await viewers(db, thing, [admin.id]) == {admin.id}

    await db.delete(row)
    await db.commit()
    assert await viewers(db, thing, [admin.id]) == set()
    assert await viewers(db, Thing(kind, uuid.uuid4()), [admin.id]) == set()


@pytest.mark.parametrize("kind", VIEWABLE_THINGS)
async def test_thing_exists(db, kind):
    live = _row(kind, "Thing A")
    archived = _row(kind, "Thing B", archived_at=datetime.now(UTC))
    db.add_all([live, archived])
    await db.commit()

    assert await thing_exists(db, Thing(kind, live.id)) is True
    assert await thing_exists(db, Thing(kind, archived.id)) is True
    assert await thing_exists(db, Thing(kind, uuid.uuid4())) is False
    # another kind's id is not this kind's
    other = next(k for k in VIEWABLE_THINGS if k != kind)
    assert await thing_exists(db, Thing(other, live.id)) is False


def test_viewable_things():
    assert VIEWABLE_THINGS == ("initiative", "site", "truck")


@pytest.mark.parametrize("kind", ["everything", "device", "wiki", ""])
async def test_unknown_thing_type_raises(db, kind):
    thing = Thing(kind, uuid.uuid4())
    # even with nobody to ask about: a type nobody can answer for is a bug, not an empty answer
    with pytest.raises(ValueError, match="viewable"):
        await viewers(db, thing, [])
    with pytest.raises(ValueError, match="viewable"):
        await thing_exists(db, thing)


# ── who is still a person to tell ───────────────────────────────────

async def test_active_ids(db):
    now = datetime.now(UTC)
    active = Person(first_name="Person", last_name="A")
    disabled = Person(first_name="Person", last_name="B")
    archived = Person(first_name="Person", last_name="C", archived_at=now)
    no_account = Person(first_name="Person", last_name="D")
    db.add_all([active, disabled, archived, no_account])
    await db.flush()
    db.add_all([
        UserAccount(person_id=active.id, email="a@test.example.com"),
        UserAccount(person_id=disabled.id, email="b@test.example.com", disabled_at=now),
        UserAccount(person_id=archived.id, email="c@test.example.com"),
    ])
    await db.commit()

    ids = [active.id, disabled.id, archived.id, no_account.id, uuid.uuid4()]
    assert await active_ids(db, ids) == {active.id}
    # any iterable of ids, repeats included, and nobody to ask about
    assert await active_ids(db, iter([active.id, disabled.id, active.id])) == {active.id}
    assert await active_ids(db, []) == set()


# ── the access it is given ──────────────────────────────────────────

async def test_given_access_is_used(db, monkeypatch):
    admin = await _person(db, "admin", "admin")
    staff = await _person(db, "staff", "staff")
    nobody = await _person(db, "nobody")                     # no role at all
    initiative = _row("initiative", "Initiative A")
    db.add(initiative)
    await db.commit()
    thing = Thing("initiative", initiative.id)
    ids = [admin.id, staff.id, nobody.id]
    resolved = await resolve_access_many(db, ids)

    async def resolve_again(*args, **kwargs):
        raise RuntimeError("access was resolved again")

    monkeypatch.setattr("serversherpa.access.resolver.resolve_access_many", resolve_again)
    monkeypatch.setattr("serversherpa.notifications.access.resolve_access_many", resolve_again)

    # without `access` the stand-in is reached, so the patch sits on the path the call takes
    with pytest.raises(RuntimeError, match="resolved again"):
        await viewers(db, thing, ids)
    # with it the call answers, from what it was given and nothing else
    assert await viewers(db, thing, ids, access=resolved) == {admin.id, staff.id}
    # ...as it stands: the admin refused, the person with no role let in, staff left out
    as_given = {admin.id: AccessInfo(),
                nobody.id: AccessInfo(perms={"initiatives": {"view": True}}, is_global=True)}
    assert await viewers(db, thing, ids, access=as_given) == {nobody.id}


async def test_everyone_is_resolved_in_one_batch(db, monkeypatch):
    people = [await _person(db, name, "staff") for name in ("a", "b", "c")]
    initiative = _row("initiative", "Initiative A")
    db.add(initiative)
    await db.commit()
    asked = []

    async def spy(db, person_ids):
        asked.append(list(person_ids))
        return await resolve_access_many(db, asked[-1])

    monkeypatch.setattr("serversherpa.notifications.access.resolve_access_many", spy)
    ids = [person.id for person in people]
    # one call for everyone, each person once however often they are named
    assert await viewers(db, Thing("initiative", initiative.id), ids + ids[:1]) == set(ids)
    assert asked == [ids]
