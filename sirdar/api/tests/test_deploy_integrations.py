import pytest
from cryptography.fernet import Fernet

from sirdar_api.config import get_settings
from sirdar_api.db.models import Integration
from sirdar_api.deploy import integrations
from sirdar_api.deploy.integrations import IntegrationError

from .deploy_factories import secrets_key  # noqa: F401
from .factories import make_user
from .deploy_factories import make_environment
from .integration_helpers import (
    CF_TOKEN,
    CF_VALUES,
    NPM_PASSWORD,
    NPM_VALUES,
    PX_FINGERPRINT,
    PX_TOKEN,
    PX_TOKEN_ID,
    PX_TOKEN_SECRET,
    PX_VALUES,
    configure,
    configure_proxmox,
)
from .tls_helpers import make_cert


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
                                          {**NPM_VALUES, "letsencrypt_email": "le@example.com"},
                                          None)
    assert (stored.letsencrypt_email, stored.password) == ("le@example.com", NPM_PASSWORD)
    stored = await integrations.candidate(db, get_settings(), "cloudflare",
                                          {**CF_VALUES, "public_ip": "203.0.113.9"}, None)
    assert (stored.public_ip, stored.token) == ("203.0.113.9", CF_TOKEN)
    row = await db.get(Integration, "npm", populate_existing=True)
    assert row.config["letsencrypt_email"] == "admin@example.com"      # nothing was saved


NEW_TARGETS = [
    ("npm", {**NPM_VALUES, "identity": "ops@example.com"},
     "Enter the password again to use it with a different server or login."),
    ("npm", {**NPM_VALUES, "url": "http://10.10.48.99:81"},
     "Enter the password again to use it with a different server or login."),
    ("cloudflare", {**CF_VALUES, "zone": "example.com"},
     "Enter the token again to use it with a different zone."),
]


@pytest.mark.parametrize("kind, values, reason", NEW_TARGETS)
async def test_a_stored_secret_never_goes_to_a_new_target(db, secrets_key, kind, values,
                                                          reason):
    await configure(db)
    with pytest.raises(IntegrationError) as e:
        await integrations.candidate(db, get_settings(), kind, values, None)
    assert (e.value.code, e.value.extra) == ("secret_required", {"reason": reason})
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), kind, values, None, actor_id=None)
    assert (e.value.code, e.value.extra) == ("secret_required", {"reason": reason})
    await db.rollback()
    secret = CF_TOKEN if kind == "cloudflare" else NPM_PASSWORD
    assert (await integrations.candidate(db, get_settings(), kind, values, secret)) is not None
    assert await integrations.save(db, get_settings(), kind, values, secret, actor_id=None)


async def test_public_view_never_carries_a_secret(db, secrets_key):
    empty = await integrations.public(db, get_settings())
    assert empty == {
        "secrets_key_configured": True,
        "cloudflare": {"configured": False, "zone": None, "public_ip": None, "token_set": False,
                       "updated_at": None, "updated_by_name": None},
        "npm": {"configured": False, "url": None, "identity": None, "letsencrypt_email": None,
                "password_set": False, "updated_at": None, "updated_by_name": None},
        "proxmox": {"configured": False, "url": None, "node": None, "pool": None,
                    "storage": None, "bridge": None, "vlan_tag": None, "template_vmid": None,
                    "tls_fingerprint": None, "token_id": None, "token_set": False,
                    "updated_at": None, "updated_by_name": None},
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


async def test_save_and_load_proxmox(db, secrets_key):
    changed = await integrations.save(db, get_settings(), "proxmox", PX_VALUES, PX_TOKEN,
                                      actor_id=None)
    await db.commit()
    assert set(changed) == {"url", "node", "pool", "storage", "bridge", "template_vmid",
                            "tls_fingerprint", "tls_cert_pem", "token_id", "token"}
    row = await db.get(Integration, "proxmox")
    assert row.config["token_id"] == PX_TOKEN_ID
    assert PX_TOKEN_SECRET not in repr(row.config)
    assert PX_TOKEN.encode() not in bytes(row.secret_enc)
    cfg = await integrations.load_proxmox(db, get_settings())
    assert (cfg.url, cfg.node, cfg.template_vmid, cfg.vlan_tag, cfg.token) == (
        "https://10.10.48.5:8006", "pve", 9000, None, PX_TOKEN)
    assert (cfg.token_id, cfg.token_secret) == (PX_TOKEN_ID, PX_TOKEN_SECRET)
    assert PX_TOKEN_SECRET not in repr(cfg) and "BEGIN CERTIFICATE" not in repr(cfg)
    view = (await integrations.public(db, get_settings()))["proxmox"]
    assert (view["configured"], view["token_set"], view["token_id"], view["tls_fingerprint"]) == (
        True, True, PX_TOKEN_ID, PX_FINGERPRINT)
    assert "tls_cert_pem" not in view and PX_TOKEN_SECRET not in repr(view)


@pytest.mark.parametrize("field,value,code", [
    ("url", "http://10.10.48.5:8006", "proxmox_url_invalid"),
    ("url", "https://10.10.48.5:8006/api2/json", "proxmox_url_invalid"),
    ("node", "pve node", "node_invalid"),
    ("pool", "", "pool_invalid"),
    ("storage", "1local", "storage_invalid"),
    ("bridge", "vmbr0-much-too-long", "bridge_invalid"),
    ("vlan_tag", 4095, "vlan_tag_invalid"),
    ("vlan_tag", "12", "vlan_tag_invalid"),
    ("template_vmid", 99, "template_vmid_invalid"),
    ("template_vmid", True, "template_vmid_invalid"),
    ("tls_fingerprint", "AB:CD", "tls_untrusted"),
    ("tls_cert_pem", None, "tls_untrusted"),
])
def test_proxmox_fields_are_checked(field, value, code):
    with pytest.raises(IntegrationError) as e:
        integrations.check_fields("proxmox", {**PX_VALUES, field: value})
    assert e.value.code == code


def test_the_pinned_certificate_must_match_the_fingerprint():
    other, _ = make_cert(cn="impostor")
    with pytest.raises(IntegrationError) as e:
        integrations.check_fields("proxmox", {**PX_VALUES, "tls_cert_pem": other})
    assert e.value.code == "tls_untrusted"
    lower = {**PX_VALUES, "tls_fingerprint": PX_FINGERPRINT.lower(), "vlan_tag": 40}
    assert integrations.check_fields("proxmox", lower)["tls_fingerprint"] == PX_FINGERPRINT


@pytest.mark.parametrize("token", [
    PX_TOKEN_ID, f"sirdar@pve={PX_TOKEN_SECRET}", f"{PX_TOKEN_ID}=not-a-uuid",
    f"{PX_TOKEN}\n", f"root@pam {PX_TOKEN}"])
def test_proxmox_tokens_are_checked(token):
    with pytest.raises(IntegrationError) as e:
        integrations.check_secret("proxmox", token)
    assert e.value.code == "proxmox_token_invalid"


async def test_a_stored_proxmox_token_goes_only_to_its_own_server(db, secrets_key):
    await configure_proxmox(db)
    changed = await integrations.save(db, get_settings(), "proxmox",
                                      {**PX_VALUES, "storage": "fast"}, None, actor_id=None)
    assert changed == ["storage"]
    assert (await integrations.config_of(db, "proxmox"))["token_id"] == PX_TOKEN_ID
    with pytest.raises(IntegrationError) as e:
        await integrations.candidate(db, get_settings(), "proxmox",
                                     {**PX_VALUES, "url": "https://10.10.48.9:8006"}, None)
    assert e.value.code == "secret_required"


async def test_in_use_names_the_proxmox_environments(db, secrets_key):
    await make_environment(db, name="uat3", target_id="proxmox")
    await make_environment(db, name="uat")
    assert await integrations.in_use(db, "proxmox") == ["uat3"]
    assert await integrations.in_use(db, "npm") == []
    assert await integrations.config_of(db, "cloudflare") == {}
