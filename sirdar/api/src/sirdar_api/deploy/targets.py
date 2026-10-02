"""Deployment targets and types: registry, configured detection and
the public list (no connection details) for GET /api/deploy/targets."""

from dataclasses import dataclass

from sirdar_api.config import Settings


@dataclass(frozen=True)
class Target:
    id: str
    label: str
    available: bool          # built in this step


TARGETS: tuple[Target, ...] = (
    Target("aws", "AWS", False),
    Target("gcp", "Google Cloud", False),
    Target("digitalocean", "DigitalOcean", True),
    Target("ssh", "Custom (SSH)", True),
)
TARGET_IDS = tuple(t.id for t in TARGETS)

DEPLOY_TYPES: list[dict] = [
    {"id": "blue", "label": "Blue", "description": "Production slot"},
    {"id": "green", "label": "Green", "description": "Production slot"},
    {"id": "dev", "label": "Dev", "description": "Development"},
    {"id": "beta", "label": "Beta", "description": "External testing"},
    {"id": "custom", "label": "Custom", "description": "Your own named environment"},
]
DEPLOY_TYPE_IDS = tuple(t["id"] for t in DEPLOY_TYPES)


def get_target(target_id: str) -> Target | None:
    return next((t for t in TARGETS if t.id == target_id), None)


def is_configured(target_id: str, s: Settings) -> bool:
    match target_id:
        case "digitalocean":
            return s.deploy_do_token is not None
        case "ssh":
            return bool(s.deploy_ssh_host.strip() and s.deploy_ssh_user.strip()
                        and (s.deploy_ssh_password is not None or s.deploy_ssh_key_path.strip()))
        case "aws":
            return bool(s.deploy_aws_access_key_id.strip()
                        and s.deploy_aws_secret_access_key is not None)
        case "gcp":
            return bool(s.deploy_gcp_project_id.strip() and s.deploy_gcp_credentials_file.strip())
    return False


def ssh_auth_label(s: Settings) -> str:
    key, password = bool(s.deploy_ssh_key_path.strip()), s.deploy_ssh_password is not None
    return "key + password" if key and password else "key" if key else "password"


def public_targets(s: Settings) -> list[dict]:
    return [{"id": t.id, "label": t.label, "available": t.available,
             "configured": is_configured(t.id, s)}
            for t in TARGETS]
