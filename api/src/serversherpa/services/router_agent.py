"""GL.iNet router agent reports (POST /router-agent/report). A router is
identified by its WAN MAC and proves itself with a 256-bit secret it
generated at install. Nothing but identity is stored until an admin
approves the router; approval pins the secret (sha256) and lasts until
revoked. Decision table + rationale:
docs/superpowers/specs/2026-10-01-router-agent-design.md.

Every write happens in the caller's session; handle_report commits."""

import hashlib
import hmac
import re
import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.schemas import RouterDhcpClientIn, RouterReportIn
from serversherpa.db.models import AuditLog, Device, DeviceDhcpLease
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.requests import approver_ids
from serversherpa.services.audit import audit

REPORT_MIN_SPACING = timedelta(seconds=20)
REGISTER_IP_LIMIT = 10
REGISTER_IP_WINDOW = timedelta(hours=1)
LEASE_RETENTION = timedelta(days=7)
MAX_BODY_BYTES = 256 * 1024
MAX_DHCP_CLIENTS = 512
MAX_VPN = 32

_MAC = re.compile(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}")


class AgentError(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


def hash_secret(secret: str) -> str:
    # The secret is 256 random bits, so a plain digest is as strong as a
    # salted KDF here and lets one indexed-free compare do the check.
    return hashlib.sha256(secret.encode()).hexdigest()


def secret_matches(secret: str, hashed: str | None) -> bool:
    return hashed is not None and hmac.compare_digest(hash_secret(secret), hashed)


def vpn_summary(vpn: list[dict] | None) -> str | None:
    """'up' every enabled tunnel is up, 'down' none is, 'partial' some are,
    'none' nothing enabled is configured. None = the agent couldn't tell
    (the column stays free text so an unexpected value never breaks a
    report; the portal maps these four to chips)."""
    if vpn is None:
        return None
    enabled = [t for t in vpn if isinstance(t, dict) and t.get("enabled", True) is not False]
    if not enabled:
        return "none"
    up = sum(1 for t in enabled if t.get("up") is True)
    if up == len(enabled):
        return "up"
    return "down" if up == 0 else "partial"


def _text(value: object, limit: int = 64) -> str | None:
    return value[:limit] if isinstance(value, str) and value.strip() else None


def _identity(report: RouterReportIn) -> dict:
    return {"model": report.model, "firmware": report.firmware,
            "hostname": report.hostname, "agent_version": report.agent_version}


def _touch_identity(device: Device, report: RouterReportIn, ip: str,
                    now: datetime) -> None:
    device.model = _text(report.model)
    device.version = _text(report.firmware)
    device.raw_info = {**(device.raw_info or {}), **_identity(report)}
    device.agent_source_ip = ip
    device.last_seen_at = now
    device.updated_at = now


async def _notify_approvers(db: AsyncSession, device: Device, report: RouterReportIn,
                            ip: str) -> None:
    body = " · ".join(part for part in (
        _text(report.model) or "Router", _text(report.hostname, 255),
        device.mac, f"from {ip}") if part)
    payload = {"device_id": str(device.id), "mac": device.mac, "state": "pending"}
    for person_id in await approver_ids(db, resource="scanning_hardware", action="change"):
        await notify(db, person_id, "router_approval", "Router waiting for approval",
                     body=body, link=f"/hardware/routers?focus={device.id}",
                     payload=payload)


async def _register(db: AsyncSession, report: RouterReportIn, ip: str,
                    now: datetime) -> str:
    # Serialize concurrent first reports from one IP so the cap count below
    # can't be raced past; released at commit/rollback.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                     {"k": f"router-register:{ip}"})
    # Count from the audit trail, not devices.agent_source_ip (mutable, so a
    # second IP could launder the count).
    recent = await db.scalar(
        select(func.count()).select_from(AuditLog).where(
            AuditLog.entity_type == "device", AuditLog.action == "router_register",
            AuditLog.ip == ip, AuditLog.at >= now - REGISTER_IP_WINDOW))
    if (recent or 0) >= REGISTER_IP_LIMIT:
        raise AgentError("register_rate_limited", 429)
    name = _text(report.hostname, 255) or f"router-{report.wan_mac[-8:].replace(':', '')}"
    device = Device(device_type="router", name=name, mac=report.wan_mac,
                    approval_state="pending", agent_secret_hash=hash_secret(report.secret))
    _touch_identity(device, report, ip, now)
    db.add(device)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        if "devices_mac_uniq" not in str(exc.orig):
            raise
        # a concurrent first report from the same router won the insert
        return "pending"
    audit(db, actor_id=None, entity_type="device", entity_id=str(device.id),
          action="router_register",
          changes={"mac": device.mac, "model": device.model, "hostname": report.hostname},
          ip=ip)
    await _notify_approvers(db, device, report, ip)
    await db.commit()
    return "pending"


async def _adopt(db: AsyncSession, device: Device, report: RouterReportIn, ip: str,
                 now: datetime) -> str:
    """A router row made by hand (or sample data) already carries this MAC:
    take it over as a pending agent router, keeping its name and site."""
    device.approval_state = "pending"
    device.agent_secret_hash = hash_secret(report.secret)
    _touch_identity(device, report, ip, now)
    audit(db, actor_id=None, entity_type="device", entity_id=str(device.id),
          action="router_register",
          changes={"mac": device.mac, "model": device.model,
                   "hostname": report.hostname, "adopted": True},
          ip=ip)
    await _notify_approvers(db, device, report, ip)
    await db.commit()
    return "pending"


async def _sync_leases(db: AsyncSession, device_id: uuid.UUID,
                       clients: list[RouterDhcpClientIn], now: datetime) -> None:
    """Upsert by (device_id, mac); a client absent from this report goes
    down; one absent for LEASE_RETENTION is deleted. `now` is the
    transaction's now(), so every row this report touched has
    updated_at == now and everything older was not reported."""
    by_mac: dict[str, RouterDhcpClientIn] = {}
    for c in clients:
        mac = c.mac.strip().lower().replace("-", ":")
        if _MAC.fullmatch(mac):
            by_mac[mac] = c  # ON CONFLICT can't touch one row twice: last wins
    if by_mac:
        stmt = pg_insert(DeviceDhcpLease).values([
            {"device_id": device_id, "mac": mac, "ip": _text(c.ip),
             "hostname": _text(c.hostname, 255), "reserved": c.reserved, "up": c.up,
             "last_seen_at": now if c.up else None, "updated_at": now}
            for mac, c in by_mac.items()])
        stmt = stmt.on_conflict_do_update(
            index_elements=[DeviceDhcpLease.device_id, DeviceDhcpLease.mac],
            set_={"ip": stmt.excluded.ip, "hostname": stmt.excluded.hostname,
                  "reserved": stmt.excluded.reserved, "up": stmt.excluded.up,
                  "last_seen_at": func.coalesce(stmt.excluded.last_seen_at,
                                                DeviceDhcpLease.last_seen_at),
                  "updated_at": now})
        await db.execute(stmt)
    await db.execute(update(DeviceDhcpLease).where(
        DeviceDhcpLease.device_id == device_id,
        DeviceDhcpLease.updated_at < now,
        DeviceDhcpLease.up.is_(True)).values(up=False))
    await db.execute(delete(DeviceDhcpLease).where(
        DeviceDhcpLease.device_id == device_id,
        DeviceDhcpLease.updated_at < now - LEASE_RETENTION))


async def _store_snapshot(db: AsyncSession, device: Device, report: RouterReportIn,
                          ip: str, now: datetime) -> None:
    wan = report.wan or {}
    lan = report.lan or {}
    _touch_identity(device, report, ip, now)
    device.wan_ip = _text(wan.get("ip"))
    device.lan_ip = _text(lan.get("ip"))
    device.uptime_seconds = report.uptime_seconds
    device.vpn_status = vpn_summary(report.vpn)
    device.raw_info = {**_identity(report), "wan": report.wan, "lan": report.lan,
                       "wifi": report.wifi, "clients": report.clients, "vpn": report.vpn}
    if report.dhcp_clients is not None:
        await _sync_leases(db, device.id, report.dhcp_clients, now)


async def handle_report(db: AsyncSession, report: RouterReportIn, ip: str) -> str:
    """Apply one report. Returns the router's state as the agent may know
    it ('pending' | 'approved'); raises AgentError for 409/429."""
    now = await db.scalar(select(func.now()))
    device = await db.scalar(select(Device).where(Device.mac == report.wan_mac))
    if device is None:
        return await _register(db, report, ip, now)
    if device.device_type != "router":
        raise AgentError("mac_in_use", 409)
    if device.approval_state is None:
        return await _adopt(db, device, report, ip, now)
    if device.last_seen_at is not None and now - device.last_seen_at < REPORT_MIN_SPACING:
        raise AgentError("report_too_soon", 429)

    was_approved = device.approval_state == "approved"
    if not secret_matches(report.secret, device.agent_secret_hash):
        # A report that isn't signed with the pinned secret leaves no trace
        # but the candidate hash and the flag: it must not overwrite identity,
        # source IP or raw_info, nor move last_seen_at (which would 429 the
        # genuine router's next report).
        device.pending_secret_hash = hash_secret(report.secret)
        device.secret_mismatch = True
        device.approval_state = "pending"  # approved -> pending; revoked -> pending
        device.updated_at = now
        if was_approved:
            audit(db, actor_id=None, entity_type="device", entity_id=str(device.id),
                  action="router_secret_mismatch", changes={"mac": device.mac}, ip=ip)
        await db.commit()
        return "pending"

    if was_approved:
        await _store_snapshot(db, device, report, ip, now)
        await db.commit()
        return "approved"

    # pending or revoked, genuine secret: identity only. A revoked router
    # that keeps reporting goes back to pending, quietly (no notification).
    # The candidate is dropped so an attacker's can't be promoted by a later
    # approval; secret_mismatch stays until an admin approves or revokes.
    device.pending_secret_hash = None
    device.approval_state = "pending"
    _touch_identity(device, report, ip, now)
    await db.commit()
    return "pending"


async def resolve_router_copies(db: AsyncSession, device_id: uuid.UUID, state: str,
                                decided_by: str | None) -> None:
    """Rewrite every approver's copy of this router's approval notification
    so the popover stops offering Approve/Reject and shows the outcome."""
    await db.execute(text(
        "UPDATE notifications SET payload = payload || "
        "jsonb_build_object('state', CAST(:state AS text), "
        "'decided_by', CAST(:decided_by AS text)) "
        "WHERE kind = 'router_approval' "
        "AND payload ->> 'device_id' = CAST(:device_id AS text)"),
        {"state": state, "decided_by": decided_by, "device_id": str(device_id)})
