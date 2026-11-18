"""Package inspection: what an uploaded APK or IPA says about itself."""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from serversherpa_devices.packages.provision import ProvisionInfo

NOT_A_PACKAGE = "This isn't an APK or IPA"


class PackageError(Exception):
    """An upload that can't be read as an app. `message` is user-facing copy."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class PackageInfo:
    platform: Literal["android", "ios"]
    identifier: str
    name: str
    version_name: str
    build: str
    build_sort: int
    min_os: str | None
    icon_png: bytes | None
    signing_digest: str | None   # Android: SHA-256 hex of the signer certificate DER
    provision: ProvisionInfo | None


def open_zip(path: Path) -> zipfile.ZipFile:
    """The upload as a zip, or PackageError(NOT_A_PACKAGE)."""
    try:
        return zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise PackageError(NOT_A_PACKAGE) from None


def read_member(zf: zipfile.ZipFile, name: str, *, limit: int) -> bytes | None:
    """A zip member's bytes, or None when it is larger than `limit` (its
    declared size or what it actually inflates to) or can't be inflated."""
    try:
        info = zf.getinfo(name)
        if info.file_size > limit:
            return None
        with zf.open(info) as f:
            data = f.read(limit + 1)
    except (KeyError, zipfile.BadZipFile, OSError, ValueError, NotImplementedError,
            EOFError, RuntimeError):
        return None
    return data if len(data) <= limit else None


def inspect_package(path: Path) -> PackageInfo:
    """Inspect an APK or IPA, telling them apart by their contents."""
    from serversherpa_devices.packages.apk import inspect_apk
    from serversherpa_devices.packages.ipa import inspect_ipa

    with open_zip(path) as zf:
        names = zf.namelist()
    if "AndroidManifest.xml" in names:
        return inspect_apk(path)
    if any(name.startswith("Payload/") for name in names):
        return inspect_ipa(path)
    raise PackageError(NOT_A_PACKAGE)
