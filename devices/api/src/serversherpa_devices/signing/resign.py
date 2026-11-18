"""rcodesign, and the IPA around it.

rcodesign signs a bundle directory, not an .ipa: the worker unpacks the IPA
(`unpack_ipa`), puts the profile in the app, signs it (`sign_app`; nested
bundles and Mach-Os are signed too, each extension with its own `-e`
entitlements, since entitlements aren't inherited) and zips Payload/ again
(`pack_ipa`), keeping symlinks as symlinks.

The certificate, its password and the entitlements go to rcodesign as
files: mode 0600 in a private (0700) temp directory, removed whatever
happens. The directory's path never reaches an error message.

rcodesign (0.29.0) decrypts only legacy PKCS#12 (SHA-1 and 3DES); a .p12
from OpenSSL 3 or cryptography's default (PBES2, AES-256) fails there as
"incorrect password". So the stored .p12 is opened here with its stored
password and handed over re-encoded in the legacy format, under a fresh
random password (`_legacy_p12`): whatever the stored password is, empty
included, rcodesign never sees it."""

import os
import plistlib
import secrets
import shutil
import stat
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath

import yaml
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs12

from serversherpa_devices.config import get_settings
from serversherpa_devices.signing import SignError

__all__ = ["SignError", "binary_entitlements", "find_app", "pack_ipa", "sign_app",
           "unpack_ipa"]

SIGN_TIMEOUT = 600            # seconds; well inside the queue's 30-minute stale window
INFO_TIMEOUT = 120
# What an unpacked IPA may add up to (Apple's own limit for an app is 4 GB).
UNPACK_LIMIT = 4 * 1024 ** 3
_LINK_LIMIT = 4096
_TAIL_LINES = 20
P12_UNREADABLE = "The Apple certificate (.p12) can't be opened with its saved password."
_LEGACY_KDF_ROUNDS = 50000


def _rcodesign() -> str:
    return get_settings().rcodesign_path


def _tail(text: str, secrets_dir: Path | None = None) -> str:
    """The last lines of rcodesign's output, without the secret directory."""
    if secrets_dir is not None:
        text = text.replace(f"{secrets_dir}{os.sep}", "").replace(str(secrets_dir), "")
    lines = [line.rstrip() for line in text.strip().splitlines()]
    return "\n".join(lines[-_TAIL_LINES:]) or "rcodesign failed without saying why."


def _run(argv: list[str], *, timeout: int, secrets_dir: Path | None = None,
         ) -> subprocess.CompletedProcess:
    try:
        done = subprocess.run(argv, capture_output=True, text=True, errors="replace",
                              timeout=timeout, check=False)
    except FileNotFoundError:
        raise SignError(f"rcodesign isn't installed (looked for {argv[0]!r}).") from None
    except subprocess.TimeoutExpired:
        raise SignError(f"rcodesign took longer than {timeout // 60} minutes.") from None
    if done.returncode != 0:
        raise SignError(_tail(done.stderr or done.stdout, secrets_dir))
    return done


def _write_private(path: Path, data: bytes) -> Path:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return path


def _legacy_p12(p12: bytes, password: str) -> tuple[bytes, str]:
    """The .p12's key and certificates as a legacy PKCS#12 (SHA-1 MAC,
    3DES) rcodesign can read, and the fresh password it's encrypted with.
    Raises SignError when the stored password doesn't open it."""
    try:
        stored = pkcs12.load_pkcs12(p12, password.encode() or None)
    except (ValueError, TypeError):
        raise SignError(P12_UNREADABLE) from None
    if stored.key is None or stored.cert is None:
        raise SignError(P12_UNREADABLE)
    temp_password = secrets.token_urlsafe(24)
    encryption = (serialization.PrivateFormat.PKCS12.encryption_builder()
                  .kdf_rounds(_LEGACY_KDF_ROUNDS)
                  .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
                  .hmac_hash(hashes.SHA1())
                  .build(temp_password.encode()))
    legacy = pkcs12.serialize_key_and_certificates(
        stored.cert.friendly_name, stored.key, stored.cert.certificate,
        [c.certificate for c in stored.additional_certs] or None, encryption)
    return legacy, temp_password


def sign_app(app_dir: Path, *, p12: bytes, password: str, entitlements: dict,
             extension_entitlements: dict[str, dict] | None = None) -> None:
    """Sign `app_dir` (Payload/X.app) in place with the .p12 (opened with
    `password`). `entitlements` are the app's; `extension_entitlements`
    maps a path inside the app ("PlugIns/Widget.appex") to that bundle's.
    Raises SignError."""
    legacy, temp_password = _legacy_p12(p12, password)
    secrets_dir = Path(tempfile.mkdtemp(prefix="devices-sign-"))   # 0700
    try:
        p12_file = _write_private(secrets_dir / "cert.p12", legacy)
        password_file = _write_private(secrets_dir / "password", temp_password.encode())
        main_file = _write_private(secrets_dir / "entitlements.plist",
                                   plistlib.dumps(entitlements))
        argv = [_rcodesign(), "sign", "--p12-file", str(p12_file),
                "--p12-password-file", str(password_file), "-e", str(main_file)]
        for i, (scope, ents) in enumerate(sorted((extension_entitlements or {}).items())):
            path = _write_private(secrets_dir / f"extension-{i}.plist", plistlib.dumps(ents))
            argv += ["-e", f"{scope}:{path}"]
        argv.append(str(app_dir))
        _run(argv, timeout=SIGN_TIMEOUT, secrets_dir=secrets_dir)
    finally:
        shutil.rmtree(secrets_dir, ignore_errors=True)


def binary_entitlements(macho: Path) -> dict:
    """The entitlements a Mach-O is signed with now (the first
    `entitlements_plist` rcodesign print-signature-info shows); {} when it
    has none."""
    done = _run([_rcodesign(), "print-signature-info", str(macho)], timeout=INFO_TIMEOUT)
    try:
        found = next(_values(yaml.safe_load(done.stdout), "entitlements_plist"), None)
        # rcodesign 0.29.0 prints the plist as a list of lines; older ones as one string
        if isinstance(found, list):
            if not all(isinstance(line, str) for line in found):
                raise ValueError("entitlements_plist isn't text")
            found = "\n".join(found)
        if not isinstance(found, str) or not found.strip():
            return {}
        parsed = plistlib.loads(found.encode())
    except (yaml.YAMLError, plistlib.InvalidFileException, ValueError):
        raise SignError(f"The entitlements of {macho.name} can't be read.") from None
    return parsed if isinstance(parsed, dict) else {}


def _values(node, key: str):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            yield from _values(v, key)
    elif isinstance(node, list):
        for item in node:
            yield from _values(item, key)


# The IPA.

def _member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if not name or name.startswith("/") or "\\" in name or ".." in path.parts:
        raise SignError("The IPA has a file outside its own folder.")
    return path


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return info.create_system == 3 and stat.S_ISLNK(info.external_attr >> 16)


def _inside(path: Path, root: Path) -> bool:
    real = Path(os.path.realpath(path))
    return real == root or root in real.parents


def unpack_ipa(ipa: Path, dest: Path) -> Path:
    """Extract the IPA into `dest` (symlinks as symlinks, Unix modes kept)
    and return its Payload/X.app. Refuses entries or links that reach
    outside `dest`. Raises SignError."""
    dest.mkdir(parents=True, exist_ok=True)
    root = Path(os.path.realpath(dest))
    try:
        with zipfile.ZipFile(ipa) as zf:
            infos = zf.infolist()
            if sum(info.file_size for info in infos) > UNPACK_LIMIT:
                raise SignError("The IPA is too large to unpack.")
            links: list[tuple[Path, str]] = []
            # Files and folders first, links last: nothing is written through a link.
            for info in infos:
                target = root / _member_path(info.filename)
                if _is_symlink(info):
                    with zf.open(info) as src:
                        link = src.read(_LINK_LIMIT + 1)
                    if len(link) > _LINK_LIMIT:
                        raise SignError("The IPA has a link that can't be read.")
                    links.append((target, link.decode("utf-8", errors="replace")))
                elif info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, open(target, "wb") as out:
                        shutil.copyfileobj(src, out, 1024 * 1024)
                    mode = info.external_attr >> 16
                    if info.create_system == 3 and stat.S_ISREG(mode):
                        target.chmod((mode & 0o777) | 0o600)
            for target, link in links:
                if link.startswith("/"):
                    raise SignError("The IPA has a link outside its own folder.")
                target.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(link, target)
                if not _inside(target, root):
                    raise SignError("The IPA has a link outside its own folder.")
            # A link can lead through one made after it: check them all again.
            if not all(_inside(target, root) for target, _ in links):
                raise SignError("The IPA has a link outside its own folder.")
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, OSError, ValueError) as exc:
        raise SignError(f"The IPA can't be unpacked ({type(exc).__name__}).") from None
    return find_app(root)


def find_app(root: Path) -> Path:
    payload = root / "Payload"
    apps = [p for p in payload.iterdir() if p.suffix == ".app" and p.is_dir()
            and not p.is_symlink()] if payload.is_dir() and not payload.is_symlink() else []
    if not apps:
        raise SignError("The IPA has no app in Payload/.")
    if len(apps) > 1:
        raise SignError("The IPA has more than one app in Payload/.")
    return apps[0]


def _zip_time(mtime: float) -> tuple[int, int, int, int, int, int]:
    # A zip can't hold a time before 1980 (zipfile's strict_timestamps=False rule).
    return max(time.localtime(mtime)[:6], (1980, 1, 1, 0, 0, 0))


def pack_ipa(root: Path, out: Path) -> None:
    """Zip root/Payload into `out` with Payload/ at the zip's root, as
    `zip -y` would: links stay links, Unix modes are kept."""
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, strict_timestamps=False) as zf:
        for current, dirs, files in os.walk(root / "Payload"):
            here = Path(current)
            arc_dir = here.relative_to(root).as_posix()
            zf.write(here, arc_dir + "/")
            for name in sorted(dirs + files):
                path = here / name
                arcname = f"{arc_dir}/{name}"
                if path.is_symlink():
                    info = zipfile.ZipInfo(arcname, _zip_time(path.lstat().st_mtime))
                    info.create_system = 3
                    info.external_attr = (stat.S_IFLNK | 0o755) << 16
                    info.compress_type = zipfile.ZIP_STORED
                    zf.writestr(info, os.readlink(path))
                elif path.is_file():
                    zf.write(path, arcname)
            dirs[:] = sorted(d for d in dirs if not (here / d).is_symlink())
