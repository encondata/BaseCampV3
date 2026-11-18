"""The real rcodesign on a fixture .app: a one-line arm64 Mach-O, signed with
a self-made distribution certificate. Skipped unless rcodesign is on PATH
and clang can build the binary (run with `pytest -m signer`)."""

import datetime as dt
import plistlib
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from serversherpa_devices.packages import provision
from serversherpa_devices.signing import entitlements, resign

from .package_fixtures import make_provision

TEAM = "TEAM123456"
PASSWORD = "fixture password"

pytestmark = [
    pytest.mark.signer,
    pytest.mark.skipif(shutil.which("rcodesign") is None, reason="rcodesign isn't on PATH"),
    pytest.mark.skipif(shutil.which("clang") is None, reason="clang isn't installed"),
]


@pytest.fixture(autouse=True)
def rcodesign_on_path(monkeypatch):
    from serversherpa_devices.config import get_settings

    monkeypatch.setenv("DEVICES_RCODESIGN_PATH", shutil.which("rcodesign") or "rcodesign")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _p12() -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([
        x509.NameAttribute(NameOID.USER_ID, TEAM),
        x509.NameAttribute(NameOID.COMMON_NAME, f"Apple Distribution: Fixture ({TEAM})"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEAM),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Fixture"),
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
    ])
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=30))
            .sign(key, hashes.SHA256()))
    return pkcs12.serialize_key_and_certificates(
        b"Fixture", key, cert, None, serialization.BestAvailableEncryption(PASSWORD.encode()))


def _fixture_app(tmp_path: Path) -> Path:
    app = tmp_path / "Payload" / "Hello.app"
    app.mkdir(parents=True)
    source = tmp_path / "main.c"
    source.write_text("int main(void) { return 0; }\n")
    built = subprocess.run(
        ["clang", "-arch", "arm64", "-o", str(app / "Hello"), str(source)],
        capture_output=True, text=True, check=False)
    if built.returncode != 0:
        pytest.skip(f"clang can't build an arm64 Mach-O here: {built.stderr.strip()[-200:]}")
    (app / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": "com.example.hello", "CFBundleExecutable": "Hello",
        "CFBundleName": "Hello", "CFBundleShortVersionString": "1.0", "CFBundleVersion": "1"}))
    (app / "embedded.mobileprovision").write_bytes(make_provision(
        devices=["00008110-000A1B2C3D4E5F60"], team_id=TEAM))
    return app


def _values(node, key: str):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            yield from _values(v, key)
    elif isinstance(node, list):
        for item in node:
            yield from _values(item, key)


def test_rcodesign_signs_fixture_app(tmp_path):
    app = _fixture_app(tmp_path)
    profile = provision.parse((app / "embedded.mobileprovision").read_bytes())
    wanted = entitlements.for_profile(resign.binary_entitlements(app / "Hello"), profile,
                                      bundle_id="com.example.hello")

    resign.sign_app(app, p12=_p12(), password=PASSWORD, entitlements=wanted)

    assert resign.binary_entitlements(app / "Hello") == wanted
    info = yaml.safe_load(subprocess.run(
        ["rcodesign", "print-signature-info", str(app / "Hello")],
        capture_output=True, text=True, check=True).stdout)
    teams = {str(v) for key in ("team_name", "team_id") for v in _values(info, key)}
    assert TEAM in teams
    assert (app / "_CodeSignature" / "CodeResources").is_file()
