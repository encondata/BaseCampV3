"""Re-signing pieces without rcodesign: the entitlements a profile allows,
the rcodesign command line and its secret files (subprocess swapped out),
and unpacking/packing IPAs."""

import datetime as dt
import os
import plistlib
import stat
import subprocess
import zipfile
from functools import cache
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from serversherpa_devices.packages.provision import ProvisionInfo
from serversherpa_devices.signing import entitlements, resign

TEAM = "TEAM123456"


def profile(**ents) -> ProvisionInfo:
    allowed = {
        "application-identifier": f"{TEAM}.com.example.hello",
        "com.apple.developer.team-identifier": TEAM,
        "get-task-allow": False,
        "keychain-access-groups": [f"{TEAM}.*"],
        **ents,
    }
    return ProvisionInfo(kind="adhoc", team_id=TEAM, uuid="u", name="n", expires_at=None,
                         devices=[], entitlements=allowed)


# Entitlements.

def test_entitlements_drop_unallowed_and_force_get_task_allow_false():
    binary = {
        "get-task-allow": True,
        "application-identifier": "OLDTEAM.com.example.hello",
        "com.apple.developer.team-identifier": "OLDTEAM",
        "aps-environment": "development",
        "com.apple.security.application-groups": ["group.com.example"],
        "com.apple.developer.icloud-services": ["CloudKit"],
    }
    got = entitlements.for_profile(binary, profile(**{"aps-environment": "production"}),
                                   bundle_id="com.example.hello")
    assert got == {
        "get-task-allow": False,
        "application-identifier": f"{TEAM}.com.example.hello",
        "com.apple.developer.team-identifier": TEAM,
        "aps-environment": "production",
    }
    assert binary["get-task-allow"] is True   # the input is left alone

    # A binary without the keys still gets them; a profile without push drops it.
    got = entitlements.for_profile({"aps-environment": "development"}, profile(),
                                   bundle_id="com.example.hello")
    assert got == {"get-task-allow": False,
                   "application-identifier": f"{TEAM}.com.example.hello",
                   "com.apple.developer.team-identifier": TEAM}


def test_entitlements_wildcard_keychain_group():
    binary = {"keychain-access-groups": [f"{TEAM}.com.example.hello", f"{TEAM}.shared",
                                         "OTHERTEAM.com.example.hello"]}
    got = entitlements.for_profile(binary, profile(), bundle_id="com.example.hello")
    assert got["keychain-access-groups"] == [f"{TEAM}.com.example.hello", f"{TEAM}.shared"]

    # A wildcard App ID allows the concrete one.
    wild = profile(**{"application-identifier": f"{TEAM}.*"})
    got = entitlements.for_profile({}, wild, bundle_id="com.example.hello")
    assert got["application-identifier"] == f"{TEAM}.com.example.hello"

    # Every group refused: the key goes.
    got = entitlements.for_profile({"keychain-access-groups": ["OTHERTEAM.x"]}, profile(),
                                   bundle_id="com.example.hello")
    assert "keychain-access-groups" not in got

    # A list the profile spells out exactly.
    domains = profile(**{"com.apple.developer.associated-domains": ["applinks:a.example"]})
    got = entitlements.for_profile(
        {"com.apple.developer.associated-domains": ["applinks:a.example", "applinks:b.example"]},
        domains, bundle_id="com.example.hello")
    assert got["com.apple.developer.associated-domains"] == ["applinks:a.example"]
    # ...or as "*".
    any_domain = profile(**{"com.apple.developer.associated-domains": "*"})
    got = entitlements.for_profile(
        {"com.apple.developer.associated-domains": ["applinks:b.example"]},
        any_domain, bundle_id="com.example.hello")
    assert got["com.apple.developer.associated-domains"] == ["applinks:b.example"]


def test_entitlements_need_a_team():
    nameless = profile()
    nameless.team_id = None
    with pytest.raises(resign.SignError):
        entitlements.for_profile({}, nameless, bundle_id="com.example.hello")


# sign_app and its secret files.

class FakeRun:
    def __init__(self, *, returncode: int = 0, stderr: str = "", stdout: str = "") -> None:
        self.returncode, self.stderr, self.stdout = returncode, stderr, stdout
        self.argv: list[str] = []
        self.seen: dict[str, tuple[int, bytes]] = {}

    def __call__(self, argv, **kwargs):
        self.argv = [str(a) for a in argv]
        for arg in self.argv:
            for part in arg.split(":"):
                path = Path(part)
                if path.is_absolute() and path.is_file():
                    self.seen[part] = (stat.S_IMODE(path.stat().st_mode), path.read_bytes())
        stderr = self.stderr
        if "{p12}" in stderr:
            stderr = stderr.replace("{p12}", self._after("--p12-file"))
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, stderr)

    def _after(self, flag: str) -> str:
        return self.argv[self.argv.index(flag) + 1]


@cache
def _identity():
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,
                                         f"Apple Distribution: Fixture ({TEAM})")])
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(7)
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=30))
            .sign(key, hashes.SHA256()))
    return key, cert


def _p12(password: str = "pw") -> bytes:
    """A .p12 the way OpenSSL 3 and cryptography make one today (PBES2,
    AES-256): the format rcodesign 0.29.0 can't read. No password: none."""
    key, cert = _identity()
    encryption = (serialization.BestAvailableEncryption(password.encode()) if password
                  else serialization.NoEncryption())
    return pkcs12.serialize_key_and_certificates(b"Fixture", key, cert, None, encryption)


# DER object identifiers, as they appear inside a PKCS#12 file
PBE_SHA1_3DES = bytes.fromhex("060a2a864886f70d010c0103")   # pbeWithSHAAnd3-KeyTripleDES-CBC
PBES2 = bytes.fromhex("06092a864886f70d01050d")             # 1.2.840.113549.1.5.13
SHA1 = bytes.fromhex("06052b0e03021a")                      # 1.3.14.3.2.26 (the MAC)


def _app(tmp_path: Path) -> Path:
    app = tmp_path / "Payload" / "Hello.app"
    (app / "PlugIns" / "Widget.appex").mkdir(parents=True, exist_ok=True)
    return app


def test_sign_app_command_line(tmp_path, monkeypatch):
    run = FakeRun()
    monkeypatch.setattr(resign.subprocess, "run", run)
    app = _app(tmp_path)
    resign.sign_app(app, p12=_p12(), password="pw", entitlements={"get-task-allow": False},
                    extension_entitlements={"PlugIns/Widget.appex": {"a": True}})

    argv = run.argv
    assert argv[:2] == ["rcodesign", "sign"]
    assert argv[-1] == str(app)
    p12, password = argv[argv.index("--p12-file") + 1], argv[argv.index("--p12-password-file") + 1]
    assert run.seen[p12][0] == 0o600
    assert run.seen[password][0] == 0o600
    flags = [argv[i + 1] for i, a in enumerate(argv) if a == "-e"]
    main, widget = flags
    assert plistlib.loads(run.seen[main][1]) == {"get-task-allow": False}
    scope, _, widget_file = widget.partition(":")
    assert scope == "PlugIns/Widget.appex"
    assert run.seen[widget_file][0] == 0o600
    assert plistlib.loads(run.seen[widget_file][1]) == {"a": True}
    assert not any(Path(p).exists() for p in run.seen)   # all removed afterwards


@pytest.mark.parametrize("stored_password", ["pw", "", "pässwörd with spaces"])
def test_sign_app_passes_rcodesign_a_legacy_p12(tmp_path, monkeypatch, stored_password):
    """rcodesign 0.29.0 reads only legacy PKCS#12 (SHA-1, 3DES): the stored
    .p12 is re-encoded under a fresh temporary password, whatever the
    stored one is (empty included)."""
    stored = _p12(stored_password)
    if stored_password:
        assert PBES2 in stored and PBE_SHA1_3DES not in stored
    run = FakeRun()
    monkeypatch.setattr(resign.subprocess, "run", run)
    resign.sign_app(_app(tmp_path), p12=stored, password=stored_password, entitlements={})

    argv = run.argv
    handed = run.seen[argv[argv.index("--p12-file") + 1]][1]
    temp_password = run.seen[argv[argv.index("--p12-password-file") + 1]][1]
    assert len(temp_password) >= 32 and temp_password != stored_password.encode()
    assert handed != stored
    assert PBE_SHA1_3DES in handed and PBES2 not in handed and SHA1 in handed
    loaded = pkcs12.load_pkcs12(handed, temp_password)
    key, cert = _identity()
    assert loaded.cert.certificate == cert
    assert loaded.key.private_numbers() == key.private_numbers()


def test_sign_app_each_run_gets_its_own_temporary_password(tmp_path, monkeypatch):
    seen = []
    for _ in range(2):
        run = FakeRun()
        monkeypatch.setattr(resign.subprocess, "run", run)
        resign.sign_app(_app(tmp_path), p12=_p12(), password="pw", entitlements={})
        seen.append(run.seen[run.argv[run.argv.index("--p12-password-file") + 1]][1])
    assert seen[0] != seen[1]


@pytest.mark.parametrize("p12, password", [(None, "wrong"), (b"not a p12", "pw")])
def test_sign_app_refuses_a_p12_its_password_doesnt_open(tmp_path, monkeypatch, p12, password):
    run = FakeRun()
    monkeypatch.setattr(resign.subprocess, "run", run)

    def no_temp_dir(*args, **kwargs):
        raise AssertionError("a secrets directory was made for an unreadable .p12")

    monkeypatch.setattr(resign.tempfile, "mkdtemp", no_temp_dir)
    with pytest.raises(resign.SignError) as failed:
        resign.sign_app(_app(tmp_path), p12=p12 or _p12(), password=password, entitlements={})
    assert str(failed.value) == resign.P12_UNREADABLE
    assert run.argv == []   # rcodesign never ran


def test_temp_secret_files_removed_on_failure(tmp_path, monkeypatch):
    lines = [f"line {i}" for i in range(30)] + ["error: can't read {p12}: bad password"]
    run = FakeRun(returncode=1, stderr="\n".join(lines))
    monkeypatch.setattr(resign.subprocess, "run", run)

    with pytest.raises(resign.SignError) as failed:
        resign.sign_app(_app(tmp_path), p12=_p12(), password="pw", entitlements={})
    message = str(failed.value)
    assert message.splitlines() == [*lines[-20:-1], "error: can't read cert.p12: bad password"]
    assert run.seen and not any(Path(p).exists() for p in run.seen)
    assert not any(str(Path(p).parent) in message for p in run.seen)


def test_sign_app_timeout_and_missing_tool(tmp_path, monkeypatch):
    def slow(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    monkeypatch.setattr(resign.subprocess, "run", slow)
    with pytest.raises(resign.SignError, match="took longer"):
        resign.sign_app(_app(tmp_path), p12=_p12(), password="pw", entitlements={})

    def missing(argv, **kwargs):
        raise FileNotFoundError(argv[0])

    monkeypatch.setattr(resign.subprocess, "run", missing)
    with pytest.raises(resign.SignError, match="rcodesign isn't installed"):
        resign.sign_app(_app(tmp_path), p12=_p12(), password="pw", entitlements={})


SIGNATURE_INFO = """\
- path: Hello
  file_size: 33432
  entity:
    mach_o:
      signature:
        code_directory:
          identifier: com.example.hello
          team_name: TEAM123456
        entitlements_plist: |
          <?xml version="1.0" encoding="UTF-8"?>
          <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
          <plist version="1.0">
          <dict>
            <key>get-task-allow</key>
            <true/>
          </dict>
          </plist>
"""


# What rcodesign 0.29.0 really prints (captured from the image, trimmed):
# entitlements_plist is a list of lines, not one string.
SIGNATURE_INFO_0_29 = """\
- path: Hello
  file_size: 33432
  entity:
    mach_o:
      signature:
        code_directory:
          version: '0x20400'
          identifier: com.example.hello
          digest_type: sha256
        entitlements_plist:
        - <?xml version="1.0" encoding="UTF-8"?>
        - <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        - <plist version="1.0">
        - <dict>
        - '  <key>application-identifier</key>'
        - '  <string>TEAM123456.com.example.hello</string>'
        - '  <key>get-task-allow</key>'
        - '  <false/>'
        - </dict>
        - </plist>
        entitlements_der_plist:
        - <?xml version="1.0" encoding="UTF-8"?>
        - <plist version="1.0">
        - '  <dict>'
        - '    <key>application-identifier</key>'
        - '    <string>TEAM123456.com.example.hello</string>'
        - '  </dict>'
        - </plist>
"""


def test_binary_entitlements_reads_0_29_list_of_lines(tmp_path, monkeypatch):
    monkeypatch.setattr(resign.subprocess, "run", FakeRun(stdout=SIGNATURE_INFO_0_29))
    assert resign.binary_entitlements(tmp_path / "Hello") == {
        "application-identifier": f"{TEAM}.com.example.hello", "get-task-allow": False}


@pytest.mark.parametrize("shape", ["[]", "[1, 2]", "''"])
def test_binary_entitlements_odd_shapes(tmp_path, monkeypatch, shape):
    out = f"- path: Hello\n  entitlements_plist: {shape}\n"
    monkeypatch.setattr(resign.subprocess, "run", FakeRun(stdout=out))
    if shape == "[1, 2]":
        with pytest.raises(resign.SignError, match="can't be read"):
            resign.binary_entitlements(tmp_path / "Hello")
    else:
        assert resign.binary_entitlements(tmp_path / "Hello") == {}


def test_binary_entitlements_reads_signature_info(tmp_path, monkeypatch):
    run = FakeRun(stdout=SIGNATURE_INFO)
    monkeypatch.setattr(resign.subprocess, "run", run)
    assert resign.binary_entitlements(tmp_path / "Hello") == {"get-task-allow": True}
    assert run.argv == ["rcodesign", "print-signature-info", str(tmp_path / "Hello")]

    monkeypatch.setattr(resign.subprocess, "run", FakeRun(stdout="- path: Hello\n"))
    assert resign.binary_entitlements(tmp_path / "Hello") == {}

    monkeypatch.setattr(resign.subprocess, "run", FakeRun(returncode=2, stderr="not Mach-O"))
    with pytest.raises(resign.SignError, match="not Mach-O"):
        resign.binary_entitlements(tmp_path / "Hello")


# Unpacking and packing.

def _symlink_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    return info


def _zip(path: Path, entries: list) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in entries:
            zf.writestr(name, data)
    return path


def test_unpack_and_pack_keep_symlinks_and_modes(tmp_path):
    exe = zipfile.ZipInfo("Payload/Hello.app/Hello")
    exe.create_system = 3
    exe.external_attr = (stat.S_IFREG | 0o755) << 16
    ipa = _zip(tmp_path / "in.ipa", [
        ("Payload/Hello.app/Info.plist", b"plist"),
        (exe, b"macho"),
        ("Payload/Hello.app/Frameworks/A.framework/A", b"lib"),
        (_symlink_info("Payload/Hello.app/Frameworks/Current"), "A.framework"),
    ])
    root = tmp_path / "work"
    app = resign.unpack_ipa(ipa, root)
    assert app == root / "Payload" / "Hello.app"
    assert os.readlink(app / "Frameworks" / "Current") == "A.framework"
    assert stat.S_IMODE((app / "Hello").stat().st_mode) == 0o755

    out = tmp_path / "out.ipa"
    resign.pack_ipa(root, out)
    with zipfile.ZipFile(out) as zf:
        link = zf.getinfo("Payload/Hello.app/Frameworks/Current")
        assert stat.S_ISLNK(link.external_attr >> 16)
        assert zf.read(link) == b"A.framework"
        assert stat.S_IMODE(zf.getinfo("Payload/Hello.app/Hello").external_attr >> 16) == 0o755
        assert zf.read("Payload/Hello.app/Frameworks/A.framework/A") == b"lib"
        assert "Payload/Hello.app/" in zf.namelist()
        assert all(n.startswith("Payload/") for n in zf.namelist())


@pytest.mark.parametrize("entries", [
    [("Payload/../evil", b"x")],
    [("/Payload/Hello.app/abs", b"x")],
    [(_symlink_info("Payload/Hello.app/out"), "../../..")],
    # Each link alone stays inside; together they climb out.
    [(_symlink_info("Payload/Hello.app/a/b"), ".."),
     (_symlink_info("Payload/Hello.app/a/c"), "b/../../../..")],
    [(_symlink_info("Payload/Hello.app/abs"), "/etc")],
], ids=["dotdot", "absolute", "link-out", "link-chain", "link-absolute"])
def test_unpack_rejects_escaping_entries(tmp_path, entries):
    ipa = _zip(tmp_path / "bad.ipa", [("Payload/Hello.app/Info.plist", b"plist"), *entries])
    with pytest.raises(resign.SignError):
        resign.unpack_ipa(ipa, tmp_path / "work")
    assert not (tmp_path / "evil").exists()


def test_unpack_needs_exactly_one_app(tmp_path):
    with pytest.raises(resign.SignError, match="no app"):
        resign.unpack_ipa(_zip(tmp_path / "none.ipa", [("Payload/readme", b"x")]),
                          tmp_path / "a")
    two = _zip(tmp_path / "two.ipa", [("Payload/A.app/Info.plist", b"x"),
                                      ("Payload/B.app/Info.plist", b"x")])
    with pytest.raises(resign.SignError, match="more than one app"):
        resign.unpack_ipa(two, tmp_path / "b")


def test_unpack_refuses_oversized(tmp_path, monkeypatch):
    monkeypatch.setattr(resign, "UNPACK_LIMIT", 10)
    ipa = _zip(tmp_path / "big.ipa", [("Payload/Hello.app/Info.plist", b"x" * 11)])
    with pytest.raises(resign.SignError, match="too large"):
        resign.unpack_ipa(ipa, tmp_path / "work")
