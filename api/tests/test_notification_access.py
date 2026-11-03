"""Who can see a thing (notifications/access.py). `viewers` and `visible_among` have to make
exactly the decision a thing's own page makes, for people other than the one asking. So the
equivalence tests here sign real people in, ask the page (GET /initiatives, /sites, /trucks,
/devices, /assets, /containers or /workers/{id}) and compare the people who got a 200 with what
`viewers` says for the same people, and what each person got a 200 for with what `visible_among`
says for all the things at once.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (Anti-goals and section 4)"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, update
from sqlalchemy import event as sa_event

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.access.resources import REGISTRY
from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    Asset,
    Client,
    Container,
    Device,
    Initiative,
    Partner,
    PermissionOverride,
    Person,
    PersonRole,
    Site,
    Truck,
    UserAccount,
    WorkerProfile,
)
from serversherpa.notifications.access import (
    VIEWABLE_THINGS,
    active_ids,
    thing_exists,
    viewers,
    visible_among,
)
from serversherpa.notifications.events import Thing
from tests.test_sites_api import make_login

PAGES = {"initiative": "/initiatives", "site": "/sites", "truck": "/trucks",
         "device": "/devices", "asset": "/assets", "container": "/containers",
         "person": "/workers"}
# Devices are deleted outright, never archived.
ARCHIVABLE = tuple(kind for kind in VIEWABLE_THINGS if kind != "device")
# Each resource a page needs, and the staff member denied just its `view`.
DENIED = {"initiatives": "staff_denied_initiatives", "sites": "staff_denied_sites",
          "trucks": "staff_denied_trucks", "scanning_hardware": "staff_denied_hardware",
          "assets": "staff_denied_assets", "containers": "staff_denied_containers",
          "workers": "staff_denied_workers"}


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
    """Everyone the equivalence tests ask, signed in. Most differ in one way, and each resource
    a page needs has a staff member denied just that one, so a mix-up between the resources
    shows."""
    people = {}
    for name, spec in {
        "admin": {"role": "admin"},
        "staff": {"role": "staff"},
        "client_a": {"role": "client_viewer", "client_id": client_a.id},
        "client_b": {"role": "client_viewer", "client_id": client_b.id},
        "partner": {"role": "vendor_viewer", "partner_id": partner.id},
        # a partner's admin sees the workers that partner supplies, nothing else here
        "partner_admin": {"role": "vendor_admin", "partner_id": partner.id},
        "worker": {"role": "worker"},
        **{denied: {"role": "staff", "view": {resource: False}}
           for resource, denied in DENIED.items()},
        # Sites, trucks, devices and containers are global-only, and workers are not a client's:
        # no override opens them to a client's user.
        "client_a_granted": {"role": "client_viewer", "client_id": client_a.id,
                             "view": {"sites": True, "trucks": True,
                                      "scanning_hardware": True, "containers": True,
                                      "workers": True}},
    }.items():
        people[name] = await _signed_in(db, client, name, **spec)
    return people


def _staff_but(resource) -> tuple[str, ...]:
    """The global people who open a page that needs `resource`: everyone global but the staff
    member denied it."""
    return ("admin", "staff", *(denied for other, denied in DENIED.items() if other != resource))


def _who(people, *names) -> set[uuid.UUID]:
    return {people[name].id for name in names}


async def _page_viewers(client, people, path, refused=(403, 404)) -> set[uuid.UUID]:
    """The people the page lets in: those whose GET of `path` answers 200. Everyone else must
    be refused outright (403 or 404, or what else `refused` allows), never met with an
    error."""
    seen = set()
    for login in people.values():
        status = (await client.get(path, headers=login.headers)).status_code
        assert status == 200 or status in refused, (path, status)
        if status == 200:
            seen.add(login.id)
    return seen


async def _same_as_the_pages(client, db, people, kind, rows, refused=(403, 404)):
    """Each row's page lets in exactly the people `viewers` names for it, and `visible_among`,
    asked about all the rows at once, gives each person exactly the rows whose page let them
    in (and leaves out whoever got in nowhere). Returns each row's viewers, by row id."""
    everyone = [login.id for login in people.values()]
    by_row: dict[uuid.UUID, set[uuid.UUID]] = {}
    by_person: dict[uuid.UUID, set[uuid.UUID]] = {}
    for row in rows:
        seen = await _page_viewers(client, people, f"{PAGES[kind]}/{row.id}", refused)
        assert await viewers(db, Thing(kind, row.id), everyone) == seen, row.id
        by_row[row.id] = seen
        for person_id in seen:
            by_person.setdefault(person_id, set()).add(row.id)
    assert await visible_among(db, kind, [row.id for row in rows], everyone) == by_person
    return by_row


def _row(kind, name, **fields):
    """An unsaved initiative, site, truck, device (a fixed reader), asset (`name` is its serial
    number), container or person (save it with `_store`, which makes them a worker)."""
    if kind == "initiative":
        return Initiative(name=name, initiative_type="move", **fields)
    if kind == "device":
        return Device(device_type="fixed_reader", name=name, **fields)
    if kind == "asset":
        return Asset(serial_number=name, **fields)
    if kind == "person":
        return Person(first_name="Person", last_name=name, **fields)
    return {"site": Site, "truck": Truck, "container": Container}[kind](name=name, **fields)


async def _store(db, *rows) -> None:
    """Save the rows, committed. A person is given the worker role: a person's page is a
    worker's."""
    db.add_all(rows)
    await db.flush()
    db.add_all(PersonRole(person_id=row.id, role="worker") for row in rows
               if isinstance(row, Person))
    await db.commit()


async def _delete(db, row) -> None:
    """Delete the row, committed (a person's roles go first)."""
    if isinstance(row, Person):
        await db.execute(delete(PersonRole).where(PersonRole.person_id == row.id))
        await db.execute(delete(Person).where(Person.id == row.id))
    else:
        await db.delete(row)
    await db.commit()


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
    await _store(db, initiative_a, initiative_b, no_client)
    people = await _people(db, client, client_a, client_b, partner)
    # Staff are global, so the ones denied another resource still see initiatives.
    staff_side = _staff_but("initiatives")

    seen = await _same_as_the_pages(client, db, people, "initiative",
                                    [initiative_a, initiative_b, no_client])
    # a client's initiative: its own users and staff, not another client's, a partner's, a
    # worker or a staff member denied initiatives
    assert seen[initiative_a.id] == _who(people, *staff_side, "client_a", "client_a_granted")
    assert seen[initiative_b.id] == _who(people, *staff_side, "client_b")
    # one with no client belongs to staff alone: both clients' users are out
    assert seen[no_client.id] == _who(people, *staff_side)


async def test_site_and_truck_viewers_match_the_pages(client, db):
    client_a, client_b, partner = await _world(db)
    site, truck = _row("site", "Site A"), _row("truck", "Truck A")
    await _store(db, site, truck)
    people = await _people(db, client, client_a, client_b, partner)

    for kind, row, resource in (("site", site, "sites"), ("truck", truck, "trucks")):
        seen = await _same_as_the_pages(client, db, people, kind, [row])
        assert seen[row.id] == _who(people, *_staff_but(resource)), kind


async def test_device_viewers_match_the_page(client, db):
    """A device opens with `scanning_hardware:view` (the device lists and the kiosk page), global
    only. Everyone denied some other resource still opens it; the one denied just this one, and
    the client's user an override tries to let in, do not."""
    client_a, client_b, partner = await _world(db)
    device = _row("device", "Device A")
    await _store(db, device)
    people = await _people(db, client, client_a, client_b, partner)

    seen = await _same_as_the_pages(client, db, people, "device", [device])
    assert seen[device.id] == _who(people, *_staff_but("scanning_hardware"))


async def test_asset_viewers_match_the_page(client, db):
    """An asset opens with `assets:view` and, for a client's user, only when their client owns
    it (`GET /assets/{id}`: the scope probe on `Asset.client_id`). A partner's people and a
    worker can't open assets at all."""
    client_a, client_b, partner = await _world(db)
    asset_a = _row("asset", "SN-A", client_id=client_a.id)
    asset_b = _row("asset", "SN-B", client_id=client_b.id)
    no_client = _row("asset", "SN-C")
    await _store(db, asset_a, asset_b, no_client)
    people = await _people(db, client, client_a, client_b, partner)
    staff_side = _staff_but("assets")

    seen = await _same_as_the_pages(client, db, people, "asset", [asset_a, asset_b, no_client])
    assert seen[asset_a.id] == _who(people, *staff_side, "client_a", "client_a_granted")
    assert seen[asset_b.id] == _who(people, *staff_side, "client_b")
    # an asset no client owns is staff's alone
    assert seen[no_client.id] == _who(people, *staff_side)


async def test_container_viewers_match_the_page(client, db):
    """A container opens with `containers:view`, global only: the client's user an override
    tries to let in stays out."""
    client_a, client_b, partner = await _world(db)
    on_a_move = _row("initiative", "Initiative A", client_id=client_a.id)
    await _store(db, on_a_move)
    container = _row("container", "Container A", initiative_id=on_a_move.id)
    loose = _row("container", "Container B")
    await _store(db, container, loose)
    people = await _people(db, client, client_a, client_b, partner)

    seen = await _same_as_the_pages(client, db, people, "container", [container, loose])
    for row in (container, loose):
        assert seen[row.id] == _who(people, *_staff_but("containers")), row.name


async def test_worker_viewers_match_the_page(client, db):
    """A person's page is a worker's (`GET /workers/{id}`): `workers:view`, the person must hold
    the worker role (anyone else's page answers 422 `not_a_worker` to those who may look), and
    for anyone who isn't global, the scope probe on the worker's profile: a partner's people see
    the workers that partner supplies, a worker sees themselves."""
    client_a, client_b, partner = await _world(db)
    other_partner = Partner(name="Partner B")
    db.add(other_partner)
    await db.commit()
    people = await _people(db, client, client_a, client_b, partner)
    # the signed-in worker is one of Partner A's
    db.add(WorkerProfile(person_id=people["worker"].id, partner_id=partner.id))
    supplied_by_b = _row("person", "Worker B")
    no_profile = _row("person", "Worker C")
    await _store(db, supplied_by_b, no_profile)
    db.add(WorkerProfile(person_id=supplied_by_b.id, partner_id=other_partner.id))
    revoked = _row("person", "Worker D")
    await _store(db, revoked)
    db.add(WorkerProfile(person_id=revoked.id, partner_id=partner.id))
    await db.execute(update(PersonRole).where(PersonRole.person_id == revoked.id)
                     .values(revoked_at=datetime.now(UTC)))
    await db.commit()
    staff = await db.get(Person, people["staff"].id)      # not a worker at all
    staff_side = _staff_but("workers")

    seen = await _same_as_the_pages(
        client, db, people, "person",
        [await db.get(Person, people["worker"].id), supplied_by_b, no_profile, revoked, staff],
        refused=(403, 404, 422))
    assert seen[people["worker"].id] == _who(people, *staff_side, "partner_admin", "worker")
    assert seen[supplied_by_b.id] == _who(people, *staff_side)
    # with no profile, neither a partner nor the worker themself gets past the scope probe
    assert seen[no_profile.id] == _who(people, *staff_side)
    # a revoked worker role, and none at all, open nobody's page
    assert seen[revoked.id] == set()
    assert seen[staff.id] == set()


@pytest.mark.parametrize("kind", ARCHIVABLE)
async def test_archived_things_stay_visible(client, db, kind):
    """The pages read an archived row like any other, so `viewers` does too."""
    admin = await _signed_in(db, client, "admin", "admin")
    row = _row(kind, "Thing A", archived_at=datetime.now(UTC))
    await _store(db, row)

    assert (await client.get(f"{PAGES[kind]}/{row.id}", headers=admin.headers)).status_code == 200
    assert await viewers(db, Thing(kind, row.id), [admin.id]) == {admin.id}


# ── a thing that is not there, and one that cannot be asked about ───

@pytest.mark.parametrize("kind", VIEWABLE_THINGS)
async def test_missing_thing_has_no_viewers(db, kind):
    admin = await _person(db, "admin", "admin")
    row = _row(kind, "Thing A")
    await _store(db, row)
    thing = Thing(kind, row.id)
    assert await viewers(db, thing, [admin.id]) == {admin.id}

    await _delete(db, row)
    assert await viewers(db, thing, [admin.id]) == set()
    assert await viewers(db, Thing(kind, uuid.uuid4()), [admin.id]) == set()
    assert await visible_among(db, kind, [row.id, uuid.uuid4()], [admin.id]) == {}


@pytest.mark.parametrize("kind", VIEWABLE_THINGS)
async def test_thing_exists(db, kind):
    rows = [_row(kind, "Thing A")]
    if kind in ARCHIVABLE:                  # an archived row counts too
        rows.append(_row(kind, "Thing B", archived_at=datetime.now(UTC)))
    await _store(db, *rows)

    for row in rows:
        assert await thing_exists(db, Thing(kind, row.id)) is True
    assert await thing_exists(db, Thing(kind, uuid.uuid4())) is False
    # another kind's id is not this kind's
    other = next(k for k in VIEWABLE_THINGS if k != kind)
    assert await thing_exists(db, Thing(other, rows[0].id)) is False


async def test_a_person_who_is_no_worker_is_there_but_opens_for_nobody(db):
    """`thing_exists` asks for the row: the person is there. Their page is a worker's, so it
    opens for nobody."""
    admin = await _person(db, "admin", "admin")
    person = await _person(db, "Person B")
    thing = Thing("person", person.id)
    assert await thing_exists(db, thing) is True
    assert await viewers(db, thing, [admin.id]) == set()


def test_viewable_things():
    assert VIEWABLE_THINGS == ("initiative", "site", "truck", "device", "asset", "container",
                               "person")


@pytest.mark.parametrize("resource", ["sites", "trucks", "scanning_hardware", "containers"])
def test_global_only_resources_stay_global_only(resource):
    """`viewers` asks only for `sites:view`, `trucks:view`, (a device) `scanning_hardware:view` or
    `containers:view` and applies no row scope to any of them, because only a global person can
    hold them. Opening one of these resources to a client's or a partner's users would make
    `viewers` let in people the page turns away, so widening it has to fail here first."""
    assert REGISTRY[resource].visible_to == frozenset({"global"})


@pytest.mark.parametrize("kind", ["everything", "wiki_node", "wiki", ""])
async def test_unknown_thing_type_raises(db, kind):
    thing = Thing(kind, uuid.uuid4())
    # even with nobody to ask about: a type nobody can answer for is a bug, not an empty answer
    with pytest.raises(ValueError, match="viewable"):
        await viewers(db, thing, [])
    with pytest.raises(ValueError, match="viewable"):
        await thing_exists(db, thing)
    with pytest.raises(ValueError, match="viewable"):
        await visible_among(db, kind, [], [])


# ── many things at once ─────────────────────────────────────────────

async def _selects_during(work) -> list[str]:
    """Every SELECT the engine sends while `work()` runs."""
    sent: list[str] = []

    def spy(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            sent.append(statement)

    sync_engine = get_engine().sync_engine
    sa_event.listen(sync_engine, "before_cursor_execute", spy)
    try:
        await work()
    finally:
        sa_event.remove(sync_engine, "before_cursor_execute", spy)
    return sent


@pytest.mark.parametrize("many", [3, 60])
async def test_visible_among_costs_a_query_per_scoped_person_however_many_things(db, many):
    """The batch a status rule's notice needs: one query finds the things, one batch resolves
    everyone's access, and only people with row scope cost a query more each, for all the things
    at once. Global people cost none, and the number of things changes nothing."""
    client_a, client_b, _partner = await _world(db)
    assets = [_row("asset", f"SN-{i}", client_id=(client_a.id, client_b.id, None)[i % 3])
              for i in range(many)]
    await _store(db, *assets)
    admin = await _person(db, "admin", "admin")
    staff = await _person(db, "staff", "staff")
    viewer_a = await _person(db, "client_a", "client_viewer", client_id=client_a.id)
    viewer_b = await _person(db, "client_b", "client_viewer", client_id=client_b.id)
    worker = await _person(db, "worker", "worker")      # no assets:view: never probed
    ids = [asset.id for asset in assets]
    access = await resolve_access_many(
        db, [admin.id, staff.id, viewer_a.id, viewer_b.id, worker.id])
    found = {}

    async def ask():
        found.update(await visible_among(
            db, "asset", ids, [admin.id, staff.id, viewer_a.id, viewer_b.id, worker.id],
            access=access))

    sent = await _selects_during(ask)
    assert len(sent) == 3            # the things, then a probe each for the two client users
    assert found == {
        admin.id: set(ids), staff.id: set(ids),
        viewer_a.id: {asset.id for asset in assets if asset.client_id == client_a.id},
        viewer_b.id: {asset.id for asset in assets if asset.client_id == client_b.id}}


async def test_visible_among_takes_more_things_than_a_query_has_parameters(db):
    """A bulk update can match tens of thousands of rows in one batch: more ids than a single
    statement could bind one by one (asyncpg stops at 32,767)."""
    client_a, _client_b, _partner = await _world(db)
    mine, theirs = _row("asset", "SN-A", client_id=client_a.id), _row("asset", "SN-B")
    await _store(db, mine, theirs)
    admin = await _person(db, "admin", "admin")
    viewer = await _person(db, "client_a", "client_viewer", client_id=client_a.id)
    ids = [uuid.uuid4() for _ in range(40_000)] + [mine.id, theirs.id]

    assert await visible_among(db, "asset", ids, [admin.id, viewer.id]) == {
        admin.id: {mine.id, theirs.id}, viewer.id: {mine.id}}


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
    await _store(db, initiative)
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
    with pytest.raises(RuntimeError, match="resolved again"):
        await visible_among(db, "initiative", [initiative.id], ids)
    # with it the call answers, from what it was given and nothing else
    assert await viewers(db, thing, ids, access=resolved) == {admin.id, staff.id}
    # ...as it stands: the admin refused, the person with no role let in, staff left out
    as_given = {admin.id: AccessInfo(),
                nobody.id: AccessInfo(perms={"initiatives": {"view": True}}, is_global=True)}
    assert await viewers(db, thing, ids, access=as_given) == {nobody.id}
    assert await visible_among(db, "initiative", [initiative.id], ids, access=as_given) == {
        nobody.id: {initiative.id}}


async def test_everyone_is_resolved_in_one_batch(db, monkeypatch):
    people = [await _person(db, name, "staff") for name in ("a", "b", "c")]
    initiatives = [_row("initiative", "Initiative A"), _row("initiative", "Initiative B")]
    await _store(db, *initiatives)
    asked = []

    async def spy(db, person_ids):
        asked.append(list(person_ids))
        return await resolve_access_many(db, asked[-1])

    monkeypatch.setattr("serversherpa.notifications.access.resolve_access_many", spy)
    ids = [person.id for person in people]
    # one call for everyone, each person once however often they are named
    assert await viewers(db, Thing("initiative", initiatives[0].id), ids + ids[:1]) == set(ids)
    assert asked == [ids]
    # and for many things, still one
    both = {initiative.id for initiative in initiatives}
    assert await visible_among(db, "initiative", [*both, *both], ids + ids[:1]) == {
        person_id: both for person_id in ids}
    assert asked == [ids, ids]
