"""Stored integration credentials for publish tests. The secrets are
distinct strings so leak checks can look for them."""

from sirdar_api.config import get_settings
from sirdar_api.deploy import integrations

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
