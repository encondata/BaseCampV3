"""PortalClient's Create-a-move-in-steps calls, the site list and the move PATCH,
against the fake (which copies api/routes/move_setup.py and friends)."""

import pytest
from conftest import FAKE_BASE_URL

from loadtest.client.portal import PortalClient, SiteChoice
from loadtest.http import CallFailed

EMAIL = "ops@example.com"
PASSWORD = "portal-pass-1"
CSV = (b"Serial Number,Asset Name,Asset Make,Asset Model\n"
       b"LTAB000100001,lt-ab0001-00001,Dell,PowerEdge R640\n"
       b"LTAB000100002,lt-ab0001-00002,Dell,PowerEdge R640\n")
CRATES = {"convention": "CRT-AB0001-xxx", "count": 1, "start": 1,
          "container_type": "pelican_case"}
TRUCKS = {"convention": "TRK-AB0001-xx", "count": 1, "start": 1}


@pytest.fixture
async def portal(fake, clock, metrics, retry):
    made: list[PortalClient] = []

    async def make(**user):
        fake.add_portal_user(EMAIL, PASSWORD, **user)
        p = PortalClient(base_url=FAKE_BASE_URL, metrics=metrics, clock=clock, retry=retry,
                         timeout=10.0, transport=fake.transport())
        made.append(p)
        assert await clock.run(p.login(EMAIL, PASSWORD)) == "ok"
        return p

    yield make
    for p in made:
        await p.close()


def sites(fake):
    return (fake.add_site("Kansas City DC", code="KC"),
            fake.add_site("Dallas DC", code="DAL", lat=32.7767, lng=-96.797))


def count(fake, method, path):
    return sum(1 for r in fake.requests if r == (method, path))


async def test_sites_lists_every_site_with_its_code_and_location(fake, clock, portal):
    kc, dal = sites(fake)
    bare = fake.add_site("Site 10", lat=None, lng=None)
    two = fake.add_site("Site 2")
    p = await portal()
    got = await clock.run(p.sites())
    assert got == [
        SiteChoice(dal, "Dallas DC", "DAL", 32.7767, -96.797),
        SiteChoice(kc, "Kansas City DC", "KC", 39.0997, -94.5786),
        SiteChoice(two, "Site 2", None, 39.0997, -94.5786),
        SiteChoice(bare, "Site 10", None, None, None),
    ]


async def test_the_six_calls_make_a_move(fake, clock, portal):
    kc, dal = sites(fake)
    p = await portal()
    draft = await clock.run(p.start_move_draft("Load test AB0001", kc, dal))
    assert fake.import_jobs[draft]["status"] == "preview"
    await clock.run(p.upload_move_assets(draft, "from-to-AB0001.csv", CSV))
    assert (await clock.run(p.move_assets_check(draft)))["status"] == "queued"
    fake.process_jobs()
    check = await clock.run(p.move_assets_check(draft))
    assert check["status"] == "completed"
    assert check["results"]["summary"]["errors"] == 0
    await clock.run(p.set_move_crates_trucks(draft, CRATES, TRUCKS))
    await clock.run(p.queue_move_create(draft))
    assert (await clock.run(p.move_draft(draft)))["status"] == "queued"
    fake.process_jobs()
    assert (await clock.run(p.move_draft(draft)))["status"] == "running"
    fake.process_jobs()
    job = await clock.run(p.move_draft(draft))
    assert job["status"] == "completed"
    move_id = job["initiative_id"]
    assert len(await clock.run(p.roster(move_id))) == 2
    assert [c.name for c in await clock.run(p.containers(move_id))] == ["CRT-AB0001-001"]
    assert [t.name for t in await clock.run(p.trucks(move_id))] == ["TRK-AB0001-01"]
    await clock.run(p.activate_move(move_id, "  good-move-pass  "))
    move = fake.moves[move_id]
    assert (move["status"], move["password"]) == ("in_progress", "good-move-pass")


async def test_the_draft_is_never_resent(fake, clock, portal):
    kc, dal = sites(fake)
    p = await portal()
    fake.fail("POST", "/bulk/move-setup", status=503, after_effect=True)
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.start_move_draft("Load test", kc, dal))
    assert caught.value.status == 503
    assert count(fake, "POST", "/bulk/move-setup") == 1


async def test_a_lost_create_answer_is_not_a_failure(fake, clock, portal):
    """The create landed and only its answer was lost: the resend finds the draft no
    longer editable (409 draft_not_editable), which means the create is under way."""
    kc, dal = sites(fake)
    p = await portal()
    draft = await clock.run(p.start_move_draft("Load test", kc, dal))
    fake.fail("POST", f"/bulk/move-setup/{draft}/create", status=503, after_effect=True)
    await clock.run(p.queue_move_create(draft))
    assert count(fake, "POST", f"/bulk/move-setup/{draft}/create") == 2
    assert fake.import_jobs[draft]["status"] == "queued"


async def test_a_first_create_on_a_busy_draft_is_refused(fake, clock, portal):
    kc, dal = sites(fake)
    p = await portal()
    draft = await clock.run(p.start_move_draft("Load test", kc, dal))
    await clock.run(p.queue_move_create(draft))
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.queue_move_create(draft))
    assert (caught.value.status, caught.value.code) == (409, "draft_not_editable")


async def test_refusals_carry_the_servers_sentences(fake, clock, portal):
    kc, dal = sites(fake)
    p = await portal()
    draft = await clock.run(p.start_move_draft("Load test", kc, dal))
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.set_move_crates_trucks(draft, {**CRATES, "count": 501}, TRUCKS))
    assert caught.value.code == "invalid_naming"
    assert caught.value.detail["message"] == "The count must be between 0 and 500."
    assert "500" not in str(caught.value) and "500" not in repr(caught.value)


async def test_the_wizard_is_for_admins_only(fake, clock, portal):
    kc, dal = sites(fake)
    p = await portal(rank=50)
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.start_move_draft("Load test", kc, dal))
    assert (caught.value.status, caught.value.code) == (403, "forbidden")


async def test_the_move_password_rules_are_the_servers(fake, clock, portal):
    other = fake.add_move(servers=1, containers=1, trucks=1, password="taken-pass-1")
    move_id = fake.add_move(servers=1, containers=1, trucks=1, status="planned", password=None)
    p = await portal()
    for password, code in (("short", "kiosk_password_too_short"),
                           ("x Load test move 2 x", "kiosk_password_contains_name"),
                           ("taken-pass-1", "kiosk_password_in_use")):
        with pytest.raises(CallFailed) as caught:
            await clock.run(p.activate_move(move_id, password))
        assert (caught.value.status, caught.value.code) == (422, code)
    # a refused password changes nothing, the status included
    assert fake.moves[move_id]["status"] == "planned"
    assert other
