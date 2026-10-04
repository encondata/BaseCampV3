import pytest
from cryptography.fernet import Fernet

from sirdar_api.config import get_settings
from sirdar_api.db.models import Integration
from sirdar_api.deploy import integrations
from sirdar_api.deploy.integrations import IntegrationError

from .deploy_factories import secrets_key  # noqa: F401
from .factories import make_user
from .integration_helpers import CF_TOKEN, CF_VALUES, NPM_PASSWORD, NPM_VALUES, configure


async def test_save_and_load_cloudflare(db, secrets_key):
    changed = await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                                      actor_id=None)
    await db.commit()
    assert changed == ["zone", "public_ip", "token"]
    row = await db.get(Integration, "cloudflare")
    assert row.config == {"zone": "serversherpa.com", "public_ip": "203.0.113.7"}
    assert CF_TOKEN.encode() not in bytes(row.secret_enc)
    cfg = await integrations.load_cloudflare(db, get_settings())
    assert (cfg.zone, cfg.public_ip, cfg.token) == ("serversherpa.com", "203.0.113.7", CF_TOKEN)
    assert CF_TOKEN not in repr(cfg)
    assert await integrations.is_configured(db, "cloudflare")
    assert not await integrations.is_configured(db, "npm")


async def test_npm_defaults_the_lets_encrypt_email_to_the_login(db, secrets_key):
    await configure(db, cloudflare=False)
    cfg = await integrations.load_npm(db, get_settings())
    assert (cfg.url, cfg.identity, cfg.letsencrypt_email, cfg.password) == (
        "http://10.10.48.6:81", "admin@example.com", "admin@example.com", NPM_PASSWORD)
    assert NPM_PASSWORD not in repr(cfg)


async def test_saving_without_a_secret_keeps_the_stored_one(db, secrets_key):
    await configure(db)
    changed = await integrations.save(db, get_settings(), "cloudflare",
                                      {**CF_VALUES, "public_ip": "203.0.113.8"}, None,
                                      actor_id=None)
    await db.commit()
    assert changed == ["public_ip"]
    cfg = await integrations.load_cloudflare(db, get_settings())
    assert (cfg.public_ip, cfg.token) == ("203.0.113.8", CF_TOKEN)
    assert await integrations.save(db, get_settings(), "cloudflare",
                                   {**CF_VALUES, "public_ip": "203.0.113.8"}, None,
                                   actor_id=None) == []


async def test_first_save_needs_a_secret(db, secrets_key):
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), "npm", NPM_VALUES, None, actor_id=None)
    assert e.value.code == "secret_required"


@pytest.mark.parametrize("kind, values, secret, code", [
    ("cloudflare", {**CF_VALUES, "zone": "not a zone"}, CF_TOKEN, "zone_invalid"),
    ("cloudflare", {**CF_VALUES, "public_ip": "999.1.1.1"}, CF_TOKEN, "public_ip_invalid"),
    ("cloudflare", CF_VALUES, "short", "token_invalid"),
    ("cloudflare", CF_VALUES, "has spaces in it, twenty+ chars", "token_invalid"),
    ("npm", {**NPM_VALUES, "url": "10.10.48.6:81"}, NPM_PASSWORD, "npm_url_invalid"),
    ("npm", {**NPM_VALUES, "url": "http://npm/api"}, NPM_PASSWORD, "npm_url_invalid"),
    ("npm", {**NPM_VALUES, "identity": "admin"}, NPM_PASSWORD, "identity_invalid"),
    ("npm", {**NPM_VALUES, "letsencrypt_email": "x@"}, NPM_PASSWORD,
     "letsencrypt_email_invalid"),
    ("npm", NPM_VALUES, "", "password_invalid"),
    ("npm", NPM_VALUES, "line\nbreak", "password_invalid"),
    ("npm", NPM_VALUES, "x" * 1025, "password_invalid"),
])
async def test_validation(db, secrets_key, kind, values, secret, code):
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), kind, values, secret, actor_id=None)
    assert e.value.code == code
    if secret:      # "" is a substring of everything
        assert secret not in str(e.value) and secret not in repr(e.value.extra)


async def test_values_are_normalized(db, secrets_key):
    await integrations.save(db, get_settings(), "cloudflare",
                            {"zone": " ServerSherpa.com. ", "public_ip": " 203.0.113.7 "},
                            CF_TOKEN, actor_id=None)
    await integrations.save(db, get_settings(), "npm",
                            {**NPM_VALUES, "url": "http://10.10.48.6:81/"}, NPM_PASSWORD,
                            actor_id=None)
    assert (await db.get(Integration, "cloudflare")).config["zone"] == "serversherpa.com"
    assert (await db.get(Integration, "npm")).config["url"] == "http://10.10.48.6:81"


async def test_a_secret_needs_the_secrets_key(db, monkeypatch):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                                actor_id=None)
    assert e.value.code == "secrets_key_missing"
    get_settings.cache_clear()


async def test_a_secret_from_another_key_is_unreadable(db, secrets_key):
    db.add(Integration(kind="npm", config={**NPM_VALUES, "letsencrypt_email": "a@b.co"},
                       secret_enc=Fernet(Fernet.generate_key()).encrypt(b"x")))
    await db.commit()
    with pytest.raises(IntegrationError) as e:
        await integrations.load_npm(db, get_settings())
    assert (e.value.code, e.value.extra) == ("integration_unreadable", {"kind": "npm"})


async def test_candidate_uses_the_given_or_the_stored_secret(db, secrets_key):
    with pytest.raises(IntegrationError) as e:
        await integrations.candidate(db, get_settings(), "cloudflare", CF_VALUES, None)
    assert e.value.code == "secret_required"
    given = await integrations.candidate(db, get_settings(), "cloudflare", CF_VALUES,
                                         "other-" + "t" * 20)
    assert given.token == "other-" + "t" * 20
    await configure(db)
    stored = await integrations.candidate(db, get_settings(), "npm",
                                          {**NPM_VALUES, "identity": "ops@example.com"}, None)
    assert (stored.identity, stored.password) == ("ops@example.com", NPM_PASSWORD)
    row = await db.get(Integration, "npm", populate_existing=True)
    assert row.config["identity"] == "admin@example.com"      # nothing was saved


async def test_public_view_never_carries_a_secret(db, secrets_key):
    empty = await integrations.public(db, get_settings())
    assert empty == {
        "secrets_key_configured": True,
        "cloudflare": {"configured": False, "zone": None, "public_ip": None, "token_set": False,
                       "updated_at": None, "updated_by_name": None},
        "npm": {"configured": False, "url": None, "identity": None, "letsencrypt_email": None,
                "password_set": False, "updated_at": None, "updated_by_name": None},
    }
    user = await make_user(db, email="ops@test.example.com", first_name="Jimmy",
                           last_name="Henderson")
    await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                            actor_id=user.person_id)
    await db.commit()
    view = await integrations.public(db, get_settings())
    assert view["cloudflare"] | {"updated_at": None} == {
        "configured": True, "zone": "serversherpa.com", "public_ip": "203.0.113.7",
        "token_set": True, "updated_at": None, "updated_by_name": "Jimmy Henderson"}
    assert view["cloudflare"]["updated_at"] is not None
    assert CF_TOKEN not in repr(view)


async def test_remove(db, secrets_key):
    await configure(db)
    assert await integrations.remove(db, "npm") is True
    await db.commit()
    assert await integrations.remove(db, "npm") is False
    assert await integrations.load_npm(db, get_settings()) is None
