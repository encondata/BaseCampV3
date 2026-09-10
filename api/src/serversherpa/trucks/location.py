"""Truck location parsing — V2 stored "lat, lng" text; trackers may post
{lat, lng}. One parser, one error, used by the updates endpoint and seed."""


class LocationError(ValueError):
    pass


def parse_location(value: str | dict) -> tuple[float, float]:
    if isinstance(value, dict):
        try:
            lat, lng = float(value["lat"]), float(value["lng"])
        except (KeyError, TypeError, ValueError) as exc:
            raise LocationError("expected {lat, lng}") from exc
    else:
        parts = [p.strip() for p in str(value).split(",")]
        if len(parts) != 2:
            raise LocationError('expected "lat, lng"')
        try:
            lat, lng = float(parts[0]), float(parts[1])
        except ValueError as exc:
            raise LocationError("not numbers") from exc
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise LocationError("out of range")
    return lat, lng


def format_location(lat: float, lng: float) -> str:
    return f"{lat:.6f}, {lng:.6f}"
