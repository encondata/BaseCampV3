"""setup.py: the generated From-To, the input checks and the six server steps."""

import csv
import io
import random

import pytest
from conftest import FAKE_BASE_URL

from loadtest.client.kiosk import KioskDevice
from loadtest.metrics import Metrics

from loadtest.client.portal import PortalClient, SiteChoice
from loadtest.connection import RunnerError
from loadtest.profile import RetrySpec
from loadtest.setup import (
    CONTAINER_TYPE,
    HEADERS,
    STALL_SECONDS,
    Plan,
    Setup,
    check_inputs,
    from_to_csv,
    make_tag,
    rack_units,
)

EMAIL = "ops@example.com"
PASSWORD = "portal-pass-1"
MOVE_PASSWORD = "fresh-move-pass-7"
SIZES = {"container_size": 20, "containers_per_truck": 15}
KC = SiteChoice("s-kc", "Kansas City DC", "KC", 39.1, -94.6)
DAL = SiteChoice("s-dal", "Dallas DC", "DAL", 32.8, -96.8)
NOWHERE = SiteChoice("s-x", "Warehouse", None, None, None)


def rows(content: bytes) -> list[dict]:
    return list(csv.DictReader(io.StringIO(content.decode())))


# ── the From-To ────────────────────────────────────────────────────────


def test_rack_units_are_two_then_a_gap_up_to_35():
    assert rack_units() == [1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23, 25, 26,
                            28, 29, 31, 32, 34, 35]


def test_the_tag_is_six_upper_case_hex_characters():
    tag = make_tag(random.Random(3))
    assert len(tag) == 6 and tag == tag.upper()
    int(tag, 16)


def test_from_to_has_the_move_assets_columns_and_one_row_per_server():
    plan = Plan("Move", KC, DAL, servers=50, containers=3, trucks=1, tag="A1B2C3")
    got = rows(from_to_csv(plan))
    assert list(got[0]) == HEADERS and len(HEADERS) == 25
    assert len(got) == 50
    first, last = got[0], got[49]
    assert first["Serial Number"] == "LTA1B2C300001"
    assert first["Asset Name"] == "lt-a1b2c3-00001"
    assert first["RFID Tag"] == ""
    assert (first["Asset Make"], first["Asset Model"]) == ("Dell", "PowerEdge R640")
    assert (first["Source Rack"], first["Source RU"]) == ("KC-R001", "1")
    assert (first["Destination Rack"], first["Destination RU"]) == ("DAL-R001", "1")
    rack2 = got[24]
    assert (rack2["Source Rack"], rack2["Source RU"], rack2["Asset Make"],
            rack2["Asset Model"]) == ("KC-R002", "1", "HPE", "ProLiant DL360 Gen11")
    assert got[23]["Source RU"] == "35"
    assert last["Serial Number"] == "LTA1B2C300050"
    assert (last["Source Rack"], last["Asset Make"]) == ("KC-R003", "Dell")
    assert all(r["Source RU"] == r["Destination RU"] for r in got)


def test_sites_without_a_code_use_src_and_dst():
    plan = Plan("Move", NOWHERE, SiteChoice("d", "D", "", 1.0, 1.0), 1, 1, 1, "ABCDEF")
    row = rows(from_to_csv(plan))[0]
    assert (row["Source Rack"], row["Destination Rack"]) == ("SRC-R001", "DST-R001")


# ── the inputs ─────────────────────────────────────────────────────────


def check(**overrides):
    args = {"sites": [KC, DAL, NOWHERE], "name": "Move", "origin_site_id": "s-kc",
            "destination_site_id": "s-dal", "servers": 45, "containers": 3, "trucks": 1,
            "sizes": SIZES}
    args.update(overrides)
    return check_inputs(**args)


def test_good_inputs_make_a_plan():
    plan = check(containers=5, trucks=2)
    assert (plan.origin, plan.destination, plan.servers, plan.containers, plan.trucks) == (
        KC, DAL, 45, 5, 2)
    assert len(plan.tag) == 6


@pytest.mark.parametrize("overrides,fields,words", [
    ({"containers": 2}, ["containers"], "45 servers need at least 3 containers"),
    ({"servers": 301, "containers": 16, "trucks": 1}, ["trucks"],
     "16 containers need at least 2 trucks"),
    ({"destination_site_id": "s-kc"}, ["origin_site_id", "destination_site_id"],
     "different sites"),
    ({"origin_site_id": "s-x"}, ["origin_site_id"], "Warehouse has no latitude and longitude"),
    ({"destination_site_id": "gone"}, ["destination_site_id"], "is not on the server"),
])
def test_bad_inputs_are_refused_with_their_fields(overrides, fields, words):
    with pytest.raises(RunnerError) as caught:
        check(**overrides)
    assert caught.value.fields == fields
    assert words in caught.value.message


def test_every_problem_is_named_at_once():
    with pytest.raises(RunnerError) as caught:
        check(origin_site_id="s-x", containers=1, trucks=0)
    assert caught.value.fields == ["origin_site_id", "containers", "trucks"]


def test_without_the_profile_sizes_nothing_starts():
    with pytest.raises(RunnerError) as caught:
        check(sizes=None)
    assert caught.value.code == "bad_profile"


# ── the six steps on the fake ──────────────────────────────────────────


@pytest.fixture
async def portal(fake, clock, metrics, retry):
    fake.add_portal_user(EMAIL, PASSWORD)
    p = PortalClient(base_url=FAKE_BASE_URL, metrics=metrics, clock=clock, retry=retry,
                     timeout=10.0, transport=fake.transport())
    assert await clock.run(p.login(EMAIL, PASSWORD)) == "ok"
    yield p
    await p.close()


def plan_on(fake, servers=45, containers=3, trucks=1, name="Load test move AB"):
    kc = fake.add_site("Kansas City DC", code="KC")
    dal = fake.add_site("Dallas DC", code="DAL", lat=32.8, lng=-96.8)
    return Plan(name, SiteChoice(kc, "Kansas City DC", "KC", 39.1, -94.6),
                SiteChoice(dal, "Dallas DC", "DAL", 32.8, -96.8), servers, containers, trucks,
                "AB12CD")


async def run_setup(fake, clock, portal, plan, *, password=MOVE_PASSWORD, worker=True,
                    limit=None, setup=None):
    setup = setup or Setup(clock)
    done: list[str] = []
    seen: list[str] = []

    async def on_done(move_id: str, ready: bool) -> None:
        done.append((move_id, ready))

    async def tick():
        while setup.working:
            seen.append(setup.snapshot()["step"])
            if worker:
                fake.process_jobs()
            await clock.sleep(0.5)

    setup.start(portal, plan, password, on_done=on_done)
    import asyncio
    ticker = asyncio.ensure_future(tick())
    try:
        await clock.run(setup.wait(), limit=limit)
    finally:
        ticker.cancel()
        await asyncio.gather(ticker, return_exceptions=True)
    return setup, done, seen


async def test_the_move_is_made_in_progress_with_its_password(fake, clock, portal):
    plan = plan_on(fake)
    setup, done, seen = await run_setup(fake, clock, portal, plan)
    view = setup.snapshot()
    assert view["state"] == "done", view
    move_id = view["move_id"]
    assert done == [(move_id, True)]
    assert view == {"state": "done", "step": "done", "step_label": "The move is ready",
                    "message": "", "move_id": move_id, "name": "Load test move AB",
                    "servers": 45, "containers": 3, "trucks": 1}
    move = fake.moves[move_id]
    assert (move["name"], move["status"], move["password"]) == (
        "Load test move AB", "in_progress", MOVE_PASSWORD)
    assert (move["origin_site_id"], move["destination_site_id"]) == (plan.origin.id,
                                                                     plan.destination.id)
    serials = sorted(a["serial_number"] for a in fake.assets.values()
                     if a["initiative_id"] == move_id)
    assert serials[0] == "LTAB12CD00001" and len(serials) == 45
    crates = sorted(c["name"] for c in fake.containers.values()
                    if c["initiative_id"] == move_id)
    assert crates == ["CRT-AB12CD-001", "CRT-AB12CD-002", "CRT-AB12CD-003"]
    assert {c["container_type"] for c in fake.containers.values()} == {CONTAINER_TYPE}
    assert [t["name"] for t in fake.trucks.values()] == ["TRK-AB12CD-01"]
    for step in ("assets", "create"):
        assert step in seen
    assert MOVE_PASSWORD not in repr(setup.snapshot()) and MOVE_PASSWORD not in repr(setup)


async def test_a_refused_draft_says_nothing_was_created(fake, clock, portal):
    plan = plan_on(fake)
    fake.portal_users[EMAIL].rank = 40
    setup, done, _ = await run_setup(fake, clock, portal, plan)
    view = setup.snapshot()
    assert (view["state"], view["step"], view["move_id"]) == ("error", "draft", None)
    assert "not allowed" in view["message"] and "Nothing was created" in view["message"]
    assert done == [] and len(fake.moves) == 0


async def test_too_many_crates_is_the_servers_refusal(fake, clock, portal):
    plan = plan_on(fake, servers=45, containers=501)
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    view = setup.snapshot()
    assert (view["state"], view["step"]) == ("error", "crates_trucks")
    assert "The count must be between 0 and 500." in view["message"]
    assert "No move was created" in view["message"]


async def test_a_create_the_worker_fails_names_its_reasons(fake, clock, portal):
    plan = plan_on(fake)
    fake.add_move(servers=1, containers=0, trucks=1)
    next(iter(fake.trucks.values()))["name"] = "TRK-AB12CD-01"     # taken after the check
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    view = setup.snapshot()
    assert (view["state"], view["step"]) == ("error", "create")
    assert "These truck names already exist: TRK-AB12CD-01." in view["message"]


async def test_a_weak_password_leaves_the_move_made_but_not_in_progress(fake, clock, portal):
    plan = plan_on(fake)
    setup, done, _ = await run_setup(fake, clock, portal, plan, password="short")
    view = setup.snapshot()
    assert (view["state"], view["step"], view["move_id"]) == ("error", "activate", None)
    assert view["message"].startswith('The move "Load test move AB" was created with 45 '
                                      "servers, but the server refused its move password")
    assert view["message"].endswith(
        "it is too short. It is not In progress yet. Type another move password and press "
        "Create again: the same move is used, no second one is made.")
    assert "short" not in view["message"].replace("too short", "")
    (move,) = fake.moves.values()
    assert (move["status"], move["password"]) == ("planned", None)
    assert done == [(move["id"], False)]        # listed, as Planned


async def test_a_short_roster_is_reported_and_the_move_left_planned(fake, clock, portal,
                                                                     monkeypatch):
    plan = plan_on(fake)
    real = fake.process_jobs

    def lose_one():
        real()
        for a in list(fake.assets.values())[:1]:
            a["initiative_id"] = "elsewhere"
    monkeypatch.setattr(fake, "process_jobs", lose_one)
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    view = setup.snapshot()
    assert (view["state"], view["step"]) == ("error", "verify")
    assert "has 44 servers, not 45" in view["message"]
    assert view["message"].endswith("Pressing Create again would make a second move; look at "
                                    "this move in the portal instead.")
    (move,) = fake.moves.values()
    assert move["status"] == "planned"


async def test_a_stalled_worker_gives_up_and_says_where_to_look(fake, clock, portal):
    plan = plan_on(fake)
    setup, _, _ = await run_setup(fake, clock, portal, plan, worker=False,
                                  limit=STALL_SECONDS + 60)
    view = setup.snapshot()
    assert (view["state"], view["step"]) == ("error", "assets")
    assert view["message"].startswith("The server stopped making progress for 10 minutes. "
                                      "Ask whoever runs the server to check it.")
    assert "worker" not in view["message"]


async def test_polls_ride_out_a_server_blip(fake, clock, portal):
    plan = plan_on(fake)
    fake.fail("GET", r"/bulk/move-setup/[^/]+", status=503, times=6)
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    assert setup.snapshot()["state"] == "done", setup.snapshot()


async def test_cancel_ends_the_task(fake, clock, portal):
    plan = plan_on(fake)
    setup = Setup(clock)

    async def on_done(move_id, ready):
        raise AssertionError("not reached")

    setup.start(portal, plan, MOVE_PASSWORD, on_done=on_done)
    assert setup.working
    await setup.cancel()
    assert not setup.working


# ── fix round 1: no second move after a late failure, and the rest ─────


def same_entries(plan, tag="FFFFFF"):
    """A new set-up with the same entries: only the random tag differs."""
    return Plan(plan.name, plan.origin, plan.destination, plan.servers, plan.containers,
                plan.trucks, tag)


async def kiosk_signs_in(fake, clock, password) -> bool:
    device = KioskDevice(base_url=FAKE_BASE_URL, serial="CHECK-1", name="Check", kind="handheld",
                         metrics=Metrics(), clock=clock, retry=RetrySpec(1, ()), timeout=5.0,
                         transport=fake.transport())
    try:
        await clock.run(device.sign_in(password))
        return True
    except Exception:
        return False
    finally:
        await device.close()


async def test_a_refused_password_is_fixed_on_the_same_move(fake, clock, portal):
    plan = plan_on(fake)
    setup, _, _ = await run_setup(fake, clock, portal, plan, password="short")
    assert setup.snapshot()["state"] == "error"
    (first,) = fake.moves
    setup, done, seen = await run_setup(fake, clock, portal, same_entries(plan),
                                        password="a-better-pass-2", setup=setup)
    view = setup.snapshot()
    assert (view["state"], view["move_id"]) == ("done", first)
    assert set(seen) <= {"activate"}
    assert list(fake.moves) == [first] and fake.moves[first]["status"] == "in_progress"
    assert len(fake.trucks) == 1
    assert done == [(first, True)]
    assert await kiosk_signs_in(fake, clock, "a-better-pass-2")
    for text in (repr(setup.snapshot()), repr(setup), repr(vars(setup))):
        assert "a-better-pass-2" not in text and "short" not in text.replace("Short", "")


@pytest.mark.parametrize("change", [{"name": "Another move"}, {"servers": 46},
                                    {"containers": 4}, {"trucks": 2}, {"swap": True}])
async def test_any_changed_entry_makes_a_new_move(fake, clock, portal, change):
    plan = plan_on(fake)
    setup, _, _ = await run_setup(fake, clock, portal, plan, password="short")
    again = same_entries(plan)
    if change.pop("swap", False):
        again = Plan(plan.name, plan.destination, plan.origin, plan.servers, plan.containers,
                     plan.trucks, "FFFFFF")
    again = Plan(**{**again.__dict__, **change})
    setup, _, _ = await run_setup(fake, clock, portal, again, password="a-better-pass-2",
                                  setup=setup)
    assert setup.snapshot()["state"] == "done"
    assert len(fake.moves) == 2


async def test_forget_drops_the_move_to_carry_on(fake, clock, portal):
    plan = plan_on(fake)
    setup, _, _ = await run_setup(fake, clock, portal, plan, password="short")
    setup.forget()
    assert setup.snapshot() is None
    setup, _, _ = await run_setup(fake, clock, portal, same_entries(plan),
                                  password="a-better-pass-2", setup=setup)
    assert setup.snapshot()["state"] == "done" and len(fake.moves) == 2


async def test_a_403_at_step_6_says_to_finish_in_the_portal(fake, clock, portal):
    plan = plan_on(fake)
    from fakeserver_portal import PORTAL_PERMISSIONS
    fake.portal_users[EMAIL].permissions = set(PORTAL_PERMISSIONS) - {"initiatives:change"}
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    message = setup.snapshot()["message"]
    assert "not allowed to do this" in message
    assert message.endswith("with an admin account. Pressing Create again with the same "
                            "entries uses this same move (no second one is made), but this "
                            "sign-in would be refused again.")


async def test_a_lost_create_answer_still_ends_done_with_one_move(fake, clock, portal):
    plan = plan_on(fake)
    fake.fail("POST", r"/bulk/move-setup/[^/]+/create", status=503, after_effect=True)
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    assert setup.snapshot()["state"] == "done"
    assert len(fake.moves) == 1
    assert ("POST", f"/bulk/move-setup/{next(iter(fake.import_jobs))}/create") in fake.requests


@pytest.mark.parametrize("status,ending", [
    (503, "No move was created (if the server did start one, it removes the unfinished "
          "draft within a day)."),
    (422, "Nothing was created."),
])
async def test_a_step_1_failure_says_only_what_is_known(fake, clock, portal, status, ending):
    plan = plan_on(fake)
    fake.fail("POST", "/bulk/move-setup", status=status)
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    assert setup.snapshot()["message"].endswith(ending)


async def test_a_stalled_create_says_create_again_makes_a_second_move(fake, clock, portal,
                                                                      monkeypatch):
    plan = plan_on(fake)
    real = fake.process_jobs

    def checks_only():
        for job in fake.import_jobs.values():
            if job["kind"] == "move_setup" and job["status"] == "queued":
                return              # the create is never picked up
        real()
    monkeypatch.setattr(fake, "process_jobs", checks_only)
    setup, _, _ = await run_setup(fake, clock, portal, plan, limit=STALL_SECONDS + 120)
    view = setup.snapshot()
    assert (view["state"], view["step"]) == ("error", "create")
    assert view["message"].endswith(
        'It may still finish: look for "Load test move AB" in the portal\'s moves. Pressing '
        "Create again would make a second move.")


async def test_an_unexpected_problem_never_prints_a_password(fake, clock, portal, capsys,
                                                             monkeypatch):
    plan = plan_on(fake)

    async def broken(move_id, password):
        raise RuntimeError(f"boom {password} {PASSWORD}")
    monkeypatch.setattr(portal, "activate_move", broken)
    setup, _, _ = await run_setup(fake, clock, portal, plan)
    view = setup.snapshot()
    assert view["state"] == "error" and "unexpected problem" in view["message"]
    err = capsys.readouterr().err
    assert "RuntimeError" in err
    assert MOVE_PASSWORD not in err and PASSWORD not in err
    assert MOVE_PASSWORD not in view["message"]


async def test_the_from_to_is_built_off_the_event_loop(fake, clock, portal, monkeypatch):
    import threading
    import loadtest.setup as setup_module
    threads = []
    real = setup_module.from_to_csv

    def spy(plan):
        threads.append(threading.current_thread() is threading.main_thread())
        return real(plan)
    monkeypatch.setattr(setup_module, "from_to_csv", spy)
    setup, _, _ = await run_setup(fake, clock, portal, plan_on(fake))
    assert setup.snapshot()["state"] == "done" and threads == [False]
