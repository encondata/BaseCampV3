"""Builders for IPA test inputs: CgBI icons (the decoder run in reverse), CMS-
signed provisioning profiles with a self-made certificate, and IPA zips."""

import datetime as dt
import plistlib
import struct
import zipfile
import zlib
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import pkcs7
from cryptography.x509.oid import NameOID

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_chunk(kind: bytes, body: bytes) -> bytes:
    crc = zlib.crc32(kind + body) & 0xFFFFFFFF
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)


def make_cgbi(width: int, height: int, rgba: bytes) -> bytes:
    """An Apple CgBI PNG of straight-alpha RGBA pixels: premultiplied, stored
    BGRA, raw deflate, a CgBI chunk ahead of IHDR. Odd rows use the Sub filter
    so the decoder's channel swap is exercised on filtered scanlines."""
    assert len(rgba) == width * height * 4
    stored = bytearray()
    for i in range(0, len(rgba), 4):
        r, g, b, a = rgba[i:i + 4]
        stored += bytes((b * a // 255, g * a // 255, r * a // 255, a))
    stride = width * 4
    rows = bytearray()
    for y in range(height):
        line = stored[y * stride:(y + 1) * stride]
        if y % 2:
            sub = bytes((line[x] - (line[x - 4] if x >= 4 else 0)) & 0xFF
                        for x in range(stride))
            rows += b"\x01" + sub
        else:
            rows += b"\x00" + line
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    idat = deflate.compress(bytes(rows)) + deflate.flush()
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    half = len(idat) // 2   # two IDAT chunks, as real files often have
    return (PNG_SIGNATURE + png_chunk(b"CgBI", b"\x50\x00\x20\x06")
            + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat[:half])
            + png_chunk(b"IDAT", idat[half:]) + png_chunk(b"IEND", b""))


def gradient_pixels(width: int, height: int, *, alpha: int = 255) -> bytes:
    out = bytearray()
    for y in range(height):
        for x in range(width):
            out += bytes(((x * 37) % 256, (y * 53) % 256, (x * y * 11) % 256, alpha))
    return bytes(out)


def make_provision(*, devices: list[str] | None = None, all_devices: bool = False,
                   get_task_allow: bool = False, team_id: str = "TEAM123456",
                   uuid: str = "3f1c6c1e-0000-4000-8000-000000000001",
                   name: str = "Hello Ad Hoc",
                   expires: dt.datetime = dt.datetime(2027, 11, 17, 12, 30, tzinfo=dt.UTC),
                   ) -> bytes:
    """A DER CMS SignedData provisioning profile wrapping an XML plist."""
    profile: dict = {
        "AppIDName": "Hello",
        "TeamIdentifier": [team_id],
        "TeamName": "Fixture Team",
        "UUID": uuid,
        "Name": name,
        "ExpirationDate": expires,
        "CreationDate": expires - dt.timedelta(days=365),
        "Entitlements": {
            "application-identifier": f"{team_id}.com.example.hello",
            "com.apple.developer.team-identifier": team_id,
            "get-task-allow": get_task_allow,
            "keychain-access-groups": [f"{team_id}.*"],
        },
    }
    if devices is not None:
        profile["ProvisionedDevices"] = devices
    if all_devices:
        profile["ProvisionsAllDevices"] = True
    xml = plistlib.dumps(profile, fmt=plistlib.FMT_XML)

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fixture Signer")])
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=30))
            .sign(key, hashes.SHA256()))
    return (pkcs7.PKCS7SignatureBuilder().set_data(xml).add_signer(cert, key, hashes.SHA256())
            .sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.Binary]))


def hello_info_plist(**overrides) -> dict:
    info = {
        "CFBundleIdentifier": "com.example.hello",
        "CFBundleDisplayName": "Hello Display",
        "CFBundleName": "Hello",
        "CFBundleShortVersionString": "1.4",
        "CFBundleVersion": "1.10",
        "CFBundleExecutable": "Hello",
        "MinimumOSVersion": "16.0",
        "CFBundleIcons": {"CFBundlePrimaryIcon": {"CFBundleIconFiles": ["AppIcon60x60"]}},
    }
    info.update(overrides)
    return {k: v for k, v in info.items() if v is not None}


def make_ipa(path: Path, *, info: dict | None = None,
             files: dict[str, bytes] | None = None, app: str = "Hello.app") -> Path:
    """A zip with Payload/<app>/Info.plist as a binary plist, plus `files`
    (names relative to the zip root), written in the order given (`files`
    first, so extension plists come before the app's own)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in (files or {}).items():
            zf.writestr(name, data)
        if info is not None:
            zf.writestr(f"Payload/{app}/Info.plist",
                        plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
    return path


def member_data_span(path: Path, name: str) -> tuple[int, int]:
    """(offset, length) of a member's stored (compressed) bytes in the file."""
    with zipfile.ZipFile(path) as zf:
        info = zf.getinfo(name)
    raw = path.read_bytes()
    name_len, extra_len = struct.unpack("<HH", raw[info.header_offset + 26:info.header_offset + 30])
    return info.header_offset + 30 + name_len + extra_len, info.compress_size


def flip_member_bytes(path: Path, name: str, count: int = 8) -> Path:
    """Corrupt the middle of a member's compressed stream."""
    start, length = member_data_span(path, name)
    raw = bytearray(path.read_bytes())
    for i in range(start + length // 3, min(start + length // 3 + count, start + length)):
        raw[i] ^= 0x5A
    path.write_bytes(bytes(raw))
    return path


def patch_central_directory(path: Path, *, extract_version: int | None = None,
                            uncompressed: dict[str, int] | None = None,
                            local_too: bool = False) -> Path:
    """Rewrite central-directory fields in place: every entry's "version
    needed to extract", and the uncompressed size of named entries (and of
    their local headers when `local_too`)."""
    raw = bytearray(path.read_bytes())
    at = raw.find(b"PK\x01\x02")
    while at >= 0:
        (name_len,) = struct.unpack("<H", raw[at + 28:at + 30])
        (local_at,) = struct.unpack("<I", raw[at + 42:at + 46])
        name = raw[at + 46:at + 46 + name_len].decode()
        if extract_version is not None:
            raw[at + 6:at + 8] = struct.pack("<H", extract_version)
        if uncompressed and name in uncompressed:
            raw[at + 24:at + 28] = struct.pack("<I", uncompressed[name])
            if local_too:
                raw[local_at + 22:local_at + 26] = struct.pack("<I", uncompressed[name])
        at = raw.find(b"PK\x01\x02", at + 46)
    path.write_bytes(bytes(raw))
    return path


def lying_bomb_apk(path: Path, *, inflated_bytes: int) -> Path:
    """An APK whose AndroidManifest.xml inflates to `inflated_bytes` of zeros
    while both its local and central headers claim 1000 bytes."""
    chunk = bytes(1024 * 1024)
    with (zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf,
          zf.open("AndroidManifest.xml", "w") as member):
        for _ in range(inflated_bytes // len(chunk)):
            member.write(chunk)
    return patch_central_directory(path, uncompressed={"AndroidManifest.xml": 1000},
                                   local_too=True)
