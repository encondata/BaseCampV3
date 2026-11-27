"""The truck's road route: asked once per run from a road-routing service (OSRM's
route API), then cut into evenly spaced points by distance along the road.

Only the two sites' coordinates are sent: no names, ids or other details.
"""

from __future__ import annotations

import bisect
import itertools
import math

import httpx

DEFAULT_ROUTER = "https://router.project-osrm.org"
EARTH_RADIUS_KM = 6371.0088
ATTEMPTS = 3            # one attempt plus two retries on transport errors
TIMEOUT_SECONDS = 30.0


class RouteError(Exception):
    """The road route could not be had. The message is plain and safe to show."""


class NoRoute(RouteError):
    """The service answered, but found no road between the two points."""


def _coord(value: float) -> str:
    """At most 5 decimal places, without trailing zeros (-96.80000 -> -96.8)."""
    text = f"{value:.5f}".rstrip("0").rstrip(".")
    return "0" if text == "-0" else text


async def fetch_route(origin: tuple[float, float], destination: tuple[float, float], *,
                      router_url: str = DEFAULT_ROUTER,
                      transport: httpx.AsyncBaseTransport | None = None,
                      ) -> list[tuple[float, float]]:
    """The driving route from origin to destination as (lat, lng) points."""
    (lat1, lng1), (lat2, lng2) = origin, destination
    url = (f"{router_url.rstrip('/')}/route/v1/driving/"
           f"{_coord(lng1)},{_coord(lat1)};{_coord(lng2)},{_coord(lat2)}"
           "?overview=full&geometries=geojson")
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport) as client:
        response: httpx.Response | None = None
        for _ in range(ATTEMPTS):
            try:
                response = await client.get(url)
                break
            except httpx.TransportError:
                continue
    if response is None:
        raise RouteError("Could not reach the road-routing service.")
    if response.status_code != 200:
        raise RouteError(f"The road-routing service answered {response.status_code}.")
    try:
        body = response.json()
    except ValueError:
        raise RouteError("The road-routing service sent an answer that is not JSON.") from None
    code = body.get("code") if isinstance(body, dict) else None
    if code != "Ok":
        raise NoRoute(f"The road-routing service found no route ({code}).")
    try:
        coords = body["routes"][0]["geometry"]["coordinates"]
        line = [(float(lat), float(lng)) for lng, lat, *_ in coords]
    except (KeyError, IndexError, TypeError, ValueError):
        raise RouteError("The road-routing service sent a route without a road line.") from None
    if len(line) < 2:
        raise RouteError("The road-routing service sent a route with fewer than 2 points.")
    return line


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


def line_km(line: list[tuple[float, float]]) -> float:
    """The line's length in kilometers (haversine, summed over its segments)."""
    return sum(_km(a, b) for a, b in itertools.pairwise(line))


def points_along(line: list[tuple[float, float]], count: int) -> list[tuple[float, float]]:
    """`count` points; point k (1-based) lies k/count of the line's length along it
    (haversine lengths, linear interpolation inside a segment). The last point is the
    line's end."""
    if count < 1:
        raise ValueError("count must be at least 1")
    if len(line) < 2:
        raise ValueError("a line needs at least 2 points")
    cumulative = [0.0]
    for a, b in itertools.pairwise(line):
        cumulative.append(cumulative[-1] + _km(a, b))
    total = cumulative[-1]
    end = (line[-1][0], line[-1][1])
    out: list[tuple[float, float]] = []
    for k in range(1, count + 1):
        if k == count or total == 0:
            out.append(end)
            continue
        target = total * k / count
        # the first segment whose far end reaches the target; zero-length ones never
        # qualify, because their far end equals their near end
        i = bisect.bisect_left(cumulative, target) - 1
        i = max(0, min(i, len(line) - 2))
        start, length = cumulative[i], cumulative[i + 1] - cumulative[i]
        frac = 0.0 if length == 0 else (target - start) / length
        (lat_a, lng_a), (lat_b, lng_b) = line[i], line[i + 1]
        out.append((lat_a + (lat_b - lat_a) * frac, lng_a + (lng_b - lng_a) * frac))
    return out
