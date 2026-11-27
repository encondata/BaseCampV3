"""Speed profiles: every number the load test needs lives in one TOML file."""

from __future__ import annotations

import math
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Kind = Literal["each", "cart", "pack", "truck_load", "trip", "truck_unload", "unpack"]
Action = Literal[
    "enroll", "scan", "station_rfid", "station_label", "pack", "unpack", "load", "unload", "trip"
]
DeviceKind = Literal["handheld", "rfid_station", "label_station"]


class ProfileError(ValueError):
    """The profile file is malformed or breaks a rule."""


@dataclass(frozen=True)
class StageSpec:
    key: str
    label: str
    site: Literal["origin", "destination"]
    kind: Kind
    action: Action
    checkpoint: str | None
    device: DeviceKind | None
    devices: int
    crews: int
    batch: int
    seconds: tuple[float, float]  # min, max
    per: Literal["server", "cart", "container"]


@dataclass(frozen=True)
class TripSpec:
    hours: float
    update_minutes: float
    pause_seconds: tuple[float, float]

    @property
    def updates(self) -> int:
        return round(self.hours * 60 / self.update_minutes)


@dataclass(frozen=True)
class RetrySpec:
    attempts: int
    backoff_seconds: tuple[float, ...]


@dataclass(frozen=True)
class Profile:
    name: str
    container_size: int
    containers_per_truck: int
    final_status: str
    heartbeat_seconds: float
    sample_seconds: float
    request_timeout_seconds: float
    retry: RetrySpec
    trip: TripSpec
    stages: tuple[StageSpec, ...]
    raw: dict


_TOP_KEYS = {
    "container_size", "containers_per_truck", "final_status", "heartbeat_seconds",
    "sample_seconds", "request_timeout_seconds", "retry", "trip", "stage",
}
_RETRY_KEYS = {"attempts", "backoff_seconds"}
_TRIP_KEYS = {"hours", "update_minutes", "pause_seconds"}
_STAGE_REQUIRED = {"key", "label", "site", "kind", "action", "devices", "crews", "batch",
                   "seconds", "per"}
_STAGE_KEYS = _STAGE_REQUIRED | {"checkpoint", "device"}

_PAIRS = {
    ("each", "enroll"), ("each", "scan"), ("each", "station_label"),
    ("cart", "station_rfid"),
    ("pack", "pack"), ("truck_load", "load"), ("trip", "trip"),
    ("truck_unload", "unload"), ("unpack", "unpack"),
}
_DEVICE_FOR = {
    "enroll": "handheld", "scan": "handheld", "pack": "handheld", "unpack": "handheld",
    "load": "handheld", "unload": "handheld",
    "station_rfid": "rfid_station", "station_label": "label_station",
}
_CONTAINER_KINDS = {"pack", "unpack", "truck_load", "truck_unload"}
_ORDERED = ("pack", "truck_load", "trip", "truck_unload", "unpack")


def profile_path(name: str) -> Path:
    """Bundled profile file for "real-time" or "fast"."""
    if name not in ("real-time", "fast"):
        raise ProfileError(f"unknown profile {name!r}; expected 'real-time' or 'fast'")
    return Path(__file__).resolve().parents[2] / "profiles" / f"{name}.toml"


def _check_keys(where: str, table: dict, allowed: set[str], required: set[str] | None = None):
    for k in table:
        if k not in allowed:
            raise ProfileError(f"{where}: unknown key {k!r}")
    for k in (required if required is not None else allowed):
        if k not in table:
            raise ProfileError(f"{where}: missing key {k!r}")


def _pair(where: str, field: str, value) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        raise ProfileError(f"{where}: {field} must be [min, max]")
    lo, hi = float(value[0]), float(value[1])
    if lo < 0 or hi < 0:
        raise ProfileError(f"{where}: {field} must not be negative")
    if lo > hi:
        raise ProfileError(f"{where}: {field} min is greater than max")
    return lo, hi


def _stage(raw: dict) -> StageSpec:
    key = raw.get("key", "?")
    where = f"stage {key!r}"
    _check_keys(where, raw, _STAGE_KEYS, _STAGE_REQUIRED)
    if raw["site"] not in ("origin", "destination"):
        raise ProfileError(f"{where}: site must be 'origin' or 'destination'")
    if (raw["kind"], raw["action"]) not in _PAIRS:
        raise ProfileError(
            f"{where}: action {raw['action']!r} is not valid for kind {raw['kind']!r}"
        )
    seconds = _pair(where, "seconds", raw["seconds"])
    if raw["kind"] != "trip":
        for field in ("crews", "devices", "batch"):
            if int(raw[field]) < 1:
                raise ProfileError(f"{where}: {field} must be at least 1")
        want = _DEVICE_FOR[raw["action"]]
        if raw.get("device") != want:
            raise ProfileError(f"{where}: action {raw['action']!r} needs device {want!r}")
        if not raw.get("checkpoint"):
            raise ProfileError(f"{where}: checkpoint is required")
    if raw["per"] not in ("server", "cart", "container"):
        raise ProfileError(f"{where}: per must be 'server', 'cart' or 'container'")
    if raw["per"] == "cart" and raw["kind"] != "cart":
        raise ProfileError(f"{where}: per 'cart' is only for cart stages")
    if raw["per"] == "container" and raw["kind"] not in _CONTAINER_KINDS:
        raise ProfileError(
            f"{where}: per 'container' is only for pack, unpack, truck_load and truck_unload"
        )
    return StageSpec(
        key=raw["key"], label=raw["label"], site=raw["site"], kind=raw["kind"],
        action=raw["action"], checkpoint=raw.get("checkpoint"), device=raw.get("device"),
        devices=int(raw["devices"]), crews=int(raw["crews"]), batch=int(raw["batch"]),
        seconds=seconds, per=raw["per"],
    )


def _validate_layout(stages: tuple[StageSpec, ...]) -> None:
    seen: set[str] = set()
    for s in stages:
        if s.key in seen:
            raise ProfileError(f"stage {s.key!r}: duplicate stage key")
        seen.add(s.key)
    index: dict[str, int] = {}
    for kind in _ORDERED:
        found = [i for i, s in enumerate(stages) if s.kind == kind]
        if len(found) != 1:
            raise ProfileError(f"expected exactly one {kind!r} stage, found {len(found)}")
        index[kind] = found[0]
    positions = [index[k] for k in _ORDERED]
    if positions != sorted(positions):
        raise ProfileError("stages pack, truck_load, trip, truck_unload, unpack are out of order")
    for s in stages[index["pack"] + 1 : index["unpack"]]:
        if s.kind in ("each", "cart"):
            raise ProfileError(
                f"stage {s.key!r}: no each or cart stage is allowed between pack and unpack"
            )
    for i, s in enumerate(stages):
        want = "origin" if i <= index["trip"] else "destination"
        if s.site != want:
            raise ProfileError(f"stage {s.key!r}: site must be {want!r}")


def load_profile(path: Path) -> Profile:
    path = Path(path)
    try:
        raw = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as err:
        raise ProfileError(f"{path.name}: {err}") from err
    _check_keys("profile", raw, _TOP_KEYS)
    _check_keys("retry", raw["retry"], _RETRY_KEYS)
    _check_keys("trip", raw["trip"], _TRIP_KEYS)

    retry = raw["retry"]
    backoff = tuple(float(x) for x in retry["backoff_seconds"])
    if int(retry["attempts"]) < 1:
        raise ProfileError("retry: attempts must be at least 1")
    if not backoff:
        raise ProfileError("retry: backoff_seconds needs at least one value")
    t = raw["trip"]
    updates = float(t["hours"]) * 60 / float(t["update_minutes"])
    if updates < 1 or abs(updates - round(updates)) > 1e-9:
        raise ProfileError(
            "trip: hours * 60 / update_minutes must be a whole number of at least 1 "
            "(check hours and update_minutes)"
        )
    trip = TripSpec(
        hours=float(t["hours"]), update_minutes=float(t["update_minutes"]),
        pause_seconds=_pair("trip", "pause_seconds", t["pause_seconds"]),
    )
    stages = tuple(_stage(s) for s in raw["stage"])
    _validate_layout(stages)
    return Profile(
        name=path.stem,
        container_size=int(raw["container_size"]),
        containers_per_truck=int(raw["containers_per_truck"]),
        final_status=str(raw["final_status"]),
        heartbeat_seconds=float(raw["heartbeat_seconds"]),
        sample_seconds=float(raw["sample_seconds"]),
        request_timeout_seconds=float(raw["request_timeout_seconds"]),
        retry=RetrySpec(attempts=int(retry["attempts"]), backoff_seconds=backoff),
        trip=trip, stages=stages, raw=raw,
    )


def device_count(profile: Profile) -> int:
    return sum(s.devices for s in profile.stages)


def containers_needed(profile: Profile, servers: int) -> int:
    return math.ceil(servers / profile.container_size)


def trucks_needed(profile: Profile, containers: int) -> int:
    return math.ceil(containers / profile.containers_per_truck)
