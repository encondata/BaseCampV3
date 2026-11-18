"""Provisioning profiles (embedded.mobileprovision): a CMS SignedData
envelope around a plist. The signature isn't checked; this only reads it."""

import datetime as dt
import plistlib
from dataclasses import dataclass
from typing import Literal

from asn1crypto import cms

from serversherpa_devices.packages import PackageError, converts_errors

UNREADABLE = "The provisioning profile can't be read"
RAW_LIMIT = 1024 * 1024   # real profiles are tens of KB, even with 100 devices
# A binary plist can share references, so a few hundred bytes can describe
# 2^40 nodes; the entitlements are copied within these bounds.
_MAX_DEPTH = 32
_MAX_NODES = 10_000


@dataclass
class ProvisionInfo:
    kind: Literal["adhoc", "development", "enterprise", "appstore"]
    team_id: str | None
    uuid: str | None
    name: str | None
    expires_at: dt.datetime | None   # UTC
    devices: list[str]
    entitlements: dict


def _classify(profile: dict, entitlements: dict) -> str:
    if "ProvisionedDevices" in profile:
        return "development" if entitlements.get("get-task-allow") is True else "adhoc"
    if profile.get("ProvisionsAllDevices") is True:
        return "enterprise"
    return "appstore"


@converts_errors(UNREADABLE)
def parse(raw: bytes) -> ProvisionInfo:
    if len(raw) > RAW_LIMIT:
        raise PackageError(UNREADABLE)
    try:
        content = cms.ContentInfo.load(raw)
        payload = content["content"]["encap_content_info"]["content"].native
        profile = plistlib.loads(payload, aware_datetime=True)
    except MemoryError:
        raise
    except Exception:  # noqa: BLE001 (asn1crypto and plistlib raise many types on bad input)
        raise PackageError(UNREADABLE) from None
    if not isinstance(profile, dict):
        raise PackageError(UNREADABLE)

    entitlements = profile.get("Entitlements")
    entitlements = _bounded_copy(entitlements) if isinstance(entitlements, dict) else {}
    teams = profile.get("TeamIdentifier")
    team_id = teams[0] if isinstance(teams, list) and teams and isinstance(teams[0], str) else (
        entitlements.get("com.apple.developer.team-identifier"))
    devices = profile.get("ProvisionedDevices")
    expires = profile.get("ExpirationDate")
    return ProvisionInfo(
        kind=_classify(profile, entitlements),
        team_id=team_id if isinstance(team_id, str) else None,
        uuid=_str_or_none(profile.get("UUID")),
        name=_str_or_none(profile.get("Name")),
        expires_at=expires if isinstance(expires, dt.datetime) else None,
        devices=[d for d in devices if isinstance(d, str)] if isinstance(devices, list) else [],
        entitlements=entitlements,
    )


def _str_or_none(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _bounded_copy(entitlements: dict) -> dict:
    """A plain copy of the entitlements: string keys; str, bool, int, float,
    list and dict values (others, such as <data> and <date>, are dropped);
    at most _MAX_DEPTH deep and _MAX_NODES values, else PackageError."""
    budget = [_MAX_NODES]

    def copy(value: object, depth: int):
        budget[0] -= 1
        if budget[0] < 0 or depth > _MAX_DEPTH:
            raise PackageError(UNREADABLE)
        if isinstance(value, (str, bool, int, float)):
            return value
        if isinstance(value, list):
            items = (copy(v, depth + 1) for v in value)
            return [v for v in items if v is not _DROPPED]
        if isinstance(value, dict):
            pairs = ((k, copy(v, depth + 1)) for k, v in value.items() if isinstance(k, str))
            return {k: v for k, v in pairs if v is not _DROPPED}
        return _DROPPED

    return copy(entitlements, 0)


_DROPPED = object()
