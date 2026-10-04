"""Sirdar's own tables (migrations 0001–0007). `users` mirrors the portal's
user_accounts + people for the people it copies; Sirdar-only data
(overrides, sessions, audit, lockout counters) never comes from the portal."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, text
from sqlalchemy.dialects.postgresql import BYTEA, CITEXT, INET, JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import Text


class Base(DeclarativeBase):
    type_annotation_map = {
        uuid.UUID: UUID(as_uuid=True),
        datetime: TIMESTAMP(timezone=True),
        str: Text,
    }


class Role(Base):
    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    rank: Mapped[int] = mapped_column(Integer)
    color: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class User(Base):
    __tablename__ = "users"

    person_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    source: Mapped[str]                                   # "portal" | "local"
    email: Mapped[str] = mapped_column(CITEXT, unique=True)
    first_name: Mapped[str]
    last_name: Mapped[str]
    preferred_name: Mapped[str | None]
    job_title: Mapped[str | None]
    contact_email: Mapped[str | None]
    phone: Mapped[str | None]
    address_line1: Mapped[str | None]
    address_line2: Mapped[str | None]
    city: Mapped[str | None]
    region: Mapped[str | None]
    postal_code: Mapped[str | None]
    country: Mapped[str] = mapped_column(server_default=text("'US'"))
    password_hash: Mapped[str | None]
    must_change_password: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    password_updated_at: Mapped[datetime | None]
    password_expires_at: Mapped[datetime | None]
    totp_secret_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    totp_confirmed_at: Mapped[datetime | None]
    totp_last_counter: Mapped[int | None] = mapped_column(BigInteger)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    totp_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    failed_login_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    locked_until: Mapped[datetime | None]
    last_login_at: Mapped[datetime | None]
    last_login_ip: Mapped[str | None] = mapped_column(INET)
    disabled_at: Mapped[datetime | None]
    disabled_reason: Mapped[str | None]
    last_imported_at: Mapped[datetime | None]
    ui_prefs: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    @property
    def display_name(self) -> str:
        return f"{self.preferred_name or self.first_name} {self.last_name}"


class UserRole(Base):
    __tablename__ = "user_roles"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(
        ForeignKey("roles.name", ondelete="CASCADE"), primary_key=True)


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role: Mapped[str] = mapped_column(
        ForeignKey("roles.name", ondelete="CASCADE"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)


class PermissionOverride(Base):
    __tablename__ = "permission_overrides"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)
    allow: Mapped[bool] = mapped_column(Boolean)
    set_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.person_id"))
    set_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class TotpBackupCode(Base):
    __tablename__ = "totp_backup_codes"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"))
    code_hash: Mapped[str]
    used_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.person_id", ondelete="CASCADE"))
    family_id: Mapped[uuid.UUID]
    token_hash: Mapped[str] = mapped_column(unique=True)
    expires_at: Mapped[datetime]
    rotated_at: Mapped[datetime | None]
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("auth_sessions.id"))
    revoked_at: Mapped[datetime | None]
    revoke_reason: Mapped[str | None]
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    actor_id: Mapped[uuid.UUID | None]            # no FK: the trail outlives users
    action: Mapped[str]
    entity_type: Mapped[str]
    entity_id: Mapped[str | None]
    ip: Mapped[str | None] = mapped_column(INET)
    changes: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))


class ImportRun(Base):
    __tablename__ = "import_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    started_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    finished_at: Mapped[datetime | None]
    actor_id: Mapped[uuid.UUID | None]
    trigger: Mapped[str]                          # "cli" | "web"
    status: Mapped[str]                           # "running" | "ok" | "failed"
    error: Mapped[str | None]
    added: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    updated: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    unchanged: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    disabled: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    skipped: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    rows: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))


class SshKnownHost(Base):
    __tablename__ = "ssh_known_hosts"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    host: Mapped[str]
    port: Mapped[int] = mapped_column(Integer)
    key_type: Mapped[str]
    fingerprint_sha256: Mapped[str]
    public_key: Mapped[str]
    trusted_by: Mapped[uuid.UUID | None]
    trusted_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Environment(Base):
    """One ServerSherpa environment on a target (migration 0004)."""

    __tablename__ = "environments"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(unique=True)
    type: Mapped[str]                              # dev | beta | custom
    target_id: Mapped[str]                         # "ssh" | "ssh:<slug>"
    base_domain: Mapped[str]
    git_ref: Mapped[str] = mapped_column(server_default=text("'main'"))
    current_sha: Mapped[str | None]
    image_tag: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default=text("'new'"))
    proxy_ip: Mapped[str]
    bind_ip: Mapped[str] = mapped_column(server_default=text("'0.0.0.0'"))
    keep_dumps: Mapped[int] = mapped_column(Integer, server_default=text("5"))
    spaces_bucket: Mapped[str] = mapped_column(server_default=text("'serversherpa'"))
    log_level: Mapped[str] = mapped_column(server_default=text("'INFO'"))
    # The snapshot the first deploy restores (migration 0005); kept afterwards.
    seed_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("snapshots.id", ondelete="SET NULL"))
    # Deploys add steps 12–14 (DNS, proxy, smoke test) when on (migration 0006).
    publish: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_by: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class EnvironmentService(Base):
    __tablename__ = "environment_services"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"))
    service: Mapped[str]
    host_ip: Mapped[str]
    port: Mapped[int] = mapped_column(Integer)
    hostname: Mapped[str | None]
    proxied: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))


class EnvironmentSecret(Base):
    __tablename__ = "environment_secrets"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(primary_key=True)
    value_enc: Mapped[bytes] = mapped_column(BYTEA)
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Deployment(Base):
    __tablename__ = "deployments"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"))
    # update | reset | adopt | snapshot | restore_dump | rollback | publish | teardown
    # | vm_restore
    mode: Mapped[str]
    git_ref: Mapped[str]
    sha: Mapped[str]
    status: Mapped[str]
    start_step: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    retry_of: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("deployments.id", ondelete="SET NULL"))
    failed_step: Mapped[int | None] = mapped_column(Integer)
    dump_path: Mapped[str | None]
    # The snapshot a reset or first deploy restores, or the one a snapshot
    # job takes (migration 0005).
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("snapshots.id", ondelete="SET NULL"))
    # restore_dump / rollback: the backup's file name in <env-dir>/backups.
    restore_dump: Mapped[str | None]
    # Whether its plan has steps 12–14 (migration 0006): retries keep it.
    publish: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Proxmox (migration 0007): its plan has the VM steps (0 / 15); it asked
    # for a VM snapshot in step 0; the VM snapshot it took (vm_restore: the
    # one it restores). Retries keep all three.
    vm: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    take_vm_snapshot: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    vm_snapshot: Mapped[str | None]
    previous_sha: Mapped[str | None]
    error: Mapped[str | None]
    actor_id: Mapped[uuid.UUID | None]
    started_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    finished_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("clock_timestamp()"))


class DeploymentStep(Base):
    __tablename__ = "deployment_steps"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    deployment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("deployments.id", ondelete="CASCADE"))
    number: Mapped[int] = mapped_column(Integer)
    key: Mapped[str]
    name: Mapped[str]
    status: Mapped[str] = mapped_column(server_default=text("'pending'"))
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    log: Mapped[str] = mapped_column(server_default=text("''"))


class Snapshot(Base):
    """A snapshot bundle on SIRDAR_SNAPSHOTS_DIR (migration 0005). A pending
    row belongs to a running "snapshot" deployment; ready rows have a
    bundle; failed rows are what a failed snapshot job left."""

    __tablename__ = "snapshots"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(unique=True)
    origin: Mapped[str]                            # upload | environment
    source: Mapped[str]                            # manifest source / environment name
    status: Mapped[str] = mapped_column(server_default=text("'ready'"))
    alembic_revision: Mapped[str | None]
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    checksum: Mapped[str | None]                   # SHA-256 of the bundle file
    object_count: Mapped[int | None] = mapped_column(Integer)
    object_bytes: Mapped[int | None] = mapped_column(BigInteger)
    notes: Mapped[str] = mapped_column(server_default=text("''"))
    bundle_file: Mapped[str | None]                # file name in SIRDAR_SNAPSHOTS_DIR
    source_created_at: Mapped[datetime | None]
    created_by: Mapped[uuid.UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Integration(Base):
    """Credentials Sirdar publishes with (migration 0006): `config` holds the
    non-secret settings, `secret_enc` the token or password (Fernet,
    SIRDAR_SECRETS_KEY). Never returned; see deploy/integrations.py."""

    __tablename__ = "integrations"

    kind: Mapped[str] = mapped_column(primary_key=True)        # cloudflare | npm | proxmox
    config: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    secret_enc: Mapped[bytes | None] = mapped_column(BYTEA)
    updated_by: Mapped[uuid.UUID | None]
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ManagedRecord(Base):
    """A Cloudflare record, NPM proxy host or NPM certificate Sirdar manages
    for one environment's service (migration 0006). origin "created": Sirdar
    made it and Delete environment removes it; "claimed": it existed before,
    Sirdar keeps it up to date and never deletes it."""

    __tablename__ = "managed_records"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"))
    service: Mapped[str]
    kind: Mapped[str]                              # dns_record | proxy_host | certificate
    external_id: Mapped[str]
    name: Mapped[str]                              # the hostname it serves
    origin: Mapped[str]                            # created | claimed
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ProxmoxVm(Base):
    """The VM Sirdar builds on Proxmox for one environment (migration 0007),
    and the record that it is Sirdar's: Sirdar changes or destroys only VM
    `vmid` named `name`. `vmid` is reserved before Terraform creates it;
    `created` turns true after the first successful apply; `ip` is the
    address the guest agent reported. The private key is Fernet-encrypted
    with SIRDAR_SECRETS_KEY and never returned."""

    __tablename__ = "proxmox_vms"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True)
    node: Mapped[str]
    vmid: Mapped[int | None] = mapped_column(Integer)
    # The clone inputs, frozen from the integration at create: step 0
    # renders the VM from these (changing them would replace the VM).
    template_vmid: Mapped[int] = mapped_column(Integer)
    storage: Mapped[str]
    pool: Mapped[str]
    bridge: Mapped[str]
    vlan_tag: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str]
    cores: Mapped[int] = mapped_column(Integer)
    memory_mb: Mapped[int] = mapped_column(Integer)
    disk_gb: Mapped[int] = mapped_column(Integer)
    ip_mode: Mapped[str]                              # static | dhcp
    ip_cidr: Mapped[str | None]
    gateway: Mapped[str | None]
    ip: Mapped[str | None]
    ssh_public_key: Mapped[str]
    ssh_private_key_enc: Mapped[bytes] = mapped_column(BYTEA)
    keep_snapshots: Mapped[int] = mapped_column(Integer, server_default=text("3"))
    created: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
