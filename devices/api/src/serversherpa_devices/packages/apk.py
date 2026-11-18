"""APK inspection through androguard. Uploads run this in the isolated
worker (isolated.py): androguard reads members through apkInspector, which
trusts local-header sizes and inflates without a limit, so only the child's
memory and CPU limits truly bound it. The declared-size check here is a cheap
first gate."""

import hashlib
import logging
import sys
import zipfile
from pathlib import Path

from loguru import logger

from serversherpa_devices.packages import (
    NOT_A_PACKAGE,
    PackageError,
    PackageInfo,
    converts_errors,
    open_zip,
    read_member,
)
from serversherpa_devices.packages.cgbi import icon_png


def _import_androguard():
    """androguard's APK class, with its logging kept out of the root logger:
    apkInspector calls logging.basicConfig(level=DEBUG) at import and logs
    through the root logger; androguard logs through loguru."""
    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    from androguard.core.apk import APK

    root.handlers[:] = saved_handlers   # undo apkInspector's basicConfig
    root.setLevel(saved_level)
    quiet = logging.getLogger("serversherpa_devices.apkinspector")
    quiet.propagate = False
    quiet.addHandler(logging.NullHandler())
    for name, module in list(sys.modules.items()):
        if name.startswith("apkInspector") and getattr(module, "logging", None) is logging:
            module.logging = _LoggingShim(quiet)
    logger.remove()
    return APK


class _LoggingShim:
    """Stands in for the `logging` module inside apkInspector's modules: its
    module-level logging.warning(...) calls go to a quiet named logger."""

    _CALLS = frozenset({"debug", "info", "warning", "error", "exception", "critical", "log"})

    def __init__(self, target: logging.Logger):
        self._target = target

    def __getattr__(self, name: str):
        if name in self._CALLS:
            return getattr(self._target, name)
        if name == "basicConfig":
            return lambda *args, **kwargs: None
        return getattr(logging, name)


APK = _import_androguard()

UNREADABLE = "The APK can't be read"
TOO_LARGE = "This APK is too large to inspect."
# androguard inflates these two whole; the caps are on the declared
# (central directory) uncompressed sizes, checked before androguard runs.
_PARSED_MEMBERS = ("AndroidManifest.xml", "resources.arsc")
_PARSED_LIMIT = 32 * 1024 * 1024
_TOTAL_LIMIT = 2 * 1024 * 1024 * 1024
_ICON_LIMIT = 8 * 1024 * 1024


@converts_errors(UNREADABLE)
def inspect_apk(path: Path) -> PackageInfo:
    with open_zip(path) as zf:
        if "AndroidManifest.xml" not in zf.namelist():
            raise PackageError(NOT_A_PACKAGE)
        _check_declared_sizes(zf)
    try:
        apk = APK(str(path))
        package = apk.get_package()
        version_code = apk.get_androidversion_code()
    except MemoryError:
        raise
    except Exception:  # noqa: BLE001 (androguard raises many types on a damaged manifest)
        raise PackageError(UNREADABLE) from None
    if not package or not version_code:
        raise PackageError(UNREADABLE)
    try:
        build_sort = int(version_code)
    except ValueError:
        raise PackageError(f"The versionCode {str(version_code)[:40]} isn't a number") from None

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
    except MemoryError:
        raise
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
    """The launcher icon (up to xxxhdpi) as PNG, read through the size-capped
    zip reader. An adaptive icon is XML and gives None; see cgbi.icon_png for
    the size and format check."""
    icon_path = _safe(lambda: apk.get_app_icon(max_dpi=640))
    if not isinstance(icon_path, str) or icon_path.endswith(".xml"):
        return None
    with open_zip(path) as zf:
        return icon_png(read_member(zf, icon_path, limit=_ICON_LIMIT))
