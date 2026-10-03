import pytest
from cryptography.fernet import Fernet
from sqlalchemy import func, select

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, EnvironmentSecret
from sirdar_api.deploy import envfile, environments, ssh, vault
from sirdar_api.deploy.environments import AdoptReport, EnvError

from .deploy_factories import (  # noqa: F401
    ADOPT_SHA,
    CAT_ENV,
    ENV_SECRETS,
    REPO_HEAD,
    make_environment,
    remote_env_text,
    secrets_key,
    serve_remote_env,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def _secrets(db, env_id) -> dict[str, str]:
    rows = await db.scalars(select(EnvironmentSecret)
                            .where(EnvironmentSecret.environment_id == env_id))
    return {r.key: vault.decrypt(get_settings(), r.value_enc) for r in rows}


def _new(**over) -> dict:
    kw = {"name": "qa", "type_": "custom", "target_id": "ssh", "proxy_ip": "10.10.48.6"}
    kw.update(over)
    return kw


async def test_create_new_generates_everything(db, target):
    env = await environments.create_new(db, get_settings(), **_new(), actor_id=None)
    await db.commit()
    assert (env.status, env.base_domain, env.git_ref, env.bind_ip, env.current_sha,
            env.image_tag, env.keep_dumps, env.spaces_bucket, env.log_level) == (
        "new", "qa.serversherpa.com", "main", "0.0.0.0", None, None, 5, "serversherpa",
        "INFO")
    rows = await environments.services_of(db, env.id)
    assert [(r.service, r.host_ip, r.port, r.hostname, r.proxied) for r in rows] == [
        ("api", "127.0.0.1", 8000, "api.qa.serversherpa.com", False),
        ("portal", "127.0.0.1", 8091, "portal.qa.serversherpa.com", False),
        ("kiosk", "127.0.0.1", 8090, "kiosk.qa.serversherpa.com", False),
        ("wiki", "127.0.0.1", 8096, "wiki.qa.serversherpa.com", False),
        ("spaces", "127.0.0.1", 9000, "spaces.qa.serversherpa.com", False),
        ("status", "127.0.0.1", 8095, "status.qa.serversherpa.com", False),
        ("mailpit", "127.0.0.1", 8025, None, False)]
    stored = await _secrets(db, env.id)
    assert set(stored) == set(envfile.REQUIRED_SECRETS)
    raw = {r.key: r.value_enc for r in await db.scalars(select(EnvironmentSecret))}
    for key, value in stored.items():
        assert value.encode() not in raw[key]
    assert target.commands == []                    # creating touches no host


async def test_create_new_custom_values(db, target):
    env = await environments.create_new(
        db, get_settings(), **_new(base_domain="QA.Example.com.", bind_ip="10.10.48.63",
                                   git_ref="release/1", ports={"api": 8100}))
    await db.commit()
    assert (env.base_domain, env.bind_ip, env.git_ref) == (
        "qa.example.com", "10.10.48.63", "release/1")
    rows = {r.service: r for r in await environments.services_of(db, env.id)}
    assert (rows["api"].port, rows["api"].hostname) == (8100, "api.qa.example.com")


@pytest.mark.parametrize("over, code", [
    ({"name": "Bad"}, "name_invalid"),
    ({"name": "dev"}, "name_reserved"),
    ({"type_": "prod"}, "type_invalid"),
    ({"target_id": "digitalocean"}, "target_invalid"),
    ({"target_id": "ssh:nope"}, "target_not_configured"),
    ({"git_ref": "a..b"}, "ref_invalid"),
    ({"base_domain": "not a domain"}, "base_domain_invalid"),
    ({"proxy_ip": ""}, "proxy_ip_required"),
    ({"proxy_ip": "10.0.0"}, "proxy_ip_invalid"),
    ({"bind_ip": "::"}, "bind_ip_invalid"),
    ({"ports": {"api": 0}}, "port_invalid"),
    ({"ports": {"api": 8091}}, "ports_conflict"),
    ({"ports": {"db": 5432}}, "service_unknown"),
])
async def test_create_new_validation(db, target, over, code):
    with pytest.raises(EnvError) as exc:
        await environments.create_new(db, get_settings(), **_new(**over))
    assert exc.value.code == code
    assert await db.scalar(select(func.count()).select_from(Environment)) == 0


async def test_create_new_needs_the_key_and_a_free_name(db, target, monkeypatch):
    await make_environment(db, name="qa")
    with pytest.raises(EnvError) as exc:
        await environments.create_new(db, get_settings(), **_new())
    assert exc.value.code == "environment_exists"
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(EnvError) as exc:
        await environments.create_new(db, get_settings(), **_new(name="qa2"))
    assert exc.value.code == "secrets_key_missing"


async def test_adopt_imports_settings_and_secrets(db, target):
    await trust_fake(db, target)
    serve_remote_env(target)
    env, dep, report = await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                                target_id="ssh")
    await db.commit()
    assert target.commands == [CAT_ENV, REPO_HEAD]
    assert (env.status, env.current_sha, env.image_tag, env.base_domain, env.proxy_ip,
            env.bind_ip) == ("ready", ADOPT_SHA, "e73b99ca", "uat.serversherpa.com",
                             "10.10.48.6", "0.0.0.0")
    assert (dep.mode, dep.status, dep.sha, dep.git_ref) == ("adopt", "adopted", ADOPT_SHA,
                                                            "main")
    assert dep.finished_at is not None
    assert await db.scalar(select(func.count()).select_from(DeploymentStep)) == 0
    assert report == AdoptReport(sha=ADOPT_SHA,
                                 imported_secrets=sorted(envfile.REQUIRED_SECRETS),
                                 ignored_keys=["MINIO_ROOT_PASSWORD"])
    assert await _secrets(db, env.id) == ENV_SECRETS


async def test_adopted_record_renders_the_same_env(db, target):
    """Adopting then deploying keeps every value the hand-built .env had."""
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(SS_ANTHROPIC_API_KEY="sk-ant-api03-x",
                                             STACK_API_PORT="8100"))
    env, _, report = await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                              target_id="ssh")
    await db.commit()
    assert "SS_ANTHROPIC_API_KEY" in report.imported_secrets
    rows = await environments.services_of(db, env.id)
    rendered = envfile.parse_env(envfile.render_env(envfile.EnvConfig(
        name=env.name, domain=env.base_domain, image_tag=env.image_tag, proxy_ip=env.proxy_ip,
        bind_ip=env.bind_ip, ports={r.service: r.port for r in rows},
        keep_dumps=env.keep_dumps, spaces_bucket=env.spaces_bucket, log_level=env.log_level,
        secrets=await _secrets(db, env.id))))
    remote = envfile.parse_env(remote_env_text(SS_ANTHROPIC_API_KEY="sk-ant-api03-x",
                                               STACK_API_PORT="8100"))
    assert rendered == {k: v for k, v in remote.items() if k in envfile.KNOWN_KEYS}


@pytest.mark.parametrize("text, code, extra", [
    (remote_env_text(STACK_ENV="other"), "adopt_env_mismatch", {}),
    (remote_env_text(SS_JWT_SECRET="CHANGEME", POSTGRES_PASSWORD=None),
     "adopt_env_incomplete", {"missing": ["POSTGRES_PASSWORD", "SS_JWT_SECRET"]}),
    (remote_env_text(STACK_PROXY_IP="nope"), "adopt_value_invalid", {"key": "STACK_PROXY_IP"}),
    (remote_env_text(STACK_API_PORT="80x"), "adopt_value_invalid", {"key": "STACK_API_PORT"}),
    (remote_env_text(SS_LOG_LEVEL="LOUD"), "adopt_value_invalid", {"key": "SS_LOG_LEVEL"}),
    (remote_env_text(STACK_PORTAL_PORT="8000"), "ports_conflict", {}),
])
async def test_adopt_refuses_a_bad_env(db, target, text, code, extra):
    await trust_fake(db, target)
    serve_remote_env(target, text)
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert (exc.value.code, exc.value.extra) == (code, extra)
    for secret in ENV_SECRETS.values():
        assert secret not in repr(exc.value.extra)


async def test_adopt_missing_env_or_repo(db, target):
    await trust_fake(db, target)
    serve_remote_env(target, "")
    target.exits[CAT_ENV] = 1
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert exc.value.code == "adopt_env_missing"

    serve_remote_env(target)
    target.exits[CAT_ENV] = 0
    target.exits[REPO_HEAD] = 128
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert exc.value.code == "adopt_repo_missing"
    assert await db.scalar(select(func.count()).select_from(Environment)) == 0


async def test_adopt_needs_a_trusted_host(db, target):
    serve_remote_env(target)
    with pytest.raises(ssh.HostKeyUnknown):
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert target.commands == []


async def test_update_fields_services_and_secrets(db, target):
    env = await make_environment(db)
    settings = get_settings()
    changed = await environments.update(db, settings, env, {
        "base_domain": "uat2.serversherpa.com", "keep_dumps": 3, "log_level": "debug",
        "services": {"api": {"port": 8100, "proxied": True}, "mailpit": {"host_ip": "10.0.0.9"}},
        "secrets": {"SS_ANTHROPIC_API_KEY": "sk-ant-api03-abc"}})
    await db.commit()
    assert changed == ["base_domain", "keep_dumps", "log_level", "services.api.port",
                       "services.api.proxied", "services.mailpit.host_ip",
                       "secrets.SS_ANTHROPIC_API_KEY"]
    rows = {r.service: r for r in await environments.services_of(db, env.id)}
    assert (rows["api"].port, rows["api"].proxied, rows["api"].hostname) == (
        8100, True, "api.uat2.serversherpa.com")
    assert (rows["mailpit"].host_ip, rows["mailpit"].hostname) == ("10.0.0.9", None)
    assert env.log_level == "DEBUG"
    assert (await _secrets(db, env.id))["SS_ANTHROPIC_API_KEY"] == "sk-ant-api03-abc"

    assert await environments.update(db, settings, env, {"keep_dumps": 3}) == []
    changed = await environments.update(db, settings, env,
                                        {"secrets": {"SS_ANTHROPIC_API_KEY": ""}})
    await db.commit()
    assert changed == ["secrets.SS_ANTHROPIC_API_KEY"]
    assert "SS_ANTHROPIC_API_KEY" not in await environments.secret_keys_of(db, env.id)


@pytest.mark.parametrize("fields, code, extra", [
    ({"git_ref": "-x"}, "ref_invalid", {}),
    ({"target": "ssh:gone"}, "target_not_configured", {}),
    ({"base_domain": "x"}, "base_domain_invalid", {}),
    ({"proxy_ip": "1.2.3"}, "proxy_ip_invalid", {}),
    ({"keep_dumps": 0}, "keep_dumps_invalid", {}),
    ({"spaces_bucket": "Bad_Bucket"}, "bucket_invalid", {}),
    ({"log_level": "LOUD"}, "log_level_invalid", {}),
    ({"services": {"db": {"port": 1}}}, "service_unknown", {"service": "db"}),
    ({"services": {"api": {"port": 70000}}}, "port_invalid", {"service": "api"}),
    ({"services": {"api": {"port": 8091}}}, "ports_conflict", {}),
    ({"services": {"api": {"host_ip": "h"}}}, "host_ip_invalid", {}),
    ({"secrets": {"POSTGRES_PASSWORD": "x"}}, "secret_not_editable",
     {"key": "POSTGRES_PASSWORD"}),
    ({"secrets": {"SS_ANTHROPIC_API_KEY": "has space"}}, "secret_invalid",
     {"key": "SS_ANTHROPIC_API_KEY"}),
    ({"secrets": {"SS_ANTHROPIC_API_KEY": "a$b"}}, "secret_invalid",
     {"key": "SS_ANTHROPIC_API_KEY"}),
])
async def test_update_validation(db, target, fields, code, extra):
    env = await make_environment(db)
    with pytest.raises(EnvError) as exc:
        await environments.update(db, get_settings(), env, fields)
    assert (exc.value.code, exc.value.extra) == (code, extra)


async def test_update_refused_while_deploying(db, target):
    env = await make_environment(db)
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha="a" * 40,
                      status="running", start_step=1))
    await db.commit()
    assert await environments.is_deploying(db, env.id) is True
    with pytest.raises(EnvError) as exc:
        await environments.update(db, get_settings(), env, {"keep_dumps": 3})
    assert exc.value.code == "deploy_in_progress"


async def test_update_advances_updated_at(db, target):
    """updated_at has only a now() default (no trigger, no onupdate): every
    edit path must set it, including service-only and secret-only edits."""
    env = await make_environment(db)
    settings = get_settings()
    for patch in ({"keep_dumps": 4}, {"services": {"api": {"proxied": True}}},
                  {"secrets": {"SS_DB_TESTING_PASSWORD": "pw-1"}}):
        before = (await db.scalar(select(Environment.updated_at)
                                  .where(Environment.id == env.id)))
        assert await environments.update(db, settings, env, patch) != []
        await db.commit()
        after = (await db.scalar(select(Environment.updated_at)
                                 .where(Environment.id == env.id)))
        assert after > before, patch
    before = env.updated_at
    assert await environments.update(db, settings, env, {"keep_dumps": 4}) == []
    await db.commit()
    assert env.updated_at == before                 # a no-op edit leaves it alone


async def test_adopt_refuses_a_truncated_env(db, target):
    """run_command caps stdout at OUTPUT_LIMIT silently; a .env that hit the
    cap is refused instead of imported partially."""
    await trust_fake(db, target)
    padding = "# " + "x" * ssh.OUTPUT_LIMIT + "\n"
    serve_remote_env(target, remote_env_text() + padding)
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert (exc.value.code, exc.value.extra) == ("adopt_env_too_large", {})
    assert target.commands == [CAT_ENV]
    assert await db.scalar(select(func.count()).select_from(Environment)) == 0


async def test_adopt_accepts_the_live_uat_shape(db, target):
    """uat today: unquoted values, no unmanaged keys, empty optional secrets,
    hex secrets and a Fernet TOTP key (as create generates them)."""
    for key in envfile.HEX_SECRETS:
        assert int(ENV_SECRETS[key], 16) >= 0
    Fernet(ENV_SECRETS["SS_TOTP_ENCRYPTION_KEY"].encode())
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(MINIO_ROOT_PASSWORD=None))
    env, _, report = await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                              target_id="ssh")
    await db.commit()
    assert report.ignored_keys == []
    assert report.imported_secrets == sorted(envfile.REQUIRED_SECRETS)
    assert "SPACES_SECRET_KEY" in await environments.secret_keys_of(db, env.id)


async def test_adopt_accepts_secrets_create_would_generate(db, target):
    generated = vault.generate_env_secrets()
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(**generated))
    env, _, _ = await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                         target_id="ssh")
    await db.commit()
    assert await _secrets(db, env.id) == generated


@pytest.mark.parametrize("key, value", [
    ("POSTGRES_PASSWORD", '"ab$cd"'),               # quoted: parse_env keeps the "$"
    ("SS_JWT_SECRET", "jwt-not-hex-0f1e"),
    ("SS_PASSWORD_PEPPER", "'0a1b$2c'"),
    ("SS_TOTP_ENCRYPTION_KEY", "not-a-fernet-key"),
    ("SS_TOTP_ENCRYPTION_KEY", "a1" * 32),          # hex, but not a Fernet key
    ("SS_ANTHROPIC_API_KEY", '"sk-ant-$HOME"'),
    ("SS_DB_TESTING_PASSWORD", "has space"),
])
async def test_adopt_refuses_secrets_that_wont_render_back(db, target, key, value):
    """A secret must survive the render round-trip: hex for the hex secrets,
    a Fernet key for TOTP, the PATCH rules for optional ones. The error
    names the key, never the value."""
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(**{key: value}))
    with pytest.raises(EnvError) as exc:
        await environments.adopt(db, get_settings(), name="uat", type_="dev", target_id="ssh")
    assert (exc.value.code, exc.value.extra) == ("adopt_value_invalid", {"key": key})
    assert value.strip("\"'") not in repr(exc.value) + repr(exc.value.extra)
    assert target.commands == [CAT_ENV]
    assert await db.scalar(select(func.count()).select_from(Environment)) == 0


async def test_adopt_treats_a_changeme_optional_secret_as_unset(db, target):
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(SS_ANTHROPIC_API_KEY="CHANGEME",
                                             SS_DB_TESTING_PASSWORD='"CHANGEME"'))
    env, _, report = await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                              target_id="ssh")
    await db.commit()
    assert report.imported_secrets == sorted(envfile.REQUIRED_SECRETS)
    assert set(await environments.secret_keys_of(db, env.id)) == set(envfile.REQUIRED_SECRETS)
