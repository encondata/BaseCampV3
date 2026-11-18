"""The entitlements a re-signed binary gets: its own, made to fit the Ad Hoc
profile it is signed with."""

import copy

from serversherpa_devices.packages.provision import ProvisionInfo
from serversherpa_devices.signing import SignError

_REFUSED = object()
# Keys we set ourselves (from the profile's team and the bundle id), and the
# App Store export's TestFlight marker, which no Ad Hoc profile carries: a
# profile without them never fails the signing.
_SET_HERE = frozenset({"get-task-allow", "application-identifier",
                       "com.apple.developer.team-identifier", "beta-reports-active"})


class MissingEntitlement(SignError):
    """The binary uses a capability its App ID doesn't have (ruling R19)."""

    def __init__(self, keys: list[str]) -> None:
        self.keys = keys
        named = keys[0] if len(keys) == 1 else f"{', '.join(keys[:-1])} and {keys[-1]}"
        super().__init__(f"This app needs {named}, which its App ID doesn't have in Apple's "
                         "developer site. Turn it on there, then upload the app again.")


def for_profile(binary_ents: dict, profile: ProvisionInfo, *, bundle_id: str) -> dict:
    """The binary's entitlements (as rcodesign print-signature-info reads
    them) with get-task-allow off, the App ID and team set from the
    profile's team, and push set to production.

    A key the profile doesn't have at all is a capability missing from the
    App ID: MissingEntitlement, naming it (the keys in _SET_HERE aside).
    Within a key the profile has, values it doesn't allow are dropped. A
    profile value ending in "*" (such as "TEAM.*") allows any value with
    that prefix."""
    team = profile.team_id
    if not team:
        raise SignError("The provisioning profile has no team.")
    wanted = copy.deepcopy(binary_ents)
    wanted["get-task-allow"] = False
    wanted["application-identifier"] = f"{team}.{bundle_id}"
    wanted["com.apple.developer.team-identifier"] = team
    if "aps-environment" in wanted:
        wanted["aps-environment"] = "production"

    allowed = profile.entitlements
    missing = sorted(key for key in wanted if key not in allowed and key not in _SET_HERE)
    if missing:
        raise MissingEntitlement(missing)
    result = {}
    for key, value in wanted.items():
        if key not in allowed:
            continue
        kept = _allowed(value, allowed[key])
        if kept is not _REFUSED:
            result[key] = kept
    return result


def _allowed(value, pattern):
    """`value` as far as `pattern` allows it: a list keeps its allowed items
    (and goes when none are), anything else is kept whole or refused."""
    if isinstance(value, list):
        if not value:
            return value
        items = [item for item in value if _matches(item, pattern)]
        return items or _REFUSED
    return value if _matches(value, pattern) else _REFUSED


def _matches(item, pattern) -> bool:
    if isinstance(pattern, list):
        return any(_matches(item, p) for p in pattern)
    if isinstance(pattern, str) and isinstance(item, str):
        return item == pattern or (pattern.endswith("*") and item.startswith(pattern[:-1]))
    return type(item) is type(pattern) and item == pattern
