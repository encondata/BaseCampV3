"""Deployment targets and types: registry, configured detection and
the public list (no connection details) for GET /api/deploy/targets.

SSH targets come from two places: the installer target (id "ssh",
SIRDAR_DEPLOY_SSH_* in .env, read-only) and saved targets (id "ssh:<slug>",
deploy-targets.env, see ssh_targets)."""

import os
from dataclasses import dataclass
from pathlib import Path

from sirdar_api.config import Settings
from sirdar_api.deploy.ssh import SshTargetConfig
from sirdar_api.deploy.ssh_targets import SavedSshTarget, SshTargetStore

INSTALLER_LABEL = "Custom (SSH) · Installer"
# Environments whose host is a VM Sirdar builds: on Proxmox (phase 5) or on a
# standalone ESXi host (phase 6). The target id equals the integration kind.
PROXMOX_TARGET = "proxmox"
ESXI_TARGET = "esxi"
VM_TARGETS = (PROXMOX_TARGET, ESXI_TARGET)
VM_TARGET_LABELS = {PROXMOX_TARGET: "Proxmox", ESXI_TARGET: "VMware ESXi"}


def is_vm_target(target_id: str | None) -> bool:
    return target_id in VM_TARGETS
STORE_HINT = "deploy-targets.env isn't writable; see the README."


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


def ssh_store(s: Settings) -> SshTargetStore:
    return SshTargetStore(s.deploy_targets_file, s.deploy_keys_dir)


def can_add_ssh(s: Settings) -> bool:
    folder = Path(s.deploy_targets_file).parent
    return folder.is_dir() and os.access(folder, os.W_OK | os.X_OK)


def installer_present(s: Settings) -> bool:
    """Any SIRDAR_DEPLOY_SSH_* value set (the port only when not the default)."""
    return bool(s.deploy_ssh_host.strip() or s.deploy_ssh_user.strip()
                or s.deploy_ssh_password is not None or s.deploy_ssh_key_path.strip()
                or s.deploy_ssh_key_passphrase is not None or s.deploy_ssh_port != 22)


def saved_targets(s: Settings) -> list[SavedSshTarget]:
    try:
        return ssh_store(s).load()
    except (OSError, UnicodeDecodeError):   # unreadable file: list nothing rather than fail
        return []


def _saved_config(t: SavedSshTarget, s: Settings) -> SshTargetConfig:
    name = t.key_path
    key_file = None
    if name and "/" not in name and "\\" not in name and name not in (".", ".."):
        key_file = str(Path(s.deploy_keys_dir) / name)
    return SshTargetConfig(host=t.host, port=t.port, user=t.user, password=t.password,
                           key_file=key_file, key_name=name, passphrase=t.passphrase,
                           sudo_password=t.sudo_password)


def ssh_configs(s: Settings) -> list[tuple[str, SshTargetConfig]]:
    """(target id, config) for every configured SSH target."""
    out: list[tuple[str, SshTargetConfig]] = []
    if is_configured("ssh", s):
        out.append(("ssh", SshTargetConfig.from_settings(s)))
    out += [(t.id, _saved_config(t, s)) for t in saved_targets(s) if t.configured]
    return out


def ssh_config_for(target_id: str, s: Settings) -> SshTargetConfig | None:
    """The config for "ssh" or "ssh:<slug>"; None when unknown or not configured."""
    return next((cfg for tid, cfg in ssh_configs(s) if tid == target_id), None)


def ssh_targets_at(host: str, port: int, s: Settings) -> list[str]:
    """Ids of configured SSH targets that connect to host:port."""
    return [tid for tid, cfg in ssh_configs(s) if cfg.host == host and cfg.port == port]


def public_targets(s: Settings, *, proxmox_configured: bool = False,
                   esxi_configured: bool = False) -> list[dict]:
    """The VM hosts are listed last (Proxmox, then ESXi) once saved."""
    out = [{"id": t.id, "label": t.label, "kind": t.id, "available": t.available,
            "configured": is_configured(t.id, s)}
           for t in TARGETS if t.id != "ssh"]
    if installer_present(s):
        out.append({"id": "ssh", "label": INSTALLER_LABEL, "kind": "ssh", "source": "installer",
                    "available": True, "configured": is_configured("ssh", s)})
    out += [{"id": t.id, "label": t.name, "kind": "ssh", "source": "saved",
             "available": True, "configured": t.configured}
            for t in saved_targets(s)]
    for kind, on in ((PROXMOX_TARGET, proxmox_configured), (ESXI_TARGET, esxi_configured)):
        if on:
            out.append({"id": kind, "label": VM_TARGET_LABELS[kind], "kind": kind,
                        "available": True, "configured": True})
    return out
