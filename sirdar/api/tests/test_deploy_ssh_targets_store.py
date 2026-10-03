import os
import stat
import threading

import pytest

from sirdar_api.deploy import ssh_targets
from sirdar_api.deploy.ssh_targets import SshTargetStore, TargetError


@pytest.fixture
def keys_dir(tmp_path):
    d = tmp_path / "deploy-keys"
    d.mkdir()
    (d / "id_ed25519").write_text("key\n")
    return d


@pytest.fixture
def store(tmp_path, keys_dir):
    cfg = tmp_path / "config"
    cfg.mkdir()
    return SshTargetStore(cfg / "deploy-targets.env", keys_dir)


def _fields(**over):
    f = dict(name="Edge Box", host="10.0.0.5", port=22, user="deployer", password="pw-1")
    f.update(over)
    return f


def test_missing_file_is_empty(store):
    assert store.load() == []
    assert store.get("nope") is None


def test_add_round_trip_and_format(store):
    t = store.add(_fields(port=2222, key_path="id_ed25519", key_passphrase="pp"))
    assert t.slug == "edge-box"
    assert (t.name, t.host, t.port, t.user, t.password, t.key_path, t.passphrase) == (
        "Edge Box", "10.0.0.5", 2222, "deployer", "pw-1", "id_ed25519", "pp")
    text = store.path.read_text()
    assert "SIRDAR_SSH_TARGETS='edge-box'\n" in text
    assert "SIRDAR_SSH_EDGE_BOX_NAME='Edge Box'\n" in text
    assert "SIRDAR_SSH_EDGE_BOX_PORT='2222'\n" in text
    assert "SIRDAR_SSH_EDGE_BOX_KEY_PATH='id_ed25519'\n" in text
    assert stat.S_IMODE(os.stat(store.path).st_mode) == 0o600
    assert store.load() == [t]
    assert store.get("edge-box") == t


@pytest.mark.parametrize("tricky", ["it's", "$HOME", "a b  c", "x # y", "'", "\"q\"", "\\n",
                                    "'\\''", "#"])
def test_tricky_values_round_trip(store, tricky):
    store.add(_fields(password=tricky, key_passphrase=tricky, key_path="id_ed25519"))
    t = store.load()[0]
    assert t.password == tricky and t.passphrase == tricky


def test_embedded_quote_escaping(store):
    store.add(_fields(password="it's"))
    assert "SIRDAR_SSH_EDGE_BOX_PASSWORD='it'\\''s'\n" in store.path.read_text()


def test_parser_accepts_unquoted_and_double_quoted(store):
    store.path.write_text(
        "SIRDAR_SSH_TARGETS=a,b\n"
        "SIRDAR_SSH_A_NAME=Alpha\nSIRDAR_SSH_A_HOST=h1.example.com\nSIRDAR_SSH_A_USER=root\n"
        "SIRDAR_SSH_A_PASSWORD=plain\n"
        'SIRDAR_SSH_B_NAME="Bravo Two"\nSIRDAR_SSH_B_HOST="h2"\nSIRDAR_SSH_B_PORT="2200"\n'
        'SIRDAR_SSH_B_USER="u"\nSIRDAR_SSH_B_PASSWORD="say \\"hi\\""\n')
    a, b = store.load()
    assert (a.slug, a.name, a.host, a.port, a.user, a.password) == (
        "a", "Alpha", "h1.example.com", 22, "root", "plain")
    assert (b.name, b.host, b.port, b.password) == ("Bravo Two", "h2", 2200, 'say "hi"')
    assert a.key_path == "" and a.passphrase is None


def test_foreign_lines_preserved(store):
    store.path.write_text("# Saved SSH targets\nOTHER=1\n\n# keep me\nZED='z'\n")
    store.add(_fields())
    store.add(_fields(name="Second"))
    store.remove("edge-box")
    text = store.path.read_text()
    for line in ("# Saved SSH targets", "OTHER=1", "# keep me", "ZED='z'"):
        assert line in text.splitlines()
    assert "EDGE_BOX" not in text
    assert [t.slug for t in store.load()] == ["second"]


def test_slug_rules_and_collisions(store):
    assert ssh_targets.slugify("  Edge -- Box!! ") == "edge-box"
    assert ssh_targets.slugify("!!") == "target"
    assert ssh_targets.slugify("x" * 50) == "x" * 32
    assert ssh_targets.slugify("a" * 31 + " b") == "a" * 31
    assert ssh_targets.key_for("edge-box-2") == "EDGE_BOX_2"
    a = store.add(_fields(name="Edge Box"))
    b = store.add(_fields(name="Edge  box!"))          # different name, same slug base
    c = store.add(_fields(name="edge-box?"))
    assert [a.slug, b.slug, c.slug] == ["edge-box", "edge-box-2", "edge-box-3"]
    long = store.add(_fields(name="y" * 40))
    long2 = store.add(_fields(name="y" * 39 + "!"))
    assert long.slug == "y" * 32 and long2.slug == "y" * 30 + "-2"
    assert [t.slug for t in store.load()] == [
        "edge-box", "edge-box-2", "edge-box-3", "y" * 32, "y" * 30 + "-2"]


def test_rename_keeps_slug(store):
    store.add(_fields())
    before, t = store.update("edge-box", {"name": "Renamed"})
    assert before.name == "Edge Box"
    assert (t.slug, t.name) == ("edge-box", "Renamed")
    assert store.get("edge-box").name == "Renamed"


def test_update_secret_semantics(store):
    store.add(_fields(key_path="id_ed25519", key_passphrase="pp"))
    _, t = store.update("edge-box", {"host": "h.example.com"})
    assert (t.password, t.passphrase) == ("pw-1", "pp")
    before, t = store.update("edge-box", {"password": "", "key_passphrase": "new"})
    assert (before.password, before.passphrase) == ("pw-1", "pp")
    assert (t.password, t.passphrase) == (None, "new")
    with pytest.raises(TargetError) as exc:
        store.update("edge-box", {"key_path": ""})
    assert exc.value.code == "auth_required"
    assert store.get("edge-box").key_path == "id_ed25519"


@pytest.mark.parametrize("field,value,code", [
    ("name", " a ", "name_invalid"), ("name", "x" * 41, "name_invalid"),
    ("host", "bad host", "host_invalid"), ("host", "-a.com", "host_invalid"),
    ("host", "a" * 64 + ".com", "host_invalid"), ("host", "", "host_invalid"),
    ("host", ".".join(["a" * 60] * 5), "host_invalid"),
    ("port", 0, "port_invalid"), ("port", 65536, "port_invalid"), ("port", True, "port_invalid"),
    ("user", "", "user_invalid"), ("user", "a b", "user_invalid"), ("user", "u" * 65, "user_invalid"),
    ("key_path", "../id", "key_file_invalid"), ("key_path", "sub/id", "key_file_invalid"),
    ("key_path", "a\\b", "key_file_invalid"), ("key_path", ".hidden", "key_file_invalid"),
    ("key_path", "..", "key_file_invalid"), ("key_path", "id_missing", "key_file_not_found"),
])
def test_validation_codes(store, field, value, code):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(**{field: value}))
    assert exc.value.code == code
    assert store.load() == []


def test_valid_hosts(store):
    for i, host in enumerate(("192.168.1.10", "::1", "fe80::1", "deploy-01.example.com",
                              "localhost", "a" * 63 + ".io")):
        store.add(_fields(name=f"Host {i}", host=host))
    assert len(store.load()) == 6


def test_auth_required_and_name_taken(store):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(password=None))
    assert exc.value.code == "auth_required"
    with pytest.raises(TargetError) as exc:
        store.add(_fields(password=""))
    assert exc.value.code == "auth_required"
    store.add(_fields())
    store.add(_fields(name="Other"))
    with pytest.raises(TargetError) as exc:
        store.add(_fields(name="  EDGE box "))
    assert exc.value.code == "name_taken"
    with pytest.raises(TargetError) as exc:
        store.update("other", {"name": "edge box"})
    assert exc.value.code == "name_taken"
    assert store.update("other", {"name": "OTHER"})[1].name == "OTHER"   # own name, new case


@pytest.mark.parametrize("bad", ["a\nb", "a\rb", "a\x00b"])
def test_newline_and_nul_rejected(store, bad):
    with pytest.raises(ValueError):
        store.add(_fields(password=bad))
    with pytest.raises(ValueError):
        store.add(_fields(name="Ok " + bad))
    assert not store.path.exists()


def test_unknown_slug(store):
    with pytest.raises(KeyError):
        store.update("nope", {"name": "x"})
    with pytest.raises(KeyError):
        store.remove("nope")


def test_atomic_rewrite_leaves_no_temp_files(store):
    store.add(_fields())
    store.update("edge-box", {"name": "Two"})
    store.remove("edge-box")
    names = sorted(p.name for p in store.path.parent.iterdir())
    assert names == ["deploy-targets.env", "deploy-targets.env.lock"]


def test_failed_write_keeps_old_file_and_cleans_up(store, monkeypatch):
    store.add(_fields())
    before = store.path.read_text()

    def boom(*a, **kw):
        raise OSError("disk full")
    monkeypatch.setattr(ssh_targets.os, "replace", boom)
    with pytest.raises(OSError):
        store.add(_fields(name="Second"))
    assert store.path.read_text() == before
    assert sorted(p.name for p in store.path.parent.iterdir()) == [
        "deploy-targets.env", "deploy-targets.env.lock"]


def test_concurrent_adds_under_lock(store):
    errors = []

    def worker(i):
        try:
            SshTargetStore(store.path, store.keys_dir).add(_fields(name=f"Box {i:02d}"))
        except Exception as e:  # pragma: no cover - surfaced below
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert sorted(t.name for t in store.load()) == [f"Box {i:02d}" for i in range(20)]


def test_hand_edited_junk_is_tolerated(store):
    store.path.write_text("SIRDAR_SSH_TARGETS=ok,,BAD SLUG,ok\nSIRDAR_SSH_OK_HOST='h\n"
                          "SIRDAR_SSH_OK_PORT=abc\nnot a line\n")
    [t] = store.load()
    assert (t.slug, t.name, t.port) == ("ok", "ok", 22)


# ---- security fix round ------------------------------------------------------

# Every character str.splitlines() breaks on, plus tab: none may reach the file.
SEPARATORS = ["\n", "\r", "\x00", "\t", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85",
              "\u2028", "\u2029"]


@pytest.mark.parametrize("sep", SEPARATORS, ids=[f"U+{ord(c):04X}" for c in SEPARATORS])
@pytest.mark.parametrize("field", ["name", "host", "user", "key_path", "password",
                                   "key_passphrase"])
def test_separator_chars_rejected_in_every_field(store, field, sep):
    store.add(_fields(name="Victim", host="10.0.0.9"))
    before = store.path.read_text()
    with pytest.raises(ValueError):
        store.add({**_fields(name="Evil"),
                   field: f"x{sep}SIRDAR_SSH_VICTIM_HOST=6.6.6.6{sep}"})
    with pytest.raises(ValueError):
        store.update("victim", {field: f"x{sep}y"})
    assert store.path.read_text() == before
    assert store.get("victim").host == "10.0.0.9"


@pytest.mark.parametrize("sep", ["\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028",
                                 "\u2029"])
def test_parser_splits_on_newline_only(store, sep):
    # A hand-written value holding a non-\n line break stays one line on read
    # and on rewrite, so it can't become a second key.
    store.path.write_text(
        "SIRDAR_SSH_TARGETS='victim'\n"
        "SIRDAR_SSH_VICTIM_NAME='Victim'\nSIRDAR_SSH_VICTIM_HOST='10.0.0.9'\n"
        "SIRDAR_SSH_VICTIM_USER='u'\n"
        f"SIRDAR_SSH_VICTIM_PASSWORD='x{sep}SIRDAR_SSH_VICTIM_HOST=6.6.6.6'\n"
        "FOREIGN=1\r\n")
    [t] = store.load()
    assert t.host == "10.0.0.9"
    assert t.password == f"x{sep}SIRDAR_SSH_VICTIM_HOST=6.6.6.6"


def test_crlf_file_still_parses(store):
    store.path.write_text("SIRDAR_SSH_TARGETS='a'\r\nSIRDAR_SSH_A_HOST='h1'\r\n"
                          "SIRDAR_SSH_A_USER='u'\r\nSIRDAR_SSH_A_PASSWORD='p'\r\n# c\r\n")
    [t] = store.load()
    assert (t.host, t.user, t.password) == ("h1", "u", "p")
    store.update("a", {"name": "Alpha"})
    text = store.path.read_text()
    assert "\r" not in text and "# c\n" in text


@pytest.mark.parametrize("host", ["fe80::1%eth0", "fe80::1%x' y", "fe80::1%25eth0", "%"])
def test_ipv6_zone_ids_rejected(store, host):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(host=host))
    assert exc.value.code == "host_invalid"


def test_secret_length_capped(store):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(password="p" * 1025))
    assert exc.value.code == "password_too_long"
    with pytest.raises(TargetError) as exc:
        store.add(_fields(key_path="id_ed25519", key_passphrase="p" * 1025))
    assert exc.value.code == "passphrase_too_long"
    assert store.add(_fields(password="p" * 1024)).password == "p" * 1024


def test_symlinked_key_file_rejected(store, keys_dir, tmp_path):
    outside = tmp_path / "outside_key"
    outside.write_text("secret\n")
    (keys_dir / "link_key").symlink_to(outside)
    with pytest.raises(TargetError) as exc:
        store.add(_fields(key_path="link_key"))
    assert exc.value.code == "key_file_invalid"


def test_lock_file_symlink_not_followed(store, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    store.lock_path.symlink_to(elsewhere)
    with pytest.raises(OSError):
        store.add(_fields())
    assert not elsewhere.exists()


def test_directory_fsynced_after_replace(store, monkeypatch):
    synced = []
    real = ssh_targets.os.fsync

    def spy(fd):
        synced.append(stat.S_ISDIR(os.fstat(fd).st_mode))
        return real(fd)
    monkeypatch.setattr(ssh_targets.os, "fsync", spy)
    store.add(_fields())
    assert synced == [False, True]


def test_invalid_utf8_raises_unicode_error(store):
    store.path.write_bytes(b"SIRDAR_SSH_TARGETS='a'\n\xff\xfe\n")
    with pytest.raises(UnicodeDecodeError):
        store.add(_fields())


def test_sudo_password_round_trip_and_write_only(store):
    t = store.add(_fields(sudo_password="sudo-PW-1"))
    assert t.sudo_password == "sudo-PW-1"
    assert "SIRDAR_SSH_EDGE_BOX_SUDO_PASS='sudo-PW-1'\n" in store.path.read_text()
    assert t.public()["sudo_password_set"] is True
    assert "sudo-PW-1" not in repr(t)
    _, t = store.update("edge-box", {"host": "h.example.com"})
    assert t.sudo_password == "sudo-PW-1"
    _, t = store.update("edge-box", {"sudo_password": ""})
    assert t.sudo_password is None
    assert "SUDO_PASS" not in store.path.read_text()
    assert store.load()[0].public()["sudo_password_set"] is False


def test_sudo_password_never_satisfies_auth(store):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(password=None, sudo_password="sudo-only"))
    assert exc.value.code == "auth_required"


def test_sudo_password_length_capped(store):
    with pytest.raises(TargetError) as exc:
        store.add(_fields(sudo_password="p" * 1025))
    assert exc.value.code == "sudo_password_too_long"
    assert store.add(_fields(sudo_password="p" * 1024)).sudo_password == "p" * 1024


def test_sudo_key_never_collides_with_another_targets_password(store):
    store.add(_fields(name="Ab", sudo_password="sudo-of-ab"))
    store.add(_fields(name="Ab Sudo", password="pw-of-ab-sudo"))
    ab, ab_sudo = store.load()
    assert (ab.slug, ab.password, ab.sudo_password) == ("ab", "pw-1", "sudo-of-ab")
    assert (ab_sudo.slug, ab_sudo.password, ab_sudo.sudo_password) == (
        "ab-sudo", "pw-of-ab-sudo", None)
