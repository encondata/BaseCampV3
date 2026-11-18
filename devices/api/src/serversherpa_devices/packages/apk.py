"""APK inspection through androguard."""

import hashlib
import io
from pathlib import Path

from androguard.core.apk import APK
from loguru import logger
from PIL import Image

from serversherpa_devices.packages import (
    NOT_A_PACKAGE,
    PackageError,
    PackageInfo,
    open_zip,
)
from serversherpa_devices.packages.cgbi import PNG_SIGNATURE

logger.remove()   # androguard logs every parse step through loguru

UNREADABLE = "The APK can't be read"


def inspect_apk(path: Path) -> PackageInfo:
    with open_zip(path) as zf:
        if "AndroidManifest.xml" not in zf.namelist():
            raise PackageError(NOT_A_PACKAGE)
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
        icon_png=_icon_png(apk),
        signing_digest=digest,
        provision=None,
    )


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


def _icon_png(apk: APK) -> bytes | None:
    """The launcher icon (up to xxxhdpi) as PNG. An adaptive icon is XML and
    gives None; WebP and JPEG rasters are converted."""
    icon_path = _safe(lambda: apk.get_app_icon(max_dpi=640))
    if not icon_path or icon_path.endswith(".xml"):
        return None
    data = _safe(lambda: apk.get_file(icon_path))
    if not data:
        return None
    if data.startswith(PNG_SIGNATURE):
        return data
    try:
        out = io.BytesIO()
        Image.open(io.BytesIO(data)).save(out, "PNG")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return None
    return out.getvalue()
