"""IPA inspection and CgBI icon decoding, on IPAs built in each test."""

import io
import plistlib
import struct
import zipfile
import zlib

import pytest
from PIL import Image

from serversherpa_devices.packages import PackageError, inspect_package, ipa
from serversherpa_devices.packages.cgbi import decode
from serversherpa_devices.packages.ipa import inspect_ipa

from .package_fixtures import (
    PNG_SIGNATURE,
    gradient_pixels,
    hello_info_plist,
    make_cgbi,
    make_ipa,
    make_provision,
    png_chunk,
)

UDIDS = ["00008110-000A1B2C3D4E5F60", "00008120-0011223344556677"]


def _pixels(png: bytes) -> tuple[tuple[int, int], bytes]:
    image = Image.open(io.BytesIO(png))
    assert image.format == "PNG"
    return image.size, image.convert("RGBA").tobytes()


def test_ipa_reads_info_plist(tmp_path):
    big = gradient_pixels(180, 180)
    ipa = make_ipa(tmp_path / "Hello.ipa", info=hello_info_plist(), files={
        "Payload/Hello.app/AppIcon60x60@2x.png": make_cgbi(120, 120, gradient_pixels(120, 120)),
        "Payload/Hello.app/AppIcon60x60@3x.png": make_cgbi(180, 180, big),
        "Payload/Hello.app/AppIcon76x76@2x~ipad.png": make_cgbi(152, 152, gradient_pixels(152, 152)),
        "Payload/Hello.app/embedded.mobileprovision": make_provision(devices=UDIDS),
    })
    info = inspect_ipa(ipa)
    assert info.platform == "ios"
    assert info.identifier == "com.example.hello"
    assert info.name == "Hello Display"
    assert info.version_name == "1.4"
    assert info.build == "1.10"
    assert info.build_sort == 10**27 + 10 * 10**18
    assert info.min_os == "16.0"
    assert info.signing_digest is None
    assert _pixels(info.icon_png) == ((180, 180), big)   # the largest AppIcon60x60 match
    assert info.provision.kind == "adhoc"
    assert info.provision.devices == UDIDS
    assert inspect_package(ipa).identifier == "com.example.hello"


def test_ipa_icon_candidates_are_capped(tmp_path, monkeypatch):
    # 40 matching icons, each n x n, the biggest last: only the first 32 are
    # ranked (by their headers), and only the winner is read in full.
    icons = {f"Payload/Hello.app/AppIcon60x60@{n}.png": make_cgbi(n, n, gradient_pixels(n, n))
             for n in range(1, 41)}
    path = make_ipa(tmp_path / "Hello.ipa", info=hello_info_plist(), files=icons)
    full_reads = []
    real_read_member = ipa.read_member

    def spy(zf, name, *, limit):
        full_reads.append(name)
        return real_read_member(zf, name, limit=limit)

    monkeypatch.setattr(ipa, "read_member", spy)
    info = inspect_ipa(path)
    assert [n for n in full_reads if n.endswith(".png")] == [
        "Payload/Hello.app/AppIcon60x60@32.png"]
    assert _pixels(info.icon_png) == ((32, 32), gradient_pixels(32, 32))


def test_ipa_name_falls_back_to_bundle_name(tmp_path):
    ipa = make_ipa(tmp_path / "Hello.ipa", info=hello_info_plist(CFBundleDisplayName=None))
    info = inspect_ipa(ipa)
    assert info.name == "Hello"
    assert info.icon_png is None      # the icon files the plist names aren't in the bundle
    assert info.provision is None     # no embedded.mobileprovision


def test_ipa_ignores_extension_plists(tmp_path):
    widget = plistlib.dumps({"CFBundleIdentifier": "com.example.hello.widget",
                             "CFBundleVersion": "99", "CFBundleShortVersionString": "9.9"},
                            fmt=plistlib.FMT_BINARY)
    framework = plistlib.dumps({"CFBundleIdentifier": "com.example.kit",
                                "CFBundleVersion": "7"}, fmt=plistlib.FMT_BINARY)
    ipa = make_ipa(tmp_path / "Hello.ipa", info=hello_info_plist(), files={
        "Payload/Hello.app/PlugIns/Widget.appex/Info.plist": widget,
        "Payload/Hello.app/Frameworks/Kit.framework/Info.plist": framework,
        "Payload/Hello.app/Watch/Hello Watch.app/Info.plist": widget,
    })
    info = inspect_ipa(ipa)
    assert (info.identifier, info.build, info.version_name) == ("com.example.hello", "1.10", "1.4")


def test_ipa_without_payload_raises(tmp_path):
    no_payload = tmp_path / "flat.ipa"
    with zipfile.ZipFile(no_payload, "w") as zf:
        zf.writestr("Hello.app/Info.plist", plistlib.dumps(hello_info_plist()))
    nested_only = make_ipa(tmp_path / "nested.ipa", files={
        "Payload/Hello.app/PlugIns/Widget.appex/Info.plist": plistlib.dumps(hello_info_plist()),
    })
    for path in (no_payload, nested_only):
        with pytest.raises(PackageError) as caught:
            inspect_ipa(path)
        assert caught.value.message == "The IPA has no app inside Payload/"


def test_ipa_with_two_apps_raises(tmp_path):
    ipa = make_ipa(tmp_path / "two.ipa", info=hello_info_plist(), files={
        "Payload/Other.app/Info.plist": plistlib.dumps(hello_info_plist()),
    })
    with pytest.raises(PackageError) as caught:
        inspect_ipa(ipa)
    assert caught.value.message == "The IPA has more than one app inside Payload/"


def test_ipa_missing_identity_raises(tmp_path):
    no_id = make_ipa(tmp_path / "noid.ipa", info=hello_info_plist(CFBundleIdentifier=None))
    with pytest.raises(PackageError) as caught:
        inspect_ipa(no_id)
    assert caught.value.message == "The app's Info.plist has no bundle ID"
    bad_build = make_ipa(tmp_path / "bad.ipa", info=hello_info_plist(CFBundleVersion="1.0b3"))
    with pytest.raises(PackageError) as caught:
        inspect_ipa(bad_build)
    assert caught.value.message == (
        "The build number 1.0b3 isn't up to four numbers separated by dots "
        "(the first at most 11 digits, the rest at most 9)")


def test_cgbi_round_trip_matches_original_pixels():
    opaque = gradient_pixels(7, 5)
    assert _pixels(decode(make_cgbi(7, 5, opaque))) == ((7, 5), opaque)

    # Premultiplying loses precision, so a translucent color comes back as
    # (c * a // 255) * 255 // a, at most 2 below the original at alpha 128;
    # fully transparent pixels keep only alpha.
    translucent = gradient_pixels(6, 4, alpha=128)
    size, back = _pixels(decode(make_cgbi(6, 4, translucent)))
    assert size == (6, 4)
    expected = bytes(v if i % 4 == 3 else (v * 128 // 255) * 255 // 128
                     for i, v in enumerate(translucent))
    assert back == expected
    assert max(a - b for a, b in zip(translucent, back, strict=True)) == 2
    clear = gradient_pixels(3, 3, alpha=0)
    assert _pixels(decode(make_cgbi(3, 3, clear)))[1][3::4] == bytes(9)


def test_cgbi_passes_normal_png_through_and_rejects_unsupported():
    normal = io.BytesIO()
    Image.new("RGBA", (4, 4), (1, 2, 3, 255)).save(normal, "PNG")
    assert decode(normal.getvalue()) == normal.getvalue()
    assert decode(b"not a png") == b"not a png"

    gray = struct.pack(">IIBBBBB", 2, 2, 8, 0, 0, 0, 0)   # 8-bit grayscale CgBI
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    idat = deflate.compress(b"\x00\x00\x00" * 2) + deflate.flush()
    gray_cgbi = (PNG_SIGNATURE + png_chunk(b"CgBI", b"\x50\x00\x20\x06")
                 + png_chunk(b"IHDR", gray) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b""))
    assert decode(gray_cgbi) is None

    truncated = make_cgbi(8, 8, gradient_pixels(8, 8))[:60]
    assert decode(truncated) is None
