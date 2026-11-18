"""IPA inspection: the app bundle's Info.plist, icon and embedded profile."""

import plistlib
import re
import struct
import zipfile
from pathlib import Path

from serversherpa_devices.packages import (
    PackageError,
    PackageInfo,
    cgbi,
    open_zip,
    provision,
    read_member,
)
from serversherpa_devices.packages.versions import ios_build_sort

# Only the app's own Info.plist, exactly one level inside Payload/: extension,
# framework and Watch app plists sit deeper in the bundle.
_APP_PLIST = re.compile(r"Payload/([^/]+\.app)/Info\.plist")
_PLIST_LIMIT = 4 * 1024 * 1024
_ICON_LIMIT = 8 * 1024 * 1024
_PROFILE_LIMIT = 4 * 1024 * 1024


def inspect_ipa(path: Path) -> PackageInfo:
    with open_zip(path) as zf:
        names = zf.namelist()
        apps = list(dict.fromkeys(
            m.group(1) for name in names if (m := _APP_PLIST.fullmatch(name))))
        if not apps:
            raise PackageError("The IPA has no app inside Payload/")
        if len(apps) > 1:
            raise PackageError("The IPA has more than one app inside Payload/")
        app_dir = f"Payload/{apps[0]}/"

        info = _info_plist(zf, app_dir)
        identifier = _string(info, "CFBundleIdentifier")
        if not identifier:
            raise PackageError("The app's Info.plist has no bundle ID")
        build = _string(info, "CFBundleVersion")
        if not build:
            raise PackageError("The app's Info.plist has no build number (CFBundleVersion)")
        try:
            build_sort = ios_build_sort(build)
        except ValueError:
            raise PackageError(
                f"The build number {build} isn't up to four numbers separated by dots"
            ) from None

        profile_bytes = read_member(zf, app_dir + "embedded.mobileprovision",
                                    limit=_PROFILE_LIMIT)
        if profile_bytes is None and app_dir + "embedded.mobileprovision" in names:
            raise PackageError(provision.UNREADABLE)
        return PackageInfo(
            platform="ios",
            identifier=identifier,
            name=(_string(info, "CFBundleDisplayName") or _string(info, "CFBundleName")
                  or apps[0].removesuffix(".app")),
            version_name=_string(info, "CFBundleShortVersionString") or build,
            build=build,
            build_sort=build_sort,
            min_os=_string(info, "MinimumOSVersion"),
            icon_png=_icon_png(zf, app_dir, info, names),
            signing_digest=None,
            provision=provision.parse(profile_bytes) if profile_bytes is not None else None,
        )


def _info_plist(zf: zipfile.ZipFile, app_dir: str) -> dict:
    data = read_member(zf, app_dir + "Info.plist", limit=_PLIST_LIMIT)
    try:
        info = plistlib.loads(data) if data is not None else None
    except Exception:  # noqa: BLE001 (plistlib raises many types on bad input)
        info = None
    if not isinstance(info, dict):
        raise PackageError("The app's Info.plist can't be read")
    return info


def _string(info: dict, key: str) -> str | None:
    value = info.get(key)
    return (value.strip() or None) if isinstance(value, str) else None


def _icon_names(info: dict) -> list[str]:
    icons = info.get("CFBundleIcons")
    primary = icons.get("CFBundlePrimaryIcon") if isinstance(icons, dict) else None
    files = primary.get("CFBundleIconFiles") if isinstance(primary, dict) else None
    if not isinstance(files, list):
        return []
    return [f.removesuffix(".png") for f in files if isinstance(f, str) and f]


def _icon_png(zf: zipfile.ZipFile, app_dir: str, info: dict, names: list[str]) -> bytes | None:
    """The largest file in the bundle matching a CFBundleIconFiles entry
    ("AppIcon60x60" matches AppIcon60x60.png, AppIcon60x60@3x.png and
    AppIcon60x60@2x~ipad.png), decoded from CgBI."""
    bases = _icon_names(info)
    candidates = []
    for name in names:
        if not name.startswith(app_dir) or not name.endswith(".png"):
            continue
        file = name[len(app_dir):]
        if "/" in file:
            continue
        stem = file.removesuffix(".png")
        if any(stem == base or stem.startswith((base + "@", base + "~")) for base in bases):
            data = read_member(zf, name, limit=_ICON_LIMIT)
            if data is not None:
                candidates.append((_png_area(data), len(data), data))
    for _, _, data in sorted(candidates, key=lambda c: c[:2], reverse=True):
        png = cgbi.decode(data)
        if png is not None and png.startswith(cgbi.PNG_SIGNATURE):
            return png
    return None


def _png_area(data: bytes) -> int:
    """Width x height from the IHDR chunk, wherever it sits (CgBI puts a chunk
    ahead of it); 0 when there isn't one."""
    at = data.find(b"IHDR", 8, 64)
    if at < 0 or len(data) < at + 12:
        return 0
    width, height = struct.unpack(">II", data[at + 4:at + 12])
    return width * height
