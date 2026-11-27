import itertools
import math

import httpx
import pytest

from loadtest.route import RouteError, fetch_route, points_along

DALLAS = (32.7, -96.8)
ATLANTA = (33.7, -84.4)


def _km(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def _road(n=500):
    """A road-shaped line: mostly east, with a gentle wiggle and a few repeated points."""
    line = []
    for i in range(n):
        t = i / (n - 1)
        line.append((DALLAS[0] + (ATLANTA[0] - DALLAS[0]) * t + 0.05 * math.sin(t * 40),
                     DALLAS[1] + (ATLANTA[1] - DALLAS[1]) * t))
    line[100:100] = [line[100]] * 3
    return line


def _osrm(coords_lnglat, code="Ok"):
    return {"code": code, "routes": [{"geometry": {"type": "LineString",
                                                   "coordinates": coords_lnglat},
                                      "distance": 1300000.0, "duration": 45000.0}],
            "waypoints": []}


def _close(a, b, tol=1e-6):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


# ── points_along ──────────────────────────────────────────────────────


def test_points_along_equal_steps():
    got = points_along([(0, 0), (0, 1), (0, 3)], 3)
    assert len(got) == 3
    for g, want in zip(got, [(0, 1), (0, 2), (0, 3)], strict=True):
        assert _close(g, want)


def test_points_along_a_real_shaped_line():
    line = _road()
    got = points_along(line, 68)
    assert len(got) == 68
    distances = [_km(line[0], p) for p in got]
    assert all(b > a for a, b in itertools.pairwise(distances))
    assert got[-1] == line[-1]
    halfway = _km(line[0], got[33])          # update 34 of 68 is halfway along the road
    assert 0.4 < halfway / _km(line[0], line[-1]) < 0.6


def test_points_along_two_points_and_repeats():
    assert points_along([(0, 0), (0, 2)], 2)[-1] == (0, 2)
    assert _close(points_along([(0, 0), (0, 2)], 2)[0], (0, 1))
    got = points_along([(0, 0), (0, 0), (0, 1), (0, 1), (0, 2)], 4)
    assert len(got) == 4 and got[-1] == (0, 2)
    assert _close(got[1], (0, 1))
    assert points_along([(5, 5), (5, 5)], 3) == [(5, 5)] * 3


def test_points_along_rejects_bad_input():
    with pytest.raises(ValueError):
        points_along([(0, 0), (0, 1)], 0)
    with pytest.raises(ValueError):
        points_along([(0, 0)], 3)


# ── fetch_route ───────────────────────────────────────────────────────


async def test_fetch_route_flips_coordinates_and_sends_only_the_two_points():
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=_osrm([[-96.8, 32.7], [-90.1, 33.0], [-84.4, 33.7]]))

    line = await fetch_route(DALLAS, ATLANTA, router_url="https://router.example/",
                             transport=httpx.MockTransport(handler))
    assert line == [(32.7, -96.8), (33.0, -90.1), (33.7, -84.4)]
    assert len(seen) == 1
    assert str(seen[0].url) == ("https://router.example/route/v1/driving/"
                                "-96.8,32.7;-84.4,33.7?overview=full&geometries=geojson")
    assert seen[0].method == "GET"


async def test_fetch_route_rounds_to_five_places():
    seen: list[str] = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json=_osrm([[-96.8, 32.7], [-84.4, 33.7]]))

    await fetch_route((32.123456789, -96.000001), (33.0, -84.0), router_url="http://r.test",
                      transport=httpx.MockTransport(handler))
    assert seen == [("http://r.test/route/v1/driving/-96,32.12346;-84,33"
                     "?overview=full&geometries=geojson")]


@pytest.mark.parametrize(("response", "message"), [
    (httpx.Response(200, json=_osrm([], code="NoRoute")),
     "The road-routing service found no route (NoRoute)."),
    (httpx.Response(200, json=_osrm([[-96.8, 32.7]])),
     "The road-routing service sent a route with fewer than 2 points."),
    (httpx.Response(400, json={"code": "InvalidQuery"}),
     "The road-routing service answered 400."),
    (httpx.Response(200, text="not json"),
     "The road-routing service sent an answer that is not JSON."),
    (httpx.Response(200, json={"code": "Ok", "routes": []}),
     "The road-routing service sent a route without a road line."),
])
async def test_fetch_route_errors(response, message):
    with pytest.raises(RouteError) as caught:
        await fetch_route(DALLAS, ATLANTA, transport=httpx.MockTransport(lambda r: response))
    assert str(caught.value) == message


async def test_fetch_route_retries_transport_errors_twice():
    calls = []

    def flaky(request):
        calls.append(1)
        if len(calls) < 3:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(200, json=_osrm([[-96.8, 32.7], [-84.4, 33.7]]))

    assert len(await fetch_route(DALLAS, ATLANTA, transport=httpx.MockTransport(flaky))) == 2
    calls.clear()

    def down(request):
        calls.append(1)
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(RouteError) as caught:
        await fetch_route(DALLAS, ATLANTA, transport=httpx.MockTransport(down))
    assert str(caught.value) == "Could not reach the road-routing service."
    assert len(calls) == 3
