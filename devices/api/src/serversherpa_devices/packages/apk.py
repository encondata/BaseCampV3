"""APK inspection through androguard."""

import hashlib
import io
import warnings
import zipfile
from pathlib import Path

from androguard.core.apk import APK
from loguru import logger
from PIL import Image

from serversherpa_devices.packages import (
    NOT_A_PACKAGE,
    PackageError,
    PackageInfo,
    open_zip,
    read_member,
)
from serversherpa_devices.packages.cgbi import PNG_SIGNATURE

logger.remove()   # androguard logs every parse step through loguru

UNREADABLE = "The APK can't be read"
TOO_LARGE = "This APK is too large to inspect."
# androguard inflates these two whole; the caps are on the declared
# (central directory) uncompressed sizes, checked before androguard runs.
_PARSED_MEMBERS = ("AndroidManifest.xml", "resources.arsc")
_PARSED_LIMIT = 32 * 1024 * 1024
_TOTAL_LIMIT = 2 * 1024 * 1024 * 1024
_ICON_LIMIT = 8 * 1024 * 1024
_ICON_MAX_PIXELS = 4096 * 4096


def inspect_apk(path: Path) -> PackageInfo:
    with open_zip(path) as zf:
        if "AndroidManifest.xml" not in zf.namelist():
            raise PackageError(NOT_A_PACKAGE)
        _check_declared_sizes(zf)
    try:
        apk = APK(str(path))
        package = apk.get_package()
        version_code = apk.get_androidversion_code()
    except Exception:  # noqa: BLE001 (androguard raises many types on a damaged manifest)
        raise PackageError(UNREADABLE) from None
    if not package or not version_code:
        raise PackageError(UNREADABLE)
    try:
        build_sort = int(version_code)
    except ValueError:
        raise PackageError(f"The versionCode {version_code} isn't a number") from None

    digest = _signing_digest(apk)
    if digest is None:
        raise PackageError("The APK isn't signed")
    return PackageInfo(
        platform="android",
        identifier=package,
        name=_safe(apk.get_app_name) or package,
        version_name=_safe(apk.get_androidversion_name) or str(version_code),
        build=str(version_code),
        build_sort=build_sort,
        min_os=_safe(apk.get_min_sdk_version) or None,
        icon_png=_icon_png(apk, path),
        signing_digest=digest,
        provision=None,
    )


def _check_declared_sizes(zf: zipfile.ZipFile) -> None:
    infos = zf.infolist()
    if sum(info.file_size for info in infos) > _TOTAL_LIMIT or any(
            info.filename in _PARSED_MEMBERS and info.file_size > _PARSED_LIMIT
            for info in infos):
        raise PackageError(TOO_LARGE)


def _safe(getter):
    try:
        return getter()
    except Exception:  # noqa: BLE001 (an optional field: any androguard failure means "absent")
        return None


def _signing_digest(apk: APK) -> str | None:
    """SHA-256 of the signer certificate DER: scheme v3, else v2, else v1."""
    for certs in (apk.get_certificates_der_v3, apk.get_certificates_der_v2,
                  lambda: [c.dump() for c in apk.get_certificates_v1()]):
        found = _safe(certs)
        if found:
            return hashlib.sha256(found[0]).hexdigest()
    return None


def _icon_png(apk: APK, path: Path) -> bytes | None:
    """The launcher icon (up to xxxhdpi) as PNG. An adaptive icon is XML and
    gives None; WebP and JPEG rasters are converted. The file is read through
    the size-capped zip reader, and images over _ICON_MAX_PIXELS give None."""
    icon_path = _safe(lambda: apk.get_app_icon(max_dpi=640))
    if not icon_path or icon_path.endswith(".xml"):
        return None
    with open_zip(path) as zf:
        data = read_member(zf, icon_path, limit=_ICON_LIMIT)
    if not data:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))   # reads the header only
            width, height = image.size
            if width * height > _ICON_MAX_PIXELS:
                return None
            if image.format == "PNG" and data.startswith(PNG_SIGNATURE):
                return data
            out = io.BytesIO()
            image.save(out, "PNG")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        return None
    return out.getvalue()
