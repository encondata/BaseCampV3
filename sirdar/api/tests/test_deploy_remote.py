import pytest

from sirdar_api.deploy import ConnectFailed, gitref, known_hosts, ssh

from .ssh_server import ssh_config, ssh_server  # noqa: F401

REPO = "https://github.com/encondata/BaseCampV3.git"
LS = f"git ls-remote {REPO}"
SHA_MAIN = "1" * 40
SHA_TAG = "2" * 40
SHA_TAG_OBJECT = "3" * 40
CAT = "cat -- /opt/serversherpa/uat/.env"


async def _trust(db, fake):
    await known_hosts.trust(db, fake.host, fake.port, fake.fingerprint, actor_id=None)
    await db.commit()


async def test_pinned_host_key(db, ssh_server):
    with pytest.raises(ssh.HostKeyUnknown):
        await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    await _trust(db, ssh_server)
    pinned = await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    assert (pinned.key_type, pinned.fingerprint) == ("ssh-ed25519", ssh_server.fingerprint)
    assert pinned.public_key.startswith("ssh-ed25519 ")
    assert ssh_server.commands == []


async def test_run_command_returns_output_and_status(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.overrides[CAT] = "STACK_ENV=uat\n"
    result = await ssh.run_command(ssh_config(ssh_server), db, CAT)
    assert (result.exit_status, result.stdout) == (0, "STACK_ENV=uat\n")
    assert "STACK_ENV" not in repr(result)
    ssh_server.exits[CAT] = 1
    result = await ssh.run_command(ssh_config(ssh_server), db, CAT)
    assert result.exit_status == 1


async def test_run_command_refuses_an_untrusted_host(db, ssh_server):
    with pytest.raises(ssh.HostKeyUnknown):
        await ssh.run_command(ssh_config(ssh_server), db, "true")
    assert ssh_server.commands == []


async def test_run_command_timeout_is_no_answer(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.overrides["slow"] = "late\n"
    ssh_server.delays["slow"] = 5
    result = await ssh.run_command(ssh_config(ssh_server), db, "slow", timeout=0.5)
    assert (result.exit_status, result.stdout) == (None, "")


async def test_run_command_wrong_password(db, ssh_server):
    await _trust(db, ssh_server)
    with pytest.raises(ConnectFailed) as exc:
        await ssh.run_command(ssh_config(ssh_server, deploy_ssh_password="nope"), db, "true")
    assert exc.value.reason == "The SSH server rejected the username, password or key."


def test_known_hosts_lines():
    assert known_hosts.openssh_line("10.0.0.5", 22, "ssh-ed25519 AAAA comment") == \
        "10.0.0.5 ssh-ed25519 AAAA"
    assert known_hosts.openssh_line("10.0.0.5", 2222, "ssh-ed25519 AAAA") == \
        "[10.0.0.5]:2222 ssh-ed25519 AAAA"
    assert known_hosts.host_key_algorithms("ssh-rsa") == "rsa-sha2-512,rsa-sha2-256"
    assert known_hosts.host_key_algorithms("ssh-ed25519") == "ssh-ed25519"
    assert known_hosts.host_key_algorithms("ecdsa-sha2-nistp256") == "ecdsa-sha2-nistp256"


def test_pick_sha_prefers_branch_then_peeled_tag():
    out = (f"{SHA_MAIN}\trefs/heads/main\n{SHA_TAG_OBJECT}\trefs/tags/v1\n"
           f"{SHA_TAG}\trefs/tags/v1^{{}}\n")
    assert gitref.pick_sha(out, "main") == SHA_MAIN
    assert gitref.pick_sha(out, "v1") == SHA_TAG
    assert gitref.pick_sha(f"{SHA_TAG_OBJECT}\trefs/tags/v2\n", "v2") == SHA_TAG_OBJECT
    assert gitref.pick_sha("junk\n", "main") is None


@pytest.mark.parametrize("ref", ["main", "release/2026-10", "v1.2.3", "feature_x", "HEAD"])
def test_valid_refs(ref):
    assert gitref.valid_ref(ref)


@pytest.mark.parametrize("ref", ["", "-x", "a..b", "a b", "a;b", "$(x)", "x/", "x.lock",
                                 "a" * 201, "ref\n", "a'b"])
def test_invalid_refs(ref):
    assert not gitref.valid_ref(ref)


async def test_resolve_a_branch(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.overrides[f"{LS} main"] = f"{SHA_MAIN}\trefs/heads/main\n"
    assert await gitref.resolve_ref(ssh_config(ssh_server), db, REPO, "main") == SHA_MAIN
    assert ssh_server.commands == [f"{LS} main"]


async def test_a_full_sha_runs_nothing_but_needs_a_trusted_host(db, ssh_server):
    cfg = ssh_config(ssh_server)
    with pytest.raises(ssh.HostKeyUnknown):
        await gitref.resolve_ref(cfg, db, REPO, "a" * 40)
    await _trust(db, ssh_server)
    assert await gitref.resolve_ref(cfg, db, REPO, "ABCDEF" + "0" * 34) == "abcdef" + "0" * 34
    assert ssh_server.commands == []


async def test_resolve_errors(db, ssh_server):
    await _trust(db, ssh_server)
    cfg = ssh_config(ssh_server)
    for ref in ("-x", "a..b"):
        with pytest.raises(gitref.RefError) as exc:
            await gitref.resolve_ref(cfg, db, REPO, ref)
        assert exc.value.code == "ref_invalid"
    assert ssh_server.commands == []

    ssh_server.overrides[f"{LS} nope"] = ""
    with pytest.raises(gitref.RefError) as exc:
        await gitref.resolve_ref(cfg, db, REPO, "nope")
    assert exc.value.code == "ref_not_found"

    ssh_server.overrides[f"{LS} main"] = ""
    ssh_server.exits[f"{LS} main"] = 127
    with pytest.raises(gitref.RefError) as exc:
        await gitref.resolve_ref(cfg, db, REPO, "main")
    assert exc.value.code == "git_missing"

    ssh_server.exits[f"{LS} main"] = 128
    with pytest.raises(gitref.RefError) as exc:
        await gitref.resolve_ref(cfg, db, REPO, "main")
    assert exc.value.code == "ref_lookup_failed"
