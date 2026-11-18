"""Provisioning profiles (embedded.mobileprovision): a CMS SignedData
envelope around a plist. The signature isn't checked; this only reads it."""

import datetime as dt
import plistlib
from dataclasses import dataclass
from typing import Literal

from asn1crypto import cms

from serversherpa_devices.packages import PackageError

UNREADABLE = "The provisioning profile can't be read"


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


def parse(raw: bytes) -> ProvisionInfo:
    try:
        content = cms.ContentInfo.load(raw)
        payload = content["content"]["encap_content_info"]["content"].native
        profile = plistlib.loads(payload, aware_datetime=True)
    except Exception:  # noqa: BLE001 (asn1crypto and plistlib raise many types on bad input)
        raise PackageError(UNREADABLE) from None
    if not isinstance(profile, dict):
        raise PackageError(UNREADABLE)

    entitlements = profile.get("Entitlements")
    entitlements = entitlements if isinstance(entitlements, dict) else {}
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
