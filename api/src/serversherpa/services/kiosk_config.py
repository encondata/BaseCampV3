"""Kiosk settings in the portal: each kiosk's one config document.

The document is `schema: 1` with the sections below. Every field defaults to
the kiosk's own current default (kiosk/src/lib/appearance.ts, sound.ts,
checkpointSettings.ts, devMode.ts and the laptop edge's rfid/alarm.py), so a
kiosk that has never reported reads exactly as it behaves.

Sections this module doesn't validate (`android_rfid`, `ios`, anything a
future app adds) pass through untouched, and a later document that omits one
never erases it: a web kiosk doesn't hold the Android sled settings, and its
report must not wipe them.

Sync is newest-whole-config-wins (`accept_kiosk_report`):
  - a report stamped later than the stored `config_changed_at` replaces the
    whole stored document;
  - anything else leaves the stored config alone;
  - a report with no stamp (a kiosk already in use, reporting for the first
    time) is stored only when the portal holds nothing yet: a portal edit
    made before that first report was deliberate and wins.
A stamp from the future is clamped to the server's `now`, so a kiosk whose
clock is ahead can never lock the portal out.

Nothing here commits; callers own the transaction (like services/audit).
"""

import copy
import json
import math
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Device, KioskSound
from serversherpa.services.audit import audit

SCHEMA = 1

BUILTIN_SOUNDS = frozenset({"chime", "beep", "double_beep", "buzz", "bonk"})
FLASH_MS_MIN, FLASH_MS_MAX = 100, 2000
ALARM_MODES = ("until_dismissed", "timed")
ALARM_SECONDS_MIN, ALARM_SECONDS_MAX = 3, 600
CHECKPOINT_MAX_LEN = 100

DEFAULT_CONFIG: dict = {
    "schema": SCHEMA,
    "appearance": {
        "good_scan": {"h": 150, "s": 60, "l": 45},
        "not_found_scan": {"h": 0, "s": 70, "l": 50},
        "duplicate_scan": {"h": 38, "s": 92, "l": 50},
        "flash_ms": 350,
    },
    "sound": {
        "good": {"kind": "builtin", "id": "chime"},
        "not_found": {"kind": "builtin", "id": "buzz"},
        "duplicate": {"kind": "builtin", "id": "double_beep"},
        "alarm": {"kind": "siren"},
        "volume": 0.8,
    },
    "checkpoints": {
        "enroll": "pre_stage",
        "container_pack": "in_container",
        "container_unpack": "un_pack",
        "truck_load": "on_truck",
        "truck_unload": "received",
    },
    "developer": {"dev_mode": False},
    "alarm": {"mode": "until_dismissed", "timed_seconds": 10},
}

# The sections normalize() validates; every other top-level key passes through.
VALIDATED_SECTIONS = ("appearance", "sound", "checkpoints", "developer", "alarm")
_OWN_KEYS = frozenset({"schema", *VALIDATED_SECTIONS})


class ConfigError(ValueError):
    """A value a portal edit may not store. `field` is the dotted path
    (`appearance.flash_ms`), `message` is the copy for the 422."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(f"{field}: {message}")
        self.field = field
        self.message = message


# ── field validators: return an error message, or None when the value is good

def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _check_hsl(v: Any, _known: set[str]) -> str | None:
    if not isinstance(v, dict):
        return "must be a color with h, s and l"
    for key, top in (("h", 360), ("s", 100), ("l", 100)):
        n = v.get(key)
        if not _is_number(n) or not 0 <= n <= top:
            return f"{key} must be a number from 0 to {top}"
    return None


def _check_flash_ms(v: Any, _known: set[str]) -> str | None:
    if not _is_int(v) or not FLASH_MS_MIN <= v <= FLASH_MS_MAX:
        return f"must be a whole number of milliseconds from {FLASH_MS_MIN} to {FLASH_MS_MAX}"
    return None


def _sound_choice_error(v: Any, known: set[str], *, alarm: bool) -> str | None:
    if not isinstance(v, dict):
        return "must be a sound choice"
    kind = v.get("kind")
    if kind == "none" and not alarm:
        return None
    if kind == "siren" and alarm:
        return None
    if kind == "builtin":
        return None if v.get("id") in BUILTIN_SOUNDS else "is not a built-in sound"
    if kind == "upload":
        sid = v.get("id")
        return None if isinstance(sid, str) and sid in known else "is not an uploaded sound"
    if alarm:
        return "must be the siren, a built-in sound or an uploaded sound"
    return "must be none, a built-in sound or an uploaded sound"


def _check_scan_sound(v: Any, known: set[str]) -> str | None:
    return _sound_choice_error(v, known, alarm=False)


def _check_alarm_sound(v: Any, known: set[str]) -> str | None:
    return _sound_choice_error(v, known, alarm=True)


def _check_volume(v: Any, _known: set[str]) -> str | None:
    if not _is_number(v) or not 0 <= v <= 1:
        return "must be a number from 0 to 1"
    return None


def _check_checkpoint(v: Any, _known: set[str]) -> str | None:
    if not isinstance(v, str) or not v.strip() or len(v) > CHECKPOINT_MAX_LEN:
        return "must be a scan status key"
    return None


def _check_bool(v: Any, _known: set[str]) -> str | None:
    return None if isinstance(v, bool) else "must be true or false"


def _check_alarm_mode(v: Any, _known: set[str]) -> str | None:
    return None if v in ALARM_MODES else "must be until_dismissed or timed"


def _check_alarm_seconds(v: Any, _known: set[str]) -> str | None:
    if not _is_int(v) or not ALARM_SECONDS_MIN <= v <= ALARM_SECONDS_MAX:
        return f"must be a whole number of seconds from {ALARM_SECONDS_MIN} to {ALARM_SECONDS_MAX}"
    return None


_CHECKS: dict[str, dict] = {
    "appearance": {"good_scan": _check_hsl, "not_found_scan": _check_hsl,
                   "duplicate_scan": _check_hsl, "flash_ms": _check_flash_ms},
    "sound": {"good": _check_scan_sound, "not_found": _check_scan_sound,
              "duplicate": _check_scan_sound, "alarm": _check_alarm_sound,
              "volume": _check_volume},
    "checkpoints": {key: _check_checkpoint for key in DEFAULT_CONFIG["checkpoints"]},
    "developer": {"dev_mode": _check_bool},
    "alarm": {"mode": _check_alarm_mode, "timed_seconds": _check_alarm_seconds},
}


def normalize(doc: dict | None, *, known_sounds: set[str], strict: bool) -> dict:
    """A complete schema-1 document built from `doc` (never mutated).

    Missing sections and fields get their defaults; unknown sections and
    unknown fields inside known sections are kept as they are. A bad value
    raises ConfigError when `strict` (portal edits) and is replaced by its
    default otherwise (kiosk reports), keeping everything else."""
    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        if strict:
            raise ConfigError("config", "must be a settings document")
        doc = {}

    out: dict = {k: copy.deepcopy(v) for k, v in doc.items() if k not in _OWN_KEYS}

    schema = doc.get("schema", SCHEMA)
    if strict and (not _is_int(schema) or schema != SCHEMA):
        raise ConfigError("schema", f"must be {SCHEMA}")
    out["schema"] = SCHEMA

    for section in VALIDATED_SECTIONS:
        defaults = DEFAULT_CONFIG[section]
        given = doc.get(section, {})
        if not isinstance(given, dict):
            if strict:
                raise ConfigError(section, "must be a group of settings")
            given = {}
        merged = {k: copy.deepcopy(v) for k, v in given.items() if k not in defaults}
        for field, check in _CHECKS[section].items():
            if field not in given:
                merged[field] = copy.deepcopy(defaults[field])
                continue
            value = given[field]
            problem = check(value, known_sounds)
            if problem is None:
                merged[field] = copy.deepcopy(value)
            elif strict:
                raise ConfigError(f"{section}.{field}", problem)
            else:
                merged[field] = copy.deepcopy(defaults[field])
        out[section] = merged
    return out


def sound_ids_in(doc: dict | None) -> set[str]:
    """The uploaded-sound ids a config names (for downloads and the
    in-use check on delete)."""
    if not isinstance(doc, dict) or not isinstance(doc.get("sound"), dict):
        return set()
    ids = set()
    for choice in doc["sound"].values():
        if isinstance(choice, dict) and choice.get("kind") == "upload" \
                and isinstance(choice.get("id"), str):
            ids.add(choice["id"])
    return ids


async def known_sound_ids(db: AsyncSession) -> set[str]:
    return {str(i) for i in (await db.scalars(select(KioskSound.id))).all()}


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _carry_passthrough(new: dict, stored: dict | None, incoming: Any) -> dict:
    """Keep stored sections this module doesn't own when the incoming
    document left them out: one kiosk's report never erases another
    platform's section."""
    if isinstance(stored, dict):
        given = incoming if isinstance(incoming, dict) else {}
        for key, value in stored.items():
            if key not in _OWN_KEYS and key not in given:
                new[key] = copy.deepcopy(value)
    return new


def _flatten(doc: dict | None) -> dict:
    """`section.field` -> value; a non-dict top-level value keeps its key."""
    flat: dict = {}
    for key, value in (doc or {}).items():
        if isinstance(value, dict):
            for field, inner in value.items():
                flat[f"{key}.{field}"] = inner
        else:
            flat[key] = value
    return flat


def field_diff(before: dict | None, after: dict | None) -> dict:
    """Field-level diff `{"section.field": {"from", "to"}}`; a field that
    appears or disappears reads as None on the other side."""
    b, a = _flatten(before), _flatten(after)
    return {key: {"from": b.get(key), "to": a.get(key)}
            for key in sorted(b.keys() | a.keys()) if b.get(key) != a.get(key)}


def _canonical(doc: dict) -> str:
    """The document as stored JSON sees it: `true` and `1` (or `1` and
    `1.0`) differ, key order doesn't."""
    return json.dumps(doc, sort_keys=True)


def _store(db: AsyncSession, device: Device, new: dict, *, source: str,
           changed_at: datetime, actor_id: uuid.UUID | None) -> None:
    fields = field_diff(device.config, new)
    device.config = new
    device.config_version = (device.config_version or 0) + 1
    device.config_source = source
    device.config_changed_at = changed_at
    device.config_changed_by = actor_id
    audit(db, actor_id=actor_id, entity_type="device", entity_id=str(device.id),
          action="config_change",
          changes={"source": source, "version": device.config_version, "fields": fields})


async def accept_kiosk_report(db: AsyncSession, device: Device, doc: dict | None,
                              changed_at: datetime | None, *, now: datetime) -> bool:
    """Apply a kiosk's full-config report; True when it was stored as the
    new version. Always records `config_reported_at = now`."""
    now = _utc(now)
    device.config_reported_at = now
    if changed_at is None:
        # Unstamped: only a first report on an untouched device is stored.
        if device.config is not None or (device.config_version or 0) > 0:
            return False
        stamp = now
    else:
        stamp = min(_utc(changed_at), now)
        if device.config_changed_at is not None and stamp <= device.config_changed_at:
            return False
    new = normalize(doc, known_sounds=await known_sound_ids(db), strict=False)
    new = _carry_passthrough(new, device.config, doc)
    if device.config is not None and _canonical(new) == _canonical(device.config):
        return False
    _store(db, device, new, source="kiosk", changed_at=stamp, actor_id=None)
    return True


async def apply_portal_edit(db: AsyncSession, device: Device, doc: dict | None, *,
                            actor_id: uuid.UUID | None, now: datetime) -> None:
    """Store a super admin's edit as the new version (strict: ConfigError
    on a bad value, nothing changed)."""
    new = normalize(doc, known_sounds=await known_sound_ids(db), strict=True)
    new = _carry_passthrough(new, device.config, doc)
    _store(db, device, new, source="portal", changed_at=_utc(now), actor_id=actor_id)


def reply_fields(device: Device, applied_version: int | None) -> dict:
    """The check-in reply's config fields: the whole document only when the
    kiosk is behind the portal's version."""
    version = device.config_version or 0
    behind = device.config is not None and (applied_version is None or applied_version < version)
    return {"config_version": version, "config": device.config if behind else None}
