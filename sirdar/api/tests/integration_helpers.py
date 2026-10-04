"""Stored integration credentials for publish tests. The secrets are
distinct strings so leak checks can look for them."""

from sirdar_api.config import get_settings
from sirdar_api.deploy import integrations, tls_pin

from .tls_helpers import make_cert

CF_TOKEN = "cfTOKEN-" + "s3cr3t" * 5
NPM_PASSWORD = "npm-PASSWORD-s3cr3t!"
CF_VALUES = {"zone": "serversherpa.com", "public_ip": "203.0.113.7"}
NPM_VALUES = {"url": "http://10.10.48.6:81", "identity": "admin@example.com",
              "letsencrypt_email": ""}


async def configure(db, *, cloudflare: bool = True, npm: bool = True) -> None:
    """Save the integrations (needs the secrets_key fixture) and commit."""
    if cloudflare:
        await integrations.save(db, get_settings(), "cloudflare", CF_VALUES, CF_TOKEN,
                                actor_id=None)
    if npm:
        await integrations.save(db, get_settings(), "npm", NPM_VALUES, NPM_PASSWORD,
                                actor_id=None)
    await db.commit()


PX_TOKEN_ID = "sirdar@pve!sirdar"
PX_TOKEN_SECRET = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"
PX_TOKEN = f"{PX_TOKEN_ID}={PX_TOKEN_SECRET}"
PX_CERT, PX_CERT_KEY = make_cert()
PX_FINGERPRINT = tls_pin.fingerprint_of(PX_CERT)
PX_VALUES = {"url": "https://10.10.48.5:8006", "node": "pve", "pool": "sirdar",
             "storage": "local-lvm", "bridge": "vmbr0", "vlan_tag": None,
             "template_vmid": 9000, "tls_fingerprint": PX_FINGERPRINT, "tls_cert_pem": PX_CERT}
# What the Settings modal sends (no certificate: the API fetches it).
PX_BODY = {k: v for k, v in PX_VALUES.items() if k != "tls_cert_pem"}


async def configure_proxmox(db) -> None:
    """Save the Proxmox integration (needs the secrets_key fixture) and commit."""
    await integrations.save(db, get_settings(), "proxmox", PX_VALUES, PX_TOKEN, actor_id=None)
    await db.commit()
