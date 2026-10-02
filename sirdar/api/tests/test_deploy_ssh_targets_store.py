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
    t = store.update("edge-box", {"name": "Renamed"})
    assert (t.slug, t.name) == ("edge-box", "Renamed")
    assert store.get("edge-box").name == "Renamed"


def test_update_secret_semantics(store):
    store.add(_fields(key_path="id_ed25519", key_passphrase="pp"))
    t = store.update("edge-box", {"host": "h.example.com"})
    assert (t.password, t.passphrase) == ("pw-1", "pp")
    t = store.update("edge-box", {"password": "", "key_passphrase": "new"})
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
    assert store.update("other", {"name": "OTHER"}).name == "OTHER"   # own name, new case


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
