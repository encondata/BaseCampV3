import os

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog
from sirdar_api.deploy.ssh_targets import SshTargetStore

from .api_helpers import auth_headers
from .ssh_server import KEY_PASSPHRASE, SSH_PASSWORD, SSH_USER, ssh_server  # noqa: F401
from .test_deploy_api import SECRETS, bodies, deploy_env  # noqa: F401

SAVED_PW = "saved-PW-secret-77"
SAVED_PP = "saved-PP-secret-88"
ALL_SECRETS = (*SECRETS, SAVED_PW, SAVED_PP)


@pytest.fixture
def store_env(deploy_env, tmp_path, monkeypatch):
    """deploy_env plus a writable targets file and a keys dir in tmp_path."""
    cfg = tmp_path / "config"
    cfg.mkdir()
    keys = tmp_path / "keys"
    keys.mkdir()
    (keys / "id_ed25519").write_text("k\n")
    (keys / "b_key").write_text("k\n")
    (keys / ".hidden").write_text("k\n")
    (keys / "sub").mkdir()
    path = cfg / "deploy-targets.env"

    def apply(keys_dir=keys, **values):
        monkeypatch.setenv("SIRDAR_DEPLOY_TARGETS_FILE", str(path))
        deploy_env(keys_dir=keys_dir, **values)
    apply()
    return {"path": path, "keys": keys, "apply": apply}


@pytest.fixture
def secret_bodies(bodies):
    yield bodies
    for text in bodies:
        for secret in (SAVED_PW, SAVED_PP):
            assert secret not in text


def _new(**over):
    body = {"name": "Edge Box", "host": "10.20.30.40", "port": 2222, "user": "deployer",
            "password": SAVED_PW}
    body.update(over)
    return body


async def _audits(db, prefix="deploy.target_"):
    rows = await db.scalars(select(AuditLog).where(AuditLog.action.like(f"{prefix}%"))
                            .order_by(AuditLog.id))
    return [(r.action, r.entity_id, r.changes) for r in rows]


async def test_crud_round_trip(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/ssh-targets", headers=h,
                             json=_new(key_path="id_ed25519", key_passphrase=SAVED_PP))
    assert resp.status_code == 201, resp.text
    created = {"slug": "edge-box", "name": "Edge Box", "host": "10.20.30.40", "port": 2222,
               "user": "deployer", "key_path": "id_ed25519", "password_set": True,
               "passphrase_set": True}
    assert resp.json() == created
    assert (await client.get("/api/deploy/ssh-targets/edge-box", headers=h)).json() == created

    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"name": "Edge Box 2", "port": 22})
    assert resp.status_code == 200
    assert resp.json() == {**created, "name": "Edge Box 2", "port": 22}

    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"password": "", "key_passphrase": ""})
    assert resp.json()["password_set"] is False and resp.json()["passphrase_set"] is False
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"password": SAVED_PW})
    assert resp.json()["password_set"] is True

    assert (await client.delete("/api/deploy/ssh-targets/edge-box", headers=h)).status_code \
        == 204
    for method in ("GET", "PUT", "DELETE"):
        resp = await client.request(method, "/api/deploy/ssh-targets/edge-box", headers=h,
                                    **({"json": {}} if method == "PUT" else {}))
        assert resp.status_code == 404
        assert resp.json() == {"detail": {"code": "target_not_found"}}

    audits = await _audits(db)
    assert [a[0] for a in audits] == ["deploy.target_add", "deploy.target_update",
                                      "deploy.target_update", "deploy.target_update",
                                      "deploy.target_remove"]
    assert {a[1] for a in audits} == {"ssh:edge-box"}
    assert audits[0][2] == {"name": "Edge Box", "host": "10.20.30.40", "port": 2222,
                            "user": "deployer", "key_path": "id_ed25519",
                            "password_set": True, "passphrase_set": True}
    assert audits[1][2]["changed"] == ["name", "port"]
    assert audits[2][2]["changed"] == ["password", "key_passphrase"]
    assert audits[2][2]["password_set"] is False
    assert audits[4][2]["name"] == "Edge Box 2"
    for _, _, changes in audits:
        for secret in ALL_SECRETS:
            assert secret not in repr(changes)


async def test_partial_update_keeps_omitted_secrets(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    await client.post("/api/deploy/ssh-targets", headers=h,
                      json=_new(key_path="id_ed25519", key_passphrase=SAVED_PP))
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"host": "deploy.example.com"})
    assert resp.status_code == 200
    body = resp.json()
    assert (body["host"], body["password_set"], body["passphrase_set"]) == (
        "deploy.example.com", True, True)
    text = store_env["path"].read_text()
    assert SAVED_PW in text and SAVED_PP in text
    assert (await _audits(db))[-1][2]["changed"] == ["host"]


async def test_validation_errors(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    for over, code in (({"name": "x"}, "name_invalid"), ({"host": "no such host"}, "host_invalid"),
                       ({"port": 70000}, "port_invalid"), ({"user": "a b"}, "user_invalid"),
                       ({"key_path": "../id"}, "key_file_invalid"),
                       ({"key_path": "missing"}, "key_file_not_found"),
                       ({"password": None}, "auth_required"),
                       ({"password": "a\nb"}, "value_invalid")):
        resp = await client.post("/api/deploy/ssh-targets", headers=h, json=_new(**over))
        assert resp.status_code == 422, over
        assert resp.json() == {"detail": {"code": code}}, over
    assert (await client.post("/api/deploy/ssh-targets", headers=h, json=_new())).status_code \
        == 201
    resp = await client.post("/api/deploy/ssh-targets", headers=h, json=_new(name="EDGE BOX"))
    assert resp.status_code == 422 and resp.json() == {"detail": {"code": "name_taken"}}

    # clearing the only auth method
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h, json={"password": ""})
    assert resp.status_code == 422 and resp.json() == {"detail": {"code": "auth_required"}}
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"key_path": "nope"})
    assert resp.status_code == 422 and resp.json() == {"detail": {"code": "key_file_not_found"}}
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"password": "", "key_path": "id_ed25519"})
    assert resp.status_code == 200 and resp.json()["password_set"] is False
    assert [a[0] for a in await _audits(db)] == ["deploy.target_add", "deploy.target_update"]


async def test_installer_target_is_read_only(client, db, store_env, secret_bodies):
    store_env["apply"](ssh_host="10.0.0.1", ssh_user="root", ssh_password=SSH_PASSWORD)
    h = await auth_headers(client, db)
    for method in ("GET", "PUT", "DELETE"):
        resp = await client.request(method, "/api/deploy/ssh-targets/ssh", headers=h,
                                    **({"json": {"name": "Hijack"}} if method == "PUT" else {}))
        assert resp.status_code == 404
        assert resp.json() == {"detail": {"code": "target_not_found"}}


async def test_unwritable_file_is_500_without_paths(client, db, store_env, secret_bodies):
    store_env["path"].parent.chmod(0o500)
    try:
        h = await auth_headers(client, db)
        resp = await client.post("/api/deploy/ssh-targets", headers=h, json=_new())
        assert resp.status_code == 500
        detail = resp.json()["detail"]
        assert detail["code"] == "targets_file_unwritable"
        assert str(store_env["path"].parent) not in resp.text
        assert "/" not in detail["message"]
        listed = (await client.get("/api/deploy/targets", headers=h)).json()
        assert listed["can_add_ssh"] is False
        assert listed["ssh_store_hint"] == "deploy-targets.env isn't writable; see the README."
    finally:
        store_env["path"].parent.chmod(0o700)
    assert await _audits(db) == []


async def test_key_files(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/key-files", headers=h)
    assert resp.status_code == 200
    assert resp.json() == {"files": ["b_key", "id_ed25519"]}
    outside = store_env["path"].parent / "outside"
    outside.write_text("x\n")
    (store_env["keys"] / "linked").symlink_to(outside)
    (store_env["keys"] / "linked_dir").symlink_to(store_env["keys"] / "sub")
    resp = await client.get("/api/deploy/key-files", headers=h)
    assert resp.json() == {"files": ["b_key", "id_ed25519"]}
    store_env["apply"](keys_dir=store_env["keys"] / "missing")
    assert (await client.get("/api/deploy/key-files", headers=h)).json() == {"files": []}


async def test_permissions(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    assert (await client.post("/api/deploy/ssh-targets", headers=h, json=_new())).status_code \
        == 201
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get("/api/deploy/targets", headers=admin)).status_code == 200
    for method, url, kw in (
            ("GET", "/api/deploy/ssh-targets/edge-box", {}),
            ("POST", "/api/deploy/ssh-targets", {"json": _new(name="Other")}),
            ("PUT", "/api/deploy/ssh-targets/edge-box", {"json": {"name": "Other"}}),
            ("DELETE", "/api/deploy/ssh-targets/edge-box", {}),
            ("GET", "/api/deploy/key-files", {})):
        resp = await client.request(method, url, headers=admin, **kw)
        assert resp.status_code == 403, (method, url)
        assert (await client.request(method, url, **kw)).status_code == 401
    store = SshTargetStore(store_env["path"], store_env["keys"])
    assert [t.name for t in store.load()] == ["Edge Box"]


async def test_targets_listing(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    body = (await client.get("/api/deploy/targets", headers=h)).json()
    assert [t["id"] for t in body["targets"]] == ["aws", "gcp", "digitalocean"]
    assert [t["kind"] for t in body["targets"]] == ["aws", "gcp", "digitalocean"]
    assert body["can_add_ssh"] is True and body["ssh_store_hint"] is None

    await client.post("/api/deploy/ssh-targets", headers=h, json=_new())
    await client.post("/api/deploy/ssh-targets", headers=h,
                      json=_new(name="Alpha", host="alpha.example.net", user="ops"))
    store_env["apply"](ssh_host="10.9.8.7", ssh_user="root")      # installer, no auth yet
    resp = await client.get("/api/deploy/targets", headers=h)
    assert resp.json()["targets"][3:] == [
        {"id": "ssh", "label": "Custom (SSH) · Installer", "kind": "ssh", "source": "installer",
         "available": True, "configured": False},
        {"id": "ssh:edge-box", "label": "Edge Box", "kind": "ssh", "source": "saved",
         "available": True, "configured": True},
        {"id": "ssh:alpha", "label": "Alpha", "kind": "ssh", "source": "saved",
         "available": True, "configured": True}]
    for detail in ("10.9.8.7", "root", "10.20.30.40", "alpha.example.net", "deployer", "ops",
                   "2222"):
        assert detail not in resp.text


async def test_connect_unknown_saved_target(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    for target in ("ssh:nope", "ssh:"):
        resp = await client.post("/api/deploy/connect", headers=h,
                                 json={"target": target, "type": "dev"})
        assert resp.status_code in (400, 422)
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "ssh:nope", "type": "dev"})
    assert resp.status_code == 400
    assert resp.json() == {"detail": {"code": "target_not_configured"}}
    for bad in ("ssh:Bad Slug", "ssh:" + "a" * 33, "sshx"):
        resp = await client.post("/api/deploy/connect", headers=h,
                                 json={"target": bad, "type": "dev"})
        assert resp.status_code == 422, bad


async def test_saved_target_connect_and_tofu_end_to_end(client, db, store_env, ssh_server,
                                                        secret_bodies):
    # the keys dir holds the fake server's authorized key, locked with a passphrase
    store_env["apply"](keys_dir=ssh_server.keys_dir)
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/ssh-targets", headers=h, json=_new(
        name="Lab Box", host="127.0.0.1", port=ssh_server.port, user=SSH_USER, password=None,
        key_path="id_locked", key_passphrase=KEY_PASSPHRASE))
    assert resp.status_code == 201, resp.text
    connect = {"target": "ssh:lab-box", "type": "dev"}

    resp = await client.post("/api/deploy/connect", headers=h, json=connect)
    assert resp.status_code == 409
    d = resp.json()["detail"]
    assert (d["code"], d["host"], d["port"], d["fingerprint"]) == (
        "host_key_unknown", "127.0.0.1", ssh_server.port, ssh_server.fingerprint)

    trust = {"host": "127.0.0.1", "port": ssh_server.port, "fingerprint": ssh_server.fingerprint}
    resp = await client.post("/api/deploy/known-hosts", headers=h,
                             json={**trust, "port": ssh_server.port + 1})
    assert resp.status_code == 400 and resp.json() == {"detail": {"code": "not_configured_host"}}
    resp = await client.post("/api/deploy/known-hosts", headers=h, json=trust)
    assert resp.status_code == 200, resp.text

    resp = await client.post("/api/deploy/connect", headers=h, json=connect)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["ok"], body["target"]) == (True, "ssh:lab-box")
    assert body["facts"]["auth"] == "key" and body["facts"]["user"] == SSH_USER

    url = f"/api/deploy/known-hosts?host=127.0.0.1&port={ssh_server.port}"
    assert (await client.delete(url, headers=h)).status_code == 204
    resp = await client.post("/api/deploy/connect", headers=h, json=connect)
    assert resp.json()["detail"]["code"] == "host_key_unknown"

    connects = [r.changes for r in await db.scalars(
        select(AuditLog).where(AuditLog.action == "deploy.connect").order_by(AuditLog.id))]
    assert [(c["target"], c["ok"]) for c in connects] == [
        ("ssh:lab-box", False), ("ssh:lab-box", True), ("ssh:lab-box", False)]
    host_audits = [(a, c) for a, _, c in await _audits(db, "deploy.host_")]
    assert [a for a, _ in host_audits] == ["deploy.host_trust", "deploy.host_forget"]
    assert host_audits[0][1]["target"] == "ssh:lab-box"
    assert host_audits[1][1]["target"] == "ssh:lab-box"
    for changes in await db.scalars(select(AuditLog.changes)):
        for secret in ALL_SECRETS:
            assert secret not in repr(changes)
    assert oct(os.stat(store_env["path"]).st_mode & 0o777) == "0o600"


async def test_targets_file_change_applies_without_restart(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    store_env["path"].write_text("SIRDAR_SSH_TARGETS=x1\nSIRDAR_SSH_X1_NAME='Hand Made'\n"
                                 "SIRDAR_SSH_X1_HOST=h\nSIRDAR_SSH_X1_USER=u\n"
                                 f"SIRDAR_SSH_X1_PASSWORD='{SAVED_PW}'\n")
    ids = [t["id"] for t in (await client.get("/api/deploy/targets", headers=h)).json()["targets"]]
    assert ids[-1] == "ssh:x1"
    assert get_settings().deploy_targets_file == str(store_env["path"])


# ---- security fix round ------------------------------------------------------

SEPARATORS = ["\n", "\r", "\x00", "\t", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85",
              "\u2028", "\u2029"]


@pytest.mark.parametrize("sep", SEPARATORS, ids=[f"U+{ord(c):04X}" for c in SEPARATORS])
async def test_separator_injection_rejected(client, db, store_env, secret_bodies, sep):
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/ssh-targets", headers=h,
                             json=_new(name="Victim", host="10.1.1.1"))
    assert resp.status_code == 201, resp.text
    evil = f"x{sep}SIRDAR_SSH_VICTIM_HOST=6.6.6.6{sep}"
    resp = await client.post("/api/deploy/ssh-targets", headers=h,
                             json=_new(name="Evil", password=evil))
    assert resp.status_code == 422
    assert resp.json() == {"detail": {"code": "value_invalid"}}
    resp = await client.put("/api/deploy/ssh-targets/victim", headers=h,
                            json={"key_passphrase": evil, "key_path": "id_ed25519"})
    assert resp.status_code == 422
    assert resp.json() == {"detail": {"code": "value_invalid"}}
    resp = await client.get("/api/deploy/ssh-targets/victim", headers=h)
    assert resp.json()["host"] == "10.1.1.1"
    assert [t.slug for t in SshTargetStore(store_env["path"], store_env["keys"]).load()] \
        == ["victim"]
    assert "6.6.6.6" not in store_env["path"].read_text()


async def test_ipv6_zone_id_rejected(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/ssh-targets", headers=h,
                             json=_new(host="fe80::1%x' y"))
    assert resp.status_code == 422 and resp.json() == {"detail": {"code": "host_invalid"}}


async def test_422_bodies_never_echo_secrets(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    long_pw = SAVED_PW + "L" * 1100
    resp = await client.post("/api/deploy/ssh-targets", headers=h, json=_new(password=long_pw))
    assert resp.status_code == 422
    assert resp.json() == {"detail": {"code": "password_too_long"}}
    resp = await client.post("/api/deploy/ssh-targets", headers=h,
                             json=_new(key_path="id_ed25519", key_passphrase=SAVED_PP * 100))
    assert resp.status_code == 422
    assert resp.json() == {"detail": {"code": "passphrase_too_long"}}
    assert (await client.post("/api/deploy/ssh-targets", headers=h, json=_new())).status_code \
        == 201
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"password": long_pw})
    assert resp.status_code == 422 and SAVED_PW not in resp.text

    # wrong types: pydantic errors, but no "input" / "ctx" in the body
    for body in (_new(password={"pw": SAVED_PW}), _new(password=[SAVED_PW]),
                 _new(key_passphrase={"pp": SAVED_PP}), _new(port=SAVED_PW)):
        resp = await client.post("/api/deploy/ssh-targets", headers=h, json=body)
        assert resp.status_code == 422, body
        for item in resp.json()["detail"]:
            assert "input" not in item and "ctx" not in item
        assert SAVED_PW not in resp.text and SAVED_PP not in resp.text
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"key_passphrase": {"x": SAVED_PP}})
    assert resp.status_code == 422 and SAVED_PP not in resp.text


async def test_put_audit_changed_comes_from_locked_read(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    assert (await client.post("/api/deploy/ssh-targets", headers=h, json=_new())).status_code \
        == 201
    resp = await client.put("/api/deploy/ssh-targets/edge-box", headers=h,
                            json={"name": "Edge Box", "port": 2200, "password": "other-pw"})
    assert resp.status_code == 200
    assert (await _audits(db))[-1][2]["changed"] == ["port", "password"]
    resp = await client.put("/api/deploy/ssh-targets/nope", headers=h, json={"port": 22})
    assert resp.status_code == 404 and resp.json() == {"detail": {"code": "target_not_found"}}


async def test_invalid_utf8_file_is_500_unreadable(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    store_env["path"].write_bytes(b"SIRDAR_SSH_TARGETS='a'\n\xff\xfe\n")
    for method, url, body in (("POST", "/api/deploy/ssh-targets", _new()),
                              ("PUT", "/api/deploy/ssh-targets/a", {"port": 22}),
                              ("GET", "/api/deploy/ssh-targets/a", None)):
        resp = await client.request(method, url, headers=h, json=body)
        assert resp.status_code == 500, (method, resp.text)
        assert resp.json()["detail"]["code"] == "targets_file_unreadable"
        assert str(store_env["path"]) not in resp.text


async def test_invalid_utf8_file_lists_no_saved_targets(client, db, store_env, secret_bodies):
    h = await auth_headers(client, db)
    store_env["path"].write_bytes(b"SIRDAR_SSH_TARGETS='a'\n\xff\xfe\n")
    resp = await client.get("/api/deploy/targets", headers=h)
    assert resp.status_code == 200
    assert not [t for t in resp.json()["targets"] if t.get("source") == "saved"]
