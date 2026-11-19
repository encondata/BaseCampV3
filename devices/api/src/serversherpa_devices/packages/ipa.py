"""IPA inspection: the app bundle's Info.plist, icon and embedded profile."""

import plistlib
import re
import struct
import zipfile
from pathlib import Path

from serversherpa_devices.packages import (
    ZIP_ERRORS,
    PackageError,
    PackageInfo,
    cgbi,
    converts_errors,
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
_MAX_ICON_CANDIDATES = 32
# A plain PNG's IHDR width and height end at byte 24; a CgBI file's 16-byte
# CgBI chunk comes first, pushing them to byte 40.
_ICON_HEAD_BYTES = 48
_PROFILE_LIMIT = provision.RAW_LIMIT
_MAX_ICON_BASES = 32
UNREADABLE = "The IPA can't be read"


@converts_errors(UNREADABLE)
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
                f"The build number {build[:40]} isn't up to four numbers separated by dots "
                "(the first at most 11 digits, the rest at most 9)"
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
    except MemoryError:
        raise
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
    bases = dict.fromkeys(f.removesuffix(".png") for f in files if isinstance(f, str) and f)
    return list(bases)[:_MAX_ICON_BASES]


def _icon_png(zf: zipfile.ZipFile, app_dir: str, info: dict, names: list[str]) -> bytes | None:
    """The largest file in the bundle matching a CFBundleIconFiles entry
    ("AppIcon60x60" matches AppIcon60x60.png, AppIcon60x60@3x.png and
    AppIcon60x60@2x~ipad.png), decoded from CgBI. Only the first
    _MAX_ICON_CANDIDATES matches are ranked, by the IHDR size in their first
    bytes (then by declared size), and only the winner is read in full."""
    bases = _icon_names(info)
    ranked = []
    for name in names:
        if len(ranked) >= _MAX_ICON_CANDIDATES:
            break
        if not name.startswith(app_dir) or not name.endswith(".png"):
            continue
        file = name[len(app_dir):]
        if "/" in file:
            continue
        stem = file.removesuffix(".png")
        if not any(stem == base or stem.startswith((base + "@", base + "~")) for base in bases):
            continue
        size = zf.getinfo(name).file_size
        if size <= _ICON_LIMIT:
            ranked.append((_png_area(_head(zf, name)), size, name))
    if not ranked:
        return None
    best = max(ranked)[2]
    data = read_member(zf, best, limit=_ICON_LIMIT)
    return cgbi.icon_png(cgbi.decode(data)) if data is not None else None


def _head(zf: zipfile.ZipFile, name: str) -> bytes:
    """The first _ICON_HEAD_BYTES of a member, or b"" when it can't be read."""
    try:
        with zf.open(name) as f:
            return f.read(_ICON_HEAD_BYTES)
    except ZIP_ERRORS:
        return b""


def _png_area(head: bytes) -> int:
    """Width x height from the IHDR chunk, wherever it sits in the first bytes
    (CgBI puts a chunk ahead of it); 0 when there isn't one."""
    at = head.find(b"IHDR", 8)
    if at < 0 or len(head) < at + 12:
        return 0
    width, height = struct.unpack(">II", head[at + 4:at + 12])
    return width * height
