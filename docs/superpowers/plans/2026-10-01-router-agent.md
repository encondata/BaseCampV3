# GL.iNet Router Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let GL.iNet routers (GL-AC2100 and GL-MT3000) self-register with the
BaseCamp API by WAN MAC plus a router-generated secret. Reports are held
until an admin approves the router on Scanning Hardware › Routers or from
the inbox popover. After approval, the router's live status is stored: WAN
and LAN IPs, uptime, WiFi, client counts, DHCP clients and VPN tunnels.

**Architecture:**
- **Router side:** a send-only BusyBox `ash` agent (`router_agent/`), run
  as a procd service, plus a one-line `curl … | sh` installer.
- **API side:** one unauthenticated endpoint, `POST /router-agent/report`.
  - Its service layer upserts by MAC and keeps the router `pending` until
    an admin approves it.
  - It sends a `router_approval` inbox notification on first registration.
  - Once approved, it writes the snapshot to the existing `devices` and
    `device_dhcp_leases` tables.
- **Admin side:** `POST /devices/{id}/approve|revoke` endpoints.
- **Portal:** Approval and Status columns, row actions, WiFi/VPN tabs, an
  install-command modal, and a popover approve strip.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + Postgres (API);
React + TypeScript + Vitest (portal); BusyBox ash + `uci`/`ubus`/
`jsonfilter`/`jshn`/`iwinfo`/`wg`/`curl` (router); Docker `openwrt/rootfs`
for agent tests.

**Spec:** `docs/superpowers/specs/2026-10-01-router-agent-design.md`.

## Global Constraints

**Workspace and test runs**
- The worktree is `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/router-agent`,
  on branch `router-agent`. Run every command from there.
- API tests run with
  `SS_TEST_DB=serversherpa_test_router_agent api/.venv/bin/pytest …` from
  `api/`.
  - If `api/.venv` is missing in the worktree, use the main checkout's
    venv: `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest`.
  - Run with `PYTHONPATH=src` if imports resolve to the main checkout.
- Portal tests run with `npx vitest run <file>` from `portal/`. If
  `portal/node_modules` is missing, symlink the main checkout's:
  `ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules portal/node_modules`.
- **Run every test suite in the FOREGROUND, in one continuous call, with a
  600000 ms timeout.** Never background a suite and end the turn waiting.
- Never commit `api/src/serversherpa/_dev_reload.py`.

**Data model**
- The migration number is **0087**, with `down_revision "0086"`. Before
  committing it, check every `.claude/worktrees/*/api/migrations/versions/`
  and the dev DB for an existing 0087. The `rfid-station` branch already
  collides at 0086. If 0087 is taken, stop and tell the controller.
- Secrets are stored only as `hashlib.sha256(secret.encode()).hexdigest()`
  and compared with `hmac.compare_digest`.
- Approval states are exactly `pending`, `approved` and `revoked`. NULL
  means the row is not an agent router.

**Copy and conventions**
- Notification kind: `router_approval`. Payload:
  `{"device_id": "<uuid>", "mac": "<mac>", "state": "pending"}`.
  Resolved copies add `state` and `decided_by`.
- The report's `vpn_status` summary is one of `up`, `down`, `partial` or
  `none`. NULL means the router never reported VPN data.
- Reports are spaced at least **20 s** per router (429
  `report_too_soon`).
- Registrations are capped at **10 per IP per hour** (429
  `register_rate_limited`).
- Payload limits are 256 KB per body, 512 DHCP clients and 32 VPN entries
  (413 `payload_too_large`).
- Stale DHCP leases are kept for **7 days**.
- Online threshold: last seen within **16 minutes**.
- Default report interval is **300 s**, and the minimum is 60 s.
- Install URL:
  `https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh`
  (the repo is public).
- All copy, comments and docs use American English (color, recognize).
- Sorting uses `natural()` / `naturalCompare`; never `localeCompare` or a
  bare `.sort()` on strings.

---

## File Structure

**API**
- `api/migrations/versions/0087_router_agent.py`: approval and secret
  columns on `devices`.
- `api/src/serversherpa/db/models.py`: `Device` gains the 0087 columns.
- `api/src/serversherpa/api/schemas.py`:
  - `RouterDhcpClientIn` and `RouterReportIn`.
  - `DeviceItem` gains approval fields.
- `api/src/serversherpa/services/router_agent.py` (new): all report logic.
  - Hashing, the decision table, registration plus notification, the
    snapshot write, lease sync, `vpn_summary`, and resolving notification
    copies.
- `api/src/serversherpa/api/routes/router_agent.py` (new):
  `POST /router-agent/report`.
- `api/src/serversherpa/api/app.py`: registers the new router.
- `api/src/serversherpa/notifications/requests.py`: `approver_ids()` gains
  `resource`/`action` parameters, and `exclude` becomes optional.
- `api/src/serversherpa/api/routes/devices.py`:
  - New `approve` and `revoke` endpoints.
  - The list exposes the approval fields.
- Tests:
  - `api/tests/test_router_agent_api.py` (new)
  - `api/tests/test_devices_router_approval_api.py` (new)

**Portal**
- `portal/src/lib/api.ts`: `DeviceItem` approval fields, `approveRouter`,
  `revokeRouter`.
- `portal/src/lib/devices.ts`:
  - Approval, status, VPN and band helpers.
  - Readers for `raw_info` WiFi/VPN/client data.
  - The install command.
- `portal/src/pages/Routers.tsx`: columns, row actions, `?focus=`, and the
  "How to add a router" button.
- `portal/src/components/hardware/AddRouterModal.tsx` (new): the install
  command modal.
- `portal/src/components/hardware/RouterDetail.tsx` (new): the expansion.
  - Approved routers get DHCP / WiFi / VPN tabs.
  - Held routers get an identity panel.
- `portal/src/components/NotificationsPanel.tsx`: the `router_approval`
  strip and icon.
- `portal/src/styles/hardware.css`: identity panel and install-command
  styles.
- Tests:
  - `portal/src/pages/Routers.test.tsx` (modified)
  - `portal/src/components/hardware/RouterDetail.test.tsx` (new)
  - `portal/src/components/hardware/AddRouterModal.test.tsx` (new)
  - `portal/src/components/NotificationsPanel.test.tsx` (modified)

**Router**
- `router_agent/basecamp-router.sh`: the agent.
- `router_agent/basecamp-router.init`: the procd service.
- `router_agent/install.sh`: the installer and uninstaller.
- `router_agent/README.md`
- `router_agent/test/run.sh`: the host entry point; runs both suites in
  Docker.
- `router_agent/test/agent_test.sh` and `router_agent/test/install_test.sh`
- `router_agent/test/stubs/`: `uci`, `ubus`, `iwinfo`, `ip`, `wg`,
  `logger`, used by the agent tests.
- `router_agent/test/install-stubs/`: `curl`, `ubus`, `logger`, used by the
  install test.
- `router_agent/test/fixtures/fw4-mt3000/` and `router_agent/test/fixtures/fw3-ac2100/`

---

### Task 1: Migration 0087 and model columns

**Files:**
- Create: `api/migrations/versions/0087_router_agent.py`
- Modify: `api/src/serversherpa/db/models.py` (class `Device`, after the `setup_clear_requested_by` column)
- Test: `api/tests/test_router_agent_api.py` (new; this task adds only the schema test)

**Interfaces:**
- Produces: `Device.approval_state: str | None`,
  `Device.approved_at: datetime | None`,
  `Device.approved_by: uuid.UUID | None`,
  `Device.agent_secret_hash: str | None`,
  `Device.pending_secret_hash: str | None`,
  `Device.secret_mismatch: bool`,
  `Device.agent_source_ip: str | None`.

- [ ] **Step 1: Check the migration number is free**

Run:
```bash
ls /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/*/api/migrations/versions/ /Users/jrh1812/Developer/BaseCampV3/api/migrations/versions/ 2>/dev/null | grep '^0087'
cd api && .venv/bin/alembic current
```
Expected: `grep` prints nothing, and `alembic current` (which reads the
dev DB through `.env`) reports `0086` or lower. If 0087 exists anywhere,
stop and report it.

- [ ] **Step 2: Write the failing test**

Create `api/tests/test_router_agent_api.py`:

```python
"""POST /router-agent/report — GL.iNet router self-registration, approval
gating, secret pinning, snapshot + lease sync. Spec:
docs/superpowers/specs/2026-10-01-router-agent-design.md."""

from sqlalchemy import text


async def test_devices_has_the_router_agent_columns(db):
    cols = set((await db.scalars(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'devices'"))).all())
    assert {"approval_state", "approved_at", "approved_by", "agent_secret_hash",
            "pending_secret_hash", "secret_mismatch", "agent_source_ip"} <= cols
    bad = await db.scalar(text(
        "SELECT count(*) FROM pg_constraint WHERE conname = 'devices_approval_state_check'"))
    assert bad == 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_router_agent_api.py -v`
Expected: FAIL. The columns set is not a subset.

- [ ] **Step 4: Write the migration**

Create `api/migrations/versions/0087_router_agent.py`:

```python
"""GL.iNet router agent: approval state, pinned secret (hashed), the
candidate secret awaiting approval, and the last report's source IP.
NULL approval_state = not an agent router (kiosks, readers, hand-made rows).

Revision ID: 0087
Revises: 0086
Create Date: 2026-10-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0087"
down_revision: str | None = "0086"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("approval_state", sa.Text(), nullable=True))
    op.create_check_constraint(
        "devices_approval_state_check", "devices",
        "approval_state IN ('pending', 'approved', 'revoked')")
    op.add_column("devices", sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("devices", sa.Column(
        "approved_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))
    op.add_column("devices", sa.Column("agent_secret_hash", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column("pending_secret_hash", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column(
        "secret_mismatch", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("devices", sa.Column("agent_source_ip", sa.Text(), nullable=True))
    # the per-IP registration cap counts recent router rows from one address
    op.create_index(
        "devices_router_source_ip_created_idx", "devices",
        ["agent_source_ip", "created_at"],
        postgresql_where=sa.text("device_type = 'router'"))


def downgrade() -> None:
    op.drop_index("devices_router_source_ip_created_idx", table_name="devices")
    op.drop_column("devices", "agent_source_ip")
    op.drop_column("devices", "secret_mismatch")
    op.drop_column("devices", "pending_secret_hash")
    op.drop_column("devices", "agent_secret_hash")
    op.drop_column("devices", "approved_by")
    op.drop_column("devices", "approved_at")
    op.drop_constraint("devices_approval_state_check", "devices", type_="check")
    op.drop_column("devices", "approval_state")
```

- [ ] **Step 5: Add the model columns**

In `api/src/serversherpa/db/models.py`, class `Device`, directly after the
`setup_clear_requested_by` mapped column, add:

```python
    # GL.iNet router agent (migration 0087). approval_state NULL = not an
    # agent router. Reports are stored only while 'approved' AND the
    # report's secret matches agent_secret_hash; pending_secret_hash is a
    # newer secret seen since (reinstall/reset/impersonation) that an
    # approval promotes. Hashes are sha256 hex of the router's 256-bit secret.
    approval_state: Mapped[str | None]
    approved_at: Mapped[datetime | None]
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    agent_secret_hash: Mapped[str | None]
    pending_secret_hash: Mapped[str | None]
    secret_mismatch: Mapped[bool] = mapped_column(server_default=text("false"))
    agent_source_ip: Mapped[str | None]
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_router_agent_api.py -v`
Expected: PASS. The conftest migrates the test DB to head.

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0087_router_agent.py api/src/serversherpa/db/models.py api/tests/test_router_agent_api.py
git commit -m "feat(api): devices approval + agent secret columns for the router agent (migration 0087)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The report endpoint: registration, held reports, secret mismatch, rate limits

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py`. Add the router-agent
  schemas next to `DeviceRegisterIn`, around line 2796.
- Create: `api/src/serversherpa/services/router_agent.py`
- Create: `api/src/serversherpa/api/routes/router_agent.py`
- Modify: `api/src/serversherpa/api/app.py`. Add it to the routes import
  and `app.include_router(router_agent.router)` after
  `app.include_router(kiosk.router)`.
- Modify: `api/src/serversherpa/notifications/requests.py` (`approver_ids`)
- Test: `api/tests/test_router_agent_api.py`

**Interfaces:**
- Consumes: the Task 1 columns.
- Produces:
  - `serversherpa.services.router_agent`:
    - `hash_secret(secret: str) -> str`
    - `secret_matches(secret: str, hashed: str | None) -> bool`
    - `vpn_summary(vpn: list[dict] | None) -> str | None` (body filled in
      Task 3; this task returns `None`)
    - `async handle_report(db, report: RouterReportIn, ip: str) -> str`,
      returning `"pending"` or `"approved"`. It raises
      `AgentError(code, status)`.
    - `async resolve_router_copies(db, device_id: uuid.UUID, state: str, decided_by: str | None) -> None`
    - Constants: `REPORT_MIN_SPACING`, `REGISTER_IP_LIMIT`,
      `REGISTER_IP_WINDOW`, `LEASE_RETENTION`, `MAX_BODY_BYTES`,
      `MAX_DHCP_CLIENTS`, `MAX_VPN`.
  - `approver_ids(db, *, exclude=None, resource="notifications", action="change")`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_router_agent_api.py`. Replace its import block
with the one below, and keep the Task 1 test.

```python
import hashlib

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Device, Notification

SECRET = "0123456789abcdef" * 4
OTHER_SECRET = "fedcba9876543210" * 4
MAC = "94:83:c4:aa:bb:cc"


def report(**over) -> dict:
    body = {
        "schema_version": 1, "agent_version": "1.0.0",
        "wan_mac": MAC.upper(), "secret": SECRET,
        "model": "GL.iNet GL-MT3000", "firmware": "4.5.0", "hostname": "GL-MT3000-1a2",
        "uptime_seconds": 86400,
        "wan": {"interface": "wan", "ip": "203.0.113.7", "gateway": "203.0.113.1",
                "proto": "dhcp", "up": True},
        "lan": {"ip": "192.168.8.1", "netmask": "255.255.255.0"},
        "wifi": [{"radio": "radio0", "band": "2g", "ssid": "Site-WiFi", "channel": 6,
                  "enabled": True, "clients": 1}],
        "clients": {"total": 3, "wired": 1, "wireless": 2},
        "dhcp_clients": [
            {"mac": "aa:bb:cc:dd:ee:01", "ip": "192.168.8.120", "hostname": "kiosk-01",
             "reserved": True, "up": True},
            {"mac": "AA:BB:CC:DD:EE:02", "ip": "192.168.8.121", "hostname": None,
             "reserved": False, "up": True},
        ],
        "vpn": [{"name": "wgclient", "type": "wireguard", "role": "client", "enabled": True,
                 "up": True, "endpoint": "198.51.100.10:51820", "last_handshake_seconds": 42}],
    }
    body.update(over)
    return body


async def _router(db) -> Device:
    return await db.scalar(select(Device).where(Device.mac == MAC))


async def _age(db, minutes: int = 1) -> None:
    """Push every router's last_seen_at back so the 20 s spacing allows the
    next report (tests post back-to-back)."""
    await db.execute(text(
        "UPDATE devices SET last_seen_at = now() - make_interval(mins => :m) "
        "WHERE device_type = 'router'"), {"m": minutes})
    await db.commit()


async def _make_admin(db, person_id) -> None:
    await db.execute(text("UPDATE person_roles SET role='admin' WHERE person_id=:p"),
                     {"p": person_id})
    await db.commit()


async def test_first_report_registers_a_pending_router_and_stores_no_data(client, db):
    resp = await client.post("/router-agent/report", json=report())
    assert resp.status_code == 202, resp.text
    assert resp.json() == {"state": "pending"}
    d = await _router(db)
    assert d is not None and d.device_type == "router"
    assert d.approval_state == "pending"
    assert d.agent_secret_hash == hashlib.sha256(SECRET.encode()).hexdigest()
    assert d.name == "GL-MT3000-1a2"
    assert d.model == "GL.iNet GL-MT3000" and d.version == "4.5.0"
    assert d.last_seen_at is not None and d.agent_source_ip
    # held: no snapshot, no leases
    assert d.wan_ip is None and d.lan_ip is None and d.uptime_seconds is None
    assert d.vpn_status is None
    assert "wifi" not in d.raw_info and d.raw_info["hostname"] == "GL-MT3000-1a2"
    leases = await db.scalar(text("SELECT count(*) FROM device_dhcp_leases"))
    assert leases == 0
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "router_register", AuditLog.entity_id == str(d.id)))
    assert row is not None and row.changes["mac"] == MAC


async def test_first_report_notifies_scanning_hardware_approvers_once(client, db, seeded_user):
    await _make_admin(db, seeded_user.id)
    await client.post("/router-agent/report", json=report())
    d = await _router(db)
    notes = (await db.scalars(select(Notification).where(
        Notification.kind == "router_approval"))).all()
    assert len(notes) == 1
    n = notes[0]
    assert n.person_id == seeded_user.id
    assert n.title == "Router waiting for approval"
    assert MAC in n.body
    assert n.link == f"/hardware/routers?focus={d.id}"
    assert n.payload == {"device_id": str(d.id), "mac": MAC, "state": "pending"}
    # later reports while pending never notify again
    await _age(db)
    await client.post("/router-agent/report", json=report())
    assert await db.scalar(text(
        "SELECT count(*) FROM notifications WHERE kind = 'router_approval'")) == 1


async def test_staff_without_change_is_not_notified(client, db, seeded_user):
    await client.post("/router-agent/report", json=report())  # seeded_user is staff (view only)
    assert await db.scalar(text("SELECT count(*) FROM notifications")) == 0


async def test_pending_report_refreshes_identity_only(client, db):
    await client.post("/router-agent/report", json=report())
    await _age(db)
    resp = await client.post("/router-agent/report", json=report(firmware="4.6.0"))
    assert resp.status_code == 202
    d = await _router(db)
    await db.refresh(d)
    assert d.version == "4.6.0" and d.wan_ip is None
    assert d.secret_mismatch is False and d.pending_secret_hash is None


async def test_pending_report_with_a_new_secret_records_a_candidate(client, db):
    await client.post("/router-agent/report", json=report())
    await _age(db)
    await client.post("/router-agent/report", json=report(secret=OTHER_SECRET))
    d = await _router(db)
    await db.refresh(d)
    assert d.approval_state == "pending"
    assert d.agent_secret_hash == hashlib.sha256(SECRET.encode()).hexdigest()
    assert d.pending_secret_hash == hashlib.sha256(OTHER_SECRET.encode()).hexdigest()
    assert d.secret_mismatch is True


async def test_approved_router_with_a_different_secret_goes_back_to_pending(client, db):
    await client.post("/router-agent/report", json=report())
    await db.execute(text("UPDATE devices SET approval_state = 'approved' WHERE mac = :m"),
                     {"m": MAC})
    await _age(db)
    resp = await client.post("/router-agent/report", json=report(secret=OTHER_SECRET))
    assert resp.status_code == 202 and resp.json() == {"state": "pending"}
    d = await _router(db)
    await db.refresh(d)
    assert d.approval_state == "pending" and d.secret_mismatch is True
    assert d.wan_ip is None  # data discarded
    assert await db.scalar(select(AuditLog).where(
        AuditLog.action == "router_secret_mismatch", AuditLog.entity_id == str(d.id))) is not None
    assert await db.scalar(text(
        "SELECT count(*) FROM notifications WHERE kind = 'router_approval'")) == 0


async def test_revoked_router_that_reports_is_pending_again_without_a_notification(client, db, seeded_user):
    await client.post("/router-agent/report", json=report())
    await _make_admin(db, seeded_user.id)
    await db.execute(text("UPDATE devices SET approval_state = 'revoked' WHERE mac = :m"),
                     {"m": MAC})
    await db.commit()
    await _age(db)
    resp = await client.post("/router-agent/report", json=report())
    assert resp.status_code == 202
    d = await _router(db)
    await db.refresh(d)
    assert d.approval_state == "pending" and d.wan_ip is None
    assert await db.scalar(text("SELECT count(*) FROM notifications")) == 0


async def test_hand_made_router_row_with_the_mac_is_adopted_as_pending(client, db, seeded_user):
    await _make_admin(db, seeded_user.id)
    db.add(Device(device_type="router", name="dock-router-1", mac=MAC))
    await db.commit()
    resp = await client.post("/router-agent/report", json=report())
    assert resp.status_code == 202
    d = await _router(db)
    await db.refresh(d)
    assert d.name == "dock-router-1"  # an admin's name is kept
    assert d.approval_state == "pending" and d.agent_secret_hash
    assert await db.scalar(text(
        "SELECT count(*) FROM notifications WHERE kind = 'router_approval'")) == 1


async def test_mac_owned_by_another_device_type_is_409(client, db):
    db.add(Device(device_type="kiosk", name="kiosk-1", mac=MAC))
    await db.commit()
    resp = await client.post("/router-agent/report", json=report())
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "mac_in_use"


async def test_reports_closer_than_20_seconds_are_429(client, db):
    assert (await client.post("/router-agent/report", json=report())).status_code == 202
    resp = await client.post("/router-agent/report", json=report())
    assert resp.status_code == 429 and resp.json()["detail"]["code"] == "report_too_soon"


async def test_registrations_are_capped_per_ip(client, db):
    for i in range(10):
        mac = f"94:83:c4:00:00:{i:02x}"
        resp = await client.post("/router-agent/report", json=report(wan_mac=mac))
        assert resp.status_code == 202, resp.text
    resp = await client.post("/router-agent/report", json=report(wan_mac="94:83:c4:00:00:ff"))
    assert resp.status_code == 429 and resp.json()["detail"]["code"] == "register_rate_limited"


async def test_bad_reports_are_422(client):
    for bad in (report(wan_mac="not-a-mac"), report(wan_mac="01:00:5e:00:00:01"),
                report(wan_mac="00:00:00:00:00:00"), report(secret="short"),
                report(secret="Z" * 64)):
        resp = await client.post("/router-agent/report", json=bad)
        assert resp.status_code == 422 and resp.json()["detail"]["code"] == "bad_report"
    resp = await client.post("/router-agent/report", content=b"{not json",
                             headers={"Content-Type": "application/json"})
    assert resp.status_code == 422


async def test_oversized_reports_are_413(client):
    many = [{"mac": f"aa:bb:cc:dd:{i // 256:02x}:{i % 256:02x}", "up": True} for i in range(513)]
    resp = await client.post("/router-agent/report", json=report(dhcp_clients=many))
    assert resp.status_code == 413 and resp.json()["detail"]["code"] == "payload_too_large"
    vpns = [{"name": f"wg{i}", "up": True} for i in range(33)]
    resp = await client.post("/router-agent/report", json=report(vpn=vpns))
    assert resp.status_code == 413
    resp = await client.post("/router-agent/report", content=b" " * (256 * 1024 + 1),
                             headers={"Content-Type": "application/json"})
    assert resp.status_code == 413


async def test_response_never_explains_a_held_report(client, db):
    await client.post("/router-agent/report", json=report())
    await _age(db)
    resp = await client.post("/router-agent/report", json=report(secret=OTHER_SECRET))
    assert resp.json() == {"state": "pending"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_router_agent_api.py -v`
Expected: the new tests FAIL with 404 (no route). The Task 1 test passes.

- [ ] **Step 3: Parameterize `approver_ids`**

In `api/src/serversherpa/notifications/requests.py`, replace `approver_ids`
with:

```python
async def approver_ids(db: AsyncSession, *, exclude: uuid.UUID | None = None,
                       resource: str = "notifications",
                       action: str = "change") -> list[uuid.UUID]:
    """Distinct people who can decide a request: a non-revoked PersonRole
    whose role has RolePermission(resource, action), and who have a
    UserAccount (so there's someone to receive the notification), minus
    `exclude` (the requester) when given. Membership requests use the
    notifications:change default; router approvals ask for
    scanning_hardware:change."""
    query = (
        select(PersonRole.person_id).distinct()
        .join(RolePermission, RolePermission.role == PersonRole.role)
        .join(UserAccount, UserAccount.person_id == PersonRole.person_id)
        .where(
            PersonRole.revoked_at.is_(None),
            RolePermission.resource == resource,
            RolePermission.action == action,
        ))
    if exclude is not None:
        query = query.where(PersonRole.person_id != exclude)
    return list((await db.scalars(query)).all())
```

- [ ] **Step 4: Add the schemas**

In `api/src/serversherpa/api/schemas.py`, after `class DeviceRegisterIn`,
add:

```python
_ROUTER_MAC = re.compile(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}")


class RouterDhcpClientIn(BaseModel):
    """One DHCP client in a router report. `mac` is validated by the
    service (a bad lease is skipped, never fatal to the whole report)."""
    mac: str = Field(max_length=64)
    ip: str | None = Field(default=None, max_length=64)
    hostname: str | None = Field(default=None, max_length=255)
    reserved: bool = False
    up: bool = False


class RouterReportIn(BaseModel):
    """POST /router-agent/report — the GL.iNet agent's status report
    (router_agent/basecamp-router.sh, schema_version 1). wan/lan/wifi/
    clients/vpn are stored as reported in raw_info; only the fields the
    API reads are typed. A section the agent failed to collect is null."""
    schema_version: int = Field(ge=1)
    agent_version: str | None = Field(default=None, max_length=32)
    wan_mac: str
    secret: str = Field(pattern=r"^[0-9a-f]{64}$")
    model: str | None = Field(default=None, max_length=64)
    firmware: str | None = Field(default=None, max_length=64)
    hostname: str | None = Field(default=None, max_length=255)
    uptime_seconds: int | None = Field(default=None, ge=0)
    wan: dict | None = None
    lan: dict | None = None
    wifi: list[dict] | None = None
    clients: dict | None = None
    dhcp_clients: list[RouterDhcpClientIn] | None = None
    vpn: list[dict] | None = None

    @field_validator("wan_mac")
    @classmethod
    def _unicast_mac(cls, v: str) -> str:
        mac = v.strip().lower().replace("-", ":")
        if (not _ROUTER_MAC.fullmatch(mac) or int(mac[:2], 16) & 1
                or mac == "00:00:00:00:00:00"):
            raise ValueError("bad_mac")
        return mac
```

- [ ] **Step 5: Write the service**

Create `api/src/serversherpa/services/router_agent.py`:

```python
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
from serversherpa.db.models import Device, DeviceDhcpLease
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
    return None  # Task 3


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
    recent = await db.scalar(
        select(func.count()).select_from(Device).where(
            Device.device_type == "router", Device.agent_source_ip == ip,
            Device.created_at >= now - REGISTER_IP_WINDOW))
    if (recent or 0) >= REGISTER_IP_LIMIT:
        raise AgentError("register_rate_limited", 429)
    name = _text(report.hostname, 255) or f"router-{report.wan_mac[-8:].replace(':', '')}"
    device = Device(device_type="router", name=name, mac=report.wan_mac,
                    approval_state="pending", agent_secret_hash=hash_secret(report.secret))
    _touch_identity(device, report, ip, now)
    db.add(device)
    try:
        await db.flush()
    except IntegrityError:
        # a concurrent first report from the same router won the insert
        await db.rollback()
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


async def _store_snapshot(db: AsyncSession, device: Device, report: RouterReportIn,
                          ip: str, now: datetime) -> None:
    pass  # Task 3


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

    matches = secret_matches(report.secret, device.agent_secret_hash)
    if device.approval_state == "approved":
        if matches:
            await _store_snapshot(db, device, report, ip, now)
            await db.commit()
            return "approved"
        device.approval_state = "pending"
        device.pending_secret_hash = hash_secret(report.secret)
        device.secret_mismatch = True
        _touch_identity(device, report, ip, now)
        audit(db, actor_id=None, entity_type="device", entity_id=str(device.id),
              action="router_secret_mismatch", changes={"mac": device.mac}, ip=ip)
        await db.commit()
        return "pending"

    # pending or revoked: identity only. A revoked router that keeps
    # reporting goes back to pending, quietly (no new notification).
    if not matches:
        device.pending_secret_hash = hash_secret(report.secret)
        device.secret_mismatch = True
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
```

`delete`, `update`, `pg_insert`, `RouterDhcpClientIn`, `_MAC` and
`LEASE_RETENTION` are used in Task 3. Leave the imports in place. If ruff
flags them unused in this task's commit, add `# noqa: F401` to those
import lines now and remove it in Task 3.

- [ ] **Step 6: Write the route**

Create `api/src/serversherpa/api/routes/router_agent.py`:

```python
"""POST /router-agent/report — the GL.iNet router agent's only endpoint.
No user session: a router proves itself with its WAN MAC + secret, and
nothing beyond identity is stored until an admin approves it
(services/router_agent.py). Not subject to read-only maintenance mode —
it never passes through the user-auth dependency that enforces it, and
reports are telemetry (same reasoning as /kiosk/printer-events)."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from serversherpa.api.deps import DbSession, rate_limit_ip
from serversherpa.api.schemas import RouterReportIn
from serversherpa.services.router_agent import (
    MAX_BODY_BYTES, MAX_DHCP_CLIENTS, MAX_VPN, AgentError, handle_report,
)

router = APIRouter(prefix="/router-agent", tags=["router-agent"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


@router.post("/report")
async def post_report(request: Request, db: DbSession) -> JSONResponse:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise _err(413, "payload_too_large")
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise _err(413, "payload_too_large")
    try:
        body = RouterReportIn.model_validate_json(raw)
    except ValidationError:
        raise _err(422, "bad_report") from None
    if ((body.dhcp_clients is not None and len(body.dhcp_clients) > MAX_DHCP_CLIENTS)
            or (body.vpn is not None and len(body.vpn) > MAX_VPN)):
        raise _err(413, "payload_too_large")
    try:
        state = await handle_report(db, body, rate_limit_ip(request))
    except AgentError as exc:
        raise _err(exc.status, exc.code) from None
    return JSONResponse({"state": state}, status_code=200 if state == "approved" else 202)
```

In `api/src/serversherpa/api/app.py`, add `router_agent` to the
`from serversherpa.api.routes import (...)` list, keeping it alphabetical
after `reports`. Add `app.include_router(router_agent.router)` on the line
after `app.include_router(kiosk.router)`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_router_agent_api.py tests/test_notification_requests_service.py tests/test_notification_self_service.py -v`
Expected: all PASS. The notification suites prove that the
`approver_ids` change kept membership requests working.

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/services/router_agent.py api/src/serversherpa/api/routes/router_agent.py api/src/serversherpa/api/app.py api/src/serversherpa/notifications/requests.py api/tests/test_router_agent_api.py
git commit -m "feat(api): POST /router-agent/report — MAC+secret self-registration, held reports, approval notification, rate limits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Approved snapshot, VPN summary and DHCP lease sync

**Files:**
- Modify: `api/src/serversherpa/services/router_agent.py`. Fill in
  `vpn_summary` and `_store_snapshot`, and add `_sync_leases`.
- Test: `api/tests/test_router_agent_api.py`

**Interfaces:**
- Consumes: Task 2's `handle_report` and its helpers.
- Produces: `vpn_summary(vpn) -> 'up' | 'down' | 'partial' | 'none' | None`.
  Approved reports fill `devices.wan_ip`, `lan_ip`, `uptime_seconds` and
  `vpn_status`. `raw_info` gets the keys `model`, `firmware`, `hostname`,
  `agent_version`, `wan`, `lan`, `wifi`, `clients` and `vpn`, and
  `device_dhcp_leases` is synced.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_router_agent_api.py`:

```python
from serversherpa.services.router_agent import vpn_summary  # noqa: E402


async def _approved(client, db) -> Device:
    await client.post("/router-agent/report", json=report())
    await db.execute(text("UPDATE devices SET approval_state = 'approved' WHERE mac = :m"),
                     {"m": MAC})
    await db.commit()
    await _age(db)
    return await _router(db)


def test_vpn_summary():
    assert vpn_summary(None) is None
    assert vpn_summary([]) == "none"
    assert vpn_summary([{"enabled": False, "up": False}]) == "none"
    assert vpn_summary([{"enabled": True, "up": True}]) == "up"
    assert vpn_summary([{"up": True}, {"enabled": False, "up": False}]) == "up"
    assert vpn_summary([{"enabled": True, "up": False}]) == "down"
    assert vpn_summary([{"enabled": True, "up": True}, {"enabled": True, "up": False}]) == "partial"


async def test_approved_report_stores_the_snapshot(client, db):
    await _approved(client, db)
    resp = await client.post("/router-agent/report", json=report())
    assert resp.status_code == 200 and resp.json() == {"state": "approved"}
    d = await _router(db)
    await db.refresh(d)
    assert (d.wan_ip, d.lan_ip, d.uptime_seconds) == ("203.0.113.7", "192.168.8.1", 86400)
    assert d.vpn_status == "up"
    assert d.raw_info["wifi"][0]["ssid"] == "Site-WiFi"
    assert d.raw_info["clients"] == {"total": 3, "wired": 1, "wireless": 2}
    assert d.raw_info["vpn"][0]["endpoint"] == "198.51.100.10:51820"
    assert d.raw_info["hostname"] == "GL-MT3000-1a2"


async def test_lease_sync_upserts_marks_missing_down_and_purges_after_7_days(client, db):
    d = await _approved(client, db)
    await client.post("/router-agent/report", json=report())
    rows = (await db.execute(text(
        "SELECT mac, ip, hostname, reserved, up, last_seen_at IS NOT NULL "
        "FROM device_dhcp_leases WHERE device_id = :d ORDER BY mac"), {"d": d.id})).all()
    assert [tuple(r) for r in rows] == [
        ("aa:bb:cc:dd:ee:01", "192.168.8.120", "kiosk-01", True, True, True),
        ("aa:bb:cc:dd:ee:02", "192.168.8.121", None, False, True, True),
    ]
    # an old, long-gone lease is purged; ee:02 vanishes from the report -> down, kept
    await db.execute(text(
        "INSERT INTO device_dhcp_leases (device_id, mac, up, updated_at) "
        "VALUES (:d, 'aa:bb:cc:dd:ee:99', false, now() - interval '8 days')"), {"d": d.id})
    await db.commit()
    await _age(db)
    only_one = report(dhcp_clients=[{"mac": "aa:bb:cc:dd:ee:01", "ip": "192.168.8.120",
                                     "hostname": "kiosk-01", "reserved": True, "up": True}])
    await client.post("/router-agent/report", json=only_one)
    rows = dict((await db.execute(text(
        "SELECT mac, up FROM device_dhcp_leases WHERE device_id = :d"), {"d": d.id})).all())
    assert rows == {"aa:bb:cc:dd:ee:01": True, "aa:bb:cc:dd:ee:02": False}


async def test_a_down_client_keeps_its_last_seen_time(client, db):
    d = await _approved(client, db)
    await client.post("/router-agent/report", json=report())
    first = await db.scalar(text(
        "SELECT last_seen_at FROM device_dhcp_leases WHERE mac = 'aa:bb:cc:dd:ee:02'"))
    await _age(db)
    down = report(dhcp_clients=[{"mac": "aa:bb:cc:dd:ee:02", "up": False}])
    await client.post("/router-agent/report", json=down)
    again = await db.scalar(text(
        "SELECT last_seen_at FROM device_dhcp_leases WHERE mac = 'aa:bb:cc:dd:ee:02'"))
    assert again == first


async def test_null_dhcp_section_leaves_leases_untouched_and_bad_macs_are_skipped(client, db):
    d = await _approved(client, db)
    await client.post("/router-agent/report", json=report())
    await _age(db)
    await client.post("/router-agent/report", json=report(dhcp_clients=None, vpn=None))
    n = await db.scalar(text(
        "SELECT count(*) FROM device_dhcp_leases WHERE device_id = :d AND up"), {"d": d.id})
    assert n == 2
    await db.refresh(d)
    assert d.vpn_status is None
    await _age(db)
    weird = report(dhcp_clients=[{"mac": "garbage", "up": True},
                                 {"mac": "aa:bb:cc:dd:ee:01", "up": True},
                                 {"mac": "AA:BB:CC:DD:EE:01", "up": True, "hostname": "dup"}])
    assert (await client.post("/router-agent/report", json=weird)).status_code == 200
    host = await db.scalar(text(
        "SELECT hostname FROM device_dhcp_leases WHERE mac = 'aa:bb:cc:dd:ee:01'"))
    assert host == "dup"  # duplicate MACs in one report: the last one wins
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_router_agent_api.py -v`
Expected: `test_vpn_summary` and the snapshot and lease tests FAIL.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/services/router_agent.py`, replace the `vpn_summary`
stub:

```python
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
```

Replace the `_store_snapshot` stub and add `_sync_leases` above it:

```python
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
        DeviceDhcpLease.updated_at < now).values(up=False))
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
```

If Task 2 added `# noqa: F401` markers, remove them now.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_router_agent_api.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/services/router_agent.py api/tests/test_router_agent_api.py
git commit -m "feat(api): approved router reports store the snapshot, VPN summary and sync DHCP leases

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Admin approve and revoke, and the approval fields on the device list

**Files:**
- Modify: `api/src/serversherpa/api/routes/devices.py`
- Modify: `api/src/serversherpa/api/schemas.py` (`DeviceItem`)
- Test: `api/tests/test_devices_router_approval_api.py` (new)

**Interfaces:**
- Consumes: `resolve_router_copies` and `hash_secret` (Task 2).
- Produces:
  - `POST /devices/{id}/approve` and `POST /devices/{id}/revoke`, both
    returning `DeviceItem`. Errors: 404 `device_not_found`, 409
    `not_a_router`, 409 `not_an_agent_router`.
  - `DeviceItem` gains `approval_state: str | None`,
    `approved_at: datetime | None`, `approved_by_name: str | None`,
    `secret_mismatch: bool`, `agent_source_ip: str | None`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_devices_router_approval_api.py`:

```python
"""Approve / revoke an agent router on Scanning Hardware › Routers, and the
approval fields GET /devices exposes. Spec:
docs/superpowers/specs/2026-10-01-router-agent-design.md."""

import hashlib

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Device, Notification
from serversherpa.notifications.inbox import notify
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff

OLD = hashlib.sha256(b"a" * 64).hexdigest()
NEW = hashlib.sha256(b"b" * 64).hexdigest()


async def _router(db, **over) -> Device:
    d = Device(device_type="router", name="dock-router", mac="94:83:c4:aa:bb:cc",
               approval_state="pending", agent_secret_hash=OLD,
               agent_source_ip="203.0.113.7", **over)
    db.add(d)
    await db.commit()
    return d


async def test_approve_sets_state_promotes_the_candidate_secret_and_audits(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, pending_secret_hash=NEW, secret_mismatch=True)
    resp = await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approval_state"] == "approved"
    assert body["approved_at"] is not None and body["approved_by_name"]
    assert body["secret_mismatch"] is False
    await db.refresh(d)
    assert d.agent_secret_hash == NEW and d.pending_secret_hash is None
    assert d.approved_by == seeded_user.id
    assert await db.scalar(select(AuditLog).where(
        AuditLog.action == "router_approve", AuditLog.entity_id == str(d.id))) is not None


async def test_approving_twice_is_a_quiet_no_op(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db)
    await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    resp = await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    assert resp.status_code == 200 and resp.json()["approval_state"] == "approved"
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "router_approve", AuditLog.entity_id == str(d.id)))).all()
    assert len(rows) == 1


async def test_approve_keeps_the_pinned_secret_when_no_candidate(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db)
    await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    await db.refresh(d)
    assert d.agent_secret_hash == OLD


async def test_revoke_and_its_audit(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, approval_state="approved", wan_ip="203.0.113.7")
    resp = await client.post(f"/devices/{d.id}/revoke", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["approval_state"] == "revoked"
    assert resp.json()["wan_ip"] == "203.0.113.7"  # snapshot kept for reference
    assert await db.scalar(select(AuditLog).where(
        AuditLog.action == "router_revoke", AuditLog.entity_id == str(d.id))) is not None


async def test_decisions_resolve_every_approver_copy(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db)
    await notify(db, seeded_user.id, "router_approval", "Router waiting for approval",
                 payload={"device_id": str(d.id), "mac": d.mac, "state": "pending"})
    await db.commit()
    await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    n = await db.scalar(select(Notification).where(Notification.kind == "router_approval"))
    await db.refresh(n)
    assert n.payload["state"] == "approved" and n.payload["decided_by"]
    await client.post(f"/devices/{d.id}/revoke", headers=hdrs)
    await db.refresh(n)
    assert n.payload["state"] == "revoked"


async def test_errors(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/devices/00000000-0000-0000-0000-000000000000/approve", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "device_not_found"
    kiosk = Device(device_type="kiosk", name="k1")
    hand_made = Device(device_type="router", name="r-by-hand")
    db.add_all([kiosk, hand_made])
    await db.commit()
    for path in ("approve", "revoke"):
        resp = await client.post(f"/devices/{kiosk.id}/{path}", headers=hdrs)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_a_router"
        resp = await client.post(f"/devices/{hand_made.id}/{path}", headers=hdrs)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_an_agent_router"


async def test_needs_scanning_hardware_change(client, db, seeded_user):
    hdrs = await login_staff(client, seeded_user)  # staff: scanning_hardware view only
    d = await _router(db)
    for path in ("approve", "revoke"):
        assert (await client.post(f"/devices/{d.id}/{path}", headers=hdrs)).status_code == 403


async def test_list_exposes_approval_fields_but_never_hashes(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, secret_mismatch=True)
    rows = (await client.get("/devices?device_type=router", headers=hdrs)).json()
    row = next(r for r in rows if r["id"] == str(d.id))
    assert row["approval_state"] == "pending" and row["secret_mismatch"] is True
    assert row["agent_source_ip"] == "203.0.113.7" and row["approved_by_name"] is None
    assert "agent_secret_hash" not in row and "pending_secret_hash" not in row
    kiosk = Device(device_type="kiosk", name="k1")
    db.add(kiosk)
    await db.commit()
    rows = (await client.get("/devices?device_type=kiosk", headers=hdrs)).json()
    assert rows[0]["approval_state"] is None and rows[0]["secret_mismatch"] is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_devices_router_approval_api.py -v`
Expected: FAIL. The routes return 404 or 405, and the list has no
approval fields.

- [ ] **Step 3: Extend `DeviceItem`**

In `api/src/serversherpa/api/schemas.py`, `class DeviceItem`, after
`setup_clear_requested_by_name`, add:

```python
    # router agent (migration 0087); NULL/False for every other device
    approval_state: str | None = None
    approved_at: datetime | None = None
    approved_by_name: str | None = None
    secret_mismatch: bool = False
    agent_source_ip: str | None = None
```

- [ ] **Step 4: Extend the list query and add the endpoints**

In `api/src/serversherpa/api/routes/devices.py`:

1. Update the module docstring's first sentences to say this module is
   the registry's admin surface. The router agent's own report endpoint
   lives in `routes/router_agent.py`.
2. Add `update` to the `from sqlalchemy import ...` line. Add
   `from serversherpa.services.router_agent import resolve_router_copies`.
3. Below `ClearRequester = aliased(Person)`, add
   `Approver = aliased(Person)`.
4. In `_device_query()`, append
   `Approver.preferred_name, Approver.first_name, Approver.last_name` to
   the `select(...)` column list after the `ClearRequester` columns. Add
   `.outerjoin(Approver, Approver.id == Device.approved_by)` after the
   `ClearRequester` outer join.
5. In `_row_to_item`, extend the unpacking tuple with
   `approver_preferred, approver_first, approver_last` at the end. Add
   these entries to the returned dict:

```python
        "approval_state": d.approval_state,
        "approved_at": d.approved_at,
        "approved_by_name": (
            f"{approver_preferred or approver_first} {approver_last}"
            if approver_last is not None else None),
        "secret_mismatch": d.secret_mismatch,
        "agent_source_ip": d.agent_source_ip,
```

6. Add, before `@router.delete("/{device_id}", ...)`:

```python
def _display(person: Person) -> str:
    return f"{person.preferred_name or person.first_name} {person.last_name}"


async def _agent_router_or_error(db: DbSession, device_id: uuid.UUID) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    if device.device_type != "router":
        raise _err(409, "not_a_router")
    if device.approval_state is None:
        # made by hand / sample data: no agent has registered, no secret to pin
        raise _err(409, "not_an_agent_router")
    return device


@router.post("/{device_id}/approve", response_model=DeviceItem)
async def approve_router(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    """Start storing this router's reports. A candidate secret seen since
    registration (reinstall/reset) is promoted — approving trusts the
    newest. Guarded on state, so a double approval changes nothing."""
    device = await _agent_router_or_error(db, device_id)
    now = datetime.now(UTC)
    result = await db.execute(
        update(Device)
        .where(Device.id == device.id, Device.approval_state != "approved")
        .values(approval_state="approved", approved_at=now, approved_by=actor.person.id,
                agent_secret_hash=func.coalesce(Device.pending_secret_hash,
                                                Device.agent_secret_hash),
                pending_secret_hash=None, secret_mismatch=False, updated_at=now)
        .execution_options(synchronize_session=False))
    if result.rowcount:
        audit(db, actor_id=actor.person.id, entity_type="device",
              entity_id=str(device.id), action="router_approve",
              changes={"mac": device.mac})
        await resolve_router_copies(db, device.id, "approved", _display(actor.person))
    await db.commit()
    await db.refresh(device)
    return await _item_for(db, device.id)


@router.post("/{device_id}/revoke", response_model=DeviceItem)
async def revoke_router(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    """Stop storing reports (the inbox's Reject calls this too). The last
    snapshot stays for reference; if the router keeps reporting it shows
    as pending again, without a new notification."""
    device = await _agent_router_or_error(db, device_id)
    now = datetime.now(UTC)
    result = await db.execute(
        update(Device)
        .where(Device.id == device.id, Device.approval_state != "revoked")
        .values(approval_state="revoked", updated_at=now)
        .execution_options(synchronize_session=False))
    if result.rowcount:
        audit(db, actor_id=actor.person.id, entity_type="device",
              entity_id=str(device.id), action="router_revoke",
              changes={"mac": device.mac})
        await resolve_router_copies(db, device.id, "revoked", _display(actor.person))
    await db.commit()
    await db.refresh(device)
    return await _item_for(db, device.id)
```

If `actor.person` lacks `preferred_name` (check `AuthContext` in
`api/deps.py`), use the attribute the existing `_row_to_item` name format
relies on. The existing code reads `preferred_name`, `first_name` and
`last_name` from `Person`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest tests/test_devices_router_approval_api.py tests/test_devices_api.py tests/test_devices_clear_setup_api.py tests/test_devices_clear_offline_api.py tests/test_router_agent_api.py -v`
Expected: all PASS.

- [ ] **Step 6: Run the full API suite**

Run: `cd api && SS_TEST_DB=serversherpa_test_router_agent .venv/bin/pytest -q -x` (foreground, 600000 ms timeout)
Expected: all pass, apart from failures that are documented as
environment-only, such as WeasyPrint. Report any other failure.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/api/routes/devices.py api/src/serversherpa/api/schemas.py api/tests/test_devices_router_approval_api.py
git commit -m "feat(api): approve/revoke agent routers; GET /devices exposes approval fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Portal API client and device helpers

**Files:**
- Modify: `portal/src/lib/api.ts` (`DeviceItem`, around line 4437, and the
  new functions after `cancelClearSetup`)
- Modify: `portal/src/lib/devices.ts`
- Test: `portal/src/lib/devices.test.ts`. Create it if it doesn't exist.
  If it exists, append to it.

**Interfaces:**
- Produces:
  - In `api.ts`:
    - `DeviceItem` gains the optional fields `approval_state`,
      `approved_at`, `approved_by_name`, `secret_mismatch` and
      `agent_source_ip`.
    - `approveRouter(id): Promise<DeviceItem>`
    - `revokeRouter(id): Promise<DeviceItem>`
  - In `devices.ts`:
    - `approvalLabel(state)`
    - `routerStatus(lastSeenIso, now?) -> 'online' | 'offline' | 'never'`
    - `routerStatusLabel`
    - `ROUTER_ONLINE_MS`
    - `vpnChipClass(status)`
    - `bandLabel(band)`
    - `routerWifi(d): RouterWifi[]`, `routerVpn(d): RouterVpn[]`
    - `routerClientTotal(d): number`
    - `ROUTER_INSTALL_URL`, `routerInstallCommand(api)`
    - `deviceCellText` / `deviceSortValue` cases for `approval`, `status`
      and router `connected`.

- [ ] **Step 1: Write the failing tests**

Add to `portal/src/lib/devices.test.ts`. If you create the file, start it
with `import { describe, expect, it } from 'vitest';`.

```ts
import type { DeviceItem } from './api';
import {
  approvalLabel, bandLabel, deviceCellText, routerClientTotal, routerInstallCommand,
  routerStatus, routerVpn, routerWifi, vpnChipClass, vpnLabel,
} from './devices';

const base = {
  id: 'r1', device_type: 'router', name: 'r', serial: null, mac: '94:83:c4:aa:bb:cc',
  site_id: null, site_name: null, wan_ip: null, lan_ip: null, uptime_seconds: null,
  last_seen_at: null, raw_info: {}, registered_at: '2026-10-01T00:00:00Z',
  vpn_status: null, token_expires_at: null, connected_count: 2, model: null,
  antennas_connected: null, connection_type: null, scan_status: null,
  scan_status_label: null, scan_status_color: null, tags_read_24h: 0, version: null,
  sub_type: null, current_initiative_id: null, current_initiative_name: null,
  session_person_id: null, session_person_name: null, session_login_method: null,
  session_started_at: null, setup_clear_requested_at: null, setup_clear_requested_by_name: null,
} satisfies DeviceItem;

describe('router helpers', () => {
  it('labels approval states and adds the secret-changed note to the cell text', () => {
    expect(approvalLabel('pending')).toBe('Pending');
    expect(approvalLabel('approved')).toBe('Approved');
    expect(approvalLabel('revoked')).toBe('Revoked');
    expect(approvalLabel(null)).toBe('—');
    expect(deviceCellText({ ...base, approval_state: 'pending', secret_mismatch: true }, 'approval'))
      .toBe('Pending · Secret changed');
  });

  it('online within 16 minutes, offline after, never without a check-in', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(routerStatus('2026-10-01T11:45:00Z', now)).toBe('online');
    expect(routerStatus('2026-10-01T11:43:00Z', now)).toBe('offline');
    expect(routerStatus(null, now)).toBe('never');
  });

  it('maps both VPN vocabularies to labels and chips', () => {
    expect(vpnLabel('up')).toBe('Up');
    expect(vpnLabel('partial')).toBe('Partial');
    expect(vpnLabel('none')).toBe('None');
    expect(vpnLabel('connected')).toBe('Connected');
    expect(vpnChipClass('up')).toBe(' c-green');
    expect(vpnChipClass('connected')).toBe(' c-green');
    expect(vpnChipClass('down')).toBe(' c-red');
    expect(vpnChipClass('partial')).toBe(' c-amber');
    expect(vpnChipClass('none')).toBe('');
  });

  it('reads wifi/vpn/clients out of raw_info defensively', () => {
    const d = { ...base, raw_info: {
      wifi: [{ ssid: 'Site', band: '5g' }], vpn: [{ name: 'wg' }], clients: { total: 7 },
    } };
    expect(routerWifi(d)).toEqual([{ ssid: 'Site', band: '5g' }]);
    expect(routerVpn(d)).toEqual([{ name: 'wg' }]);
    expect(routerClientTotal(d)).toBe(7);
    expect(deviceCellText(d, 'connected')).toBe('7');
    expect(routerWifi({ ...base, raw_info: { wifi: 'nope' } })).toEqual([]);
    expect(routerClientTotal(base)).toBe(2); // falls back to the lease count
    expect(bandLabel('2g')).toBe('2.4 GHz');
    expect(bandLabel('6g')).toBe('6 GHz');
    expect(bandLabel(undefined)).toBe('—');
  });

  it('builds the one-line install command', () => {
    expect(routerInstallCommand('https://api.example.com/')).toBe(
      'curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh'
      + ' | sh -s -- --api https://api.example.com',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd portal && npx vitest run src/lib/devices.test.ts`
Expected: FAIL. The functions are not exported.

- [ ] **Step 3: Implement the API client**

In `portal/src/lib/api.ts`, in `interface DeviceItem`, after the
`setup_clear_requested_*` line, add:

```ts
  /** Router agent (optional so non-router fixtures stay valid): NULL/absent
   *  approval_state = not an agent router. */
  approval_state?: 'pending' | 'approved' | 'revoked' | null;
  approved_at?: string | null; approved_by_name?: string | null;
  secret_mismatch?: boolean; agent_source_ip?: string | null;
```

After `cancelClearSetup`, add:

```ts
/** Start storing an agent router's reports (also promotes a changed secret). */
export async function approveRouter(id: string): Promise<DeviceItem> {
  const resp = await apiFetch(`/devices/${id}/approve`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Stop storing an agent router's reports (the inbox's Reject, too). */
export async function revokeRouter(id: string): Promise<DeviceItem> {
  const resp = await apiFetch(`/devices/${id}/revoke`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 4: Implement the helpers**

In `portal/src/lib/devices.ts`, replace `vpnLabel` with:

```ts
/** Both vocabularies: the router agent's summary (up/down/partial/none)
 *  and the older sample data's connected/disconnected. Unknown values
 *  render as-is (the column is deliberately free text). */
const VPN_LABELS: Record<string, string> = {
  up: 'Up', down: 'Down', partial: 'Partial', none: 'None',
  connected: 'Connected', disconnected: 'Disconnected',
};

export function vpnLabel(status: string | null): string {
  if (status == null) return '—';
  return VPN_LABELS[status] ?? status;
}

export function vpnChipClass(status: string | null): string {
  if (status === 'up' || status === 'connected') return ' c-green';
  if (status === 'down' || status === 'disconnected') return ' c-red';
  if (status === 'partial') return ' c-amber';
  return '';
}
```

Add after `loginMethodLabel`:

```ts
export function approvalLabel(state: string | null | undefined): string {
  if (state === 'pending') return 'Pending';
  if (state === 'approved') return 'Approved';
  if (state === 'revoked') return 'Revoked';
  return '—';
}

/** Three missed 5-minute reports plus jitter. */
export const ROUTER_ONLINE_MS = 16 * 60 * 1000;

export function routerStatus(
  iso: string | null | undefined, now: Date = new Date(),
): 'online' | 'offline' | 'never' {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  return now.getTime() - t <= ROUTER_ONLINE_MS ? 'online' : 'offline';
}

export function routerStatusLabel(state: ReturnType<typeof routerStatus>): string {
  return state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'Never';
}

export interface RouterWifi {
  radio?: string; band?: string; ssid?: string; channel?: number | null;
  enabled?: boolean; clients?: number;
}

export interface RouterVpn {
  name?: string; type?: string; role?: string; enabled?: boolean; up?: boolean;
  endpoint?: string | null; last_handshake_seconds?: number | null;
}

function rawList<T>(d: DeviceItem, key: string): T[] {
  const v = (d.raw_info ?? {})[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

export const routerWifi = (d: DeviceItem): RouterWifi[] => rawList<RouterWifi>(d, 'wifi');
export const routerVpn = (d: DeviceItem): RouterVpn[] => rawList<RouterVpn>(d, 'vpn');

/** The agent's own count when it reported one, else the up-lease count. */
export function routerClientTotal(d: DeviceItem): number {
  const c = (d.raw_info ?? {}).clients as { total?: unknown } | null | undefined;
  return typeof c?.total === 'number' ? c.total : d.connected_count;
}

const BAND_LABELS: Record<string, string> = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };

export function bandLabel(band: string | null | undefined): string {
  if (!band) return '—';
  return BAND_LABELS[band] ?? band;
}

export const ROUTER_INSTALL_URL =
  'https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh';

export function routerInstallCommand(api: string): string {
  return `curl -fsSL ${ROUTER_INSTALL_URL} | sh -s -- --api ${api.replace(/\/+$/, '')}`;
}
```

In `deviceCellText`, replace the `case 'connected':` line, and add two
cases before `default`:

```ts
    case 'connected':
      return String(d.device_type === 'router' ? routerClientTotal(d) : d.connected_count);
```
```ts
    case 'approval':
      return approvalLabel(d.approval_state) + (d.secret_mismatch ? ' · Secret changed' : '');
    case 'status': return routerStatusLabel(routerStatus(d.last_seen_at));
```

In `deviceSortValue`, replace `case 'connected':` with
`case 'connected': return d.device_type === 'router' ? routerClientTotal(d) : d.connected_count;`.
Add `case 'status': return timeValue(d.last_seen_at);`.

`routerClientTotal`, `approvalLabel` and `routerStatus` are declared with
`const`/`function` lower in the file. Function declarations hoist. If
`routerClientTotal` stays a `const` arrow function, place it above
`deviceCellText` to avoid a temporal-dead-zone error. It is written above
as a `function`, so it hoists.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd portal && npx vitest run src/lib/devices.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/devices.ts portal/src/lib/devices.test.ts
git commit -m "feat(portal): router approval API client + approval/status/VPN/WiFi helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Router expansion: DHCP, WiFi and VPN tabs, plus the held-reports panel

**Files:**
- Create: `portal/src/components/hardware/RouterDetail.tsx`
- Modify: `portal/src/styles/hardware.css`
- Test: `portal/src/components/hardware/RouterDetail.test.tsx`

**Interfaces:**
- Consumes: `routerWifi`, `routerVpn`, `bandLabel`, `formatUptime` and
  `approvalLabel` (Task 5); `RouterLeases` (existing).
- Produces: `default export RouterDetail({ device }: { device: DeviceItem })`.

- [ ] **Step 1: Write the failing test**

Create `portal/src/components/hardware/RouterDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceItem } from '../../lib/api';

const api = vi.hoisted(() => ({ listDeviceLeases: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: RouterDetail } = await import('./RouterDetail');

const router = (over: Partial<DeviceItem> = {}): DeviceItem => ({
  id: 'r1', device_type: 'router', name: 'dock-router', serial: null, mac: '94:83:c4:aa:bb:cc',
  site_id: null, site_name: null, wan_ip: '203.0.113.7', lan_ip: '192.168.8.1',
  uptime_seconds: 100, last_seen_at: '2026-10-01T12:00:00Z',
  raw_info: {
    model: 'GL.iNet GL-MT3000', firmware: '4.5.0', hostname: 'GL-MT3000-1a2', agent_version: '1.0.0',
    wifi: [
      { radio: 'radio0', band: '2g', ssid: 'Site-WiFi', channel: 6, enabled: true, clients: 4 },
      { radio: 'radio0', band: '2g', ssid: 'Guest', channel: null, enabled: false, clients: 0 },
    ],
    vpn: [{ name: 'wgclient', type: 'wireguard', role: 'client', enabled: true, up: true,
            endpoint: '198.51.100.10:51820', last_handshake_seconds: 42 }],
  },
  registered_at: '2026-10-01T00:00:00Z', vpn_status: 'up', token_expires_at: null,
  connected_count: 0, model: 'GL.iNet GL-MT3000', antennas_connected: null, connection_type: null,
  scan_status: null, scan_status_label: null, scan_status_color: null, tags_read_24h: 0,
  version: '4.5.0', sub_type: null, current_initiative_id: null, current_initiative_name: null,
  session_person_id: null, session_person_name: null, session_login_method: null,
  session_started_at: null, setup_clear_requested_at: null, setup_clear_requested_by_name: null,
  approval_state: 'approved', secret_mismatch: false, agent_source_ip: '203.0.113.7',
  ...over,
});

beforeEach(() => { api.listDeviceLeases.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('approved router: DHCP tab first, then WiFi and VPN tables', async () => {
  const user = userEvent.setup();
  render(<RouterDetail device={router()} />);
  expect(screen.getByRole('button', { name: 'DHCP clients' }).getAttribute('aria-pressed')).toBe('true');
  expect(await screen.findByText('No active leases.')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'WiFi (2)' }));
  expect(screen.getByText('Site-WiFi')).toBeTruthy();
  expect(screen.getAllByText('2.4 GHz')).toHaveLength(2);
  expect(screen.getByText('Off')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'VPN (1)' }));
  expect(screen.getByText('wgclient')).toBeTruthy();
  expect(screen.getByText('198.51.100.10:51820')).toBeTruthy();
  expect(screen.getByText('Up')).toBeTruthy();
});

it('a held router shows identity only and says reports are held', () => {
  render(<RouterDetail device={router({ approval_state: 'pending', secret_mismatch: true })} />);
  expect(screen.getByText('Reports are held until this router is approved.')).toBeTruthy();
  expect(screen.getByText(/reported with a different secret/)).toBeTruthy();
  expect(screen.getByText('94:83:c4:aa:bb:cc')).toBeTruthy();
  expect(screen.getByText('GL-MT3000-1a2')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'DHCP clients' })).toBeNull();
  expect(api.listDeviceLeases).not.toHaveBeenCalled();
});

it('empty WiFi/VPN tabs say so', async () => {
  const user = userEvent.setup();
  render(<RouterDetail device={router({ raw_info: {} })} />);
  await user.click(screen.getByRole('button', { name: 'WiFi (0)' }));
  expect(screen.getByText('No WiFi reported yet.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'VPN (0)' }));
  expect(screen.getByText('No VPN tunnels configured.')).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd portal && npx vitest run src/components/hardware/RouterDetail.test.tsx`
Expected: FAIL. The module is not found.

- [ ] **Step 3: Implement**

Create `portal/src/components/hardware/RouterDetail.tsx`:

```tsx
/** Expansion panel for a router row. Approved routers: DHCP clients /
 *  WiFi / VPN behind an explicit switcher, each a real table (house
 *  detail-surface rules). A pending or revoked router's reports are held,
 *  so it shows only what identifies it — enough to decide on approval. */

import { useState } from 'react';

import DataTable from '../DataTable';
import type { DeviceItem } from '../../lib/api';
import {
  approvalLabel, bandLabel, formatUptime, routerVpn, routerWifi,
} from '../../lib/devices';
import RouterLeases from './RouterLeases';

type Tab = 'dhcp' | 'wifi' | 'vpn';

const dash = (v: unknown): string =>
  v == null || v === '' ? '—' : String(v);

function RouterIdentity({ device }: { device: DeviceItem }) {
  const info = device.raw_info ?? {};
  const rows: [string, string][] = [
    ['Approval', approvalLabel(device.approval_state)],
    ['WAN MAC', dash(device.mac)],
    ['Model', dash(info.model ?? device.model)],
    ['Firmware', dash(info.firmware ?? device.version)],
    ['Hostname', dash(info.hostname)],
    ['Agent version', dash(info.agent_version)],
    ['Reporting from', dash(device.agent_source_ip)],
    ['Last seen', device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'never'],
  ];
  return (
    <div>
      <p className="set-note" style={{ padding: 0 }}>Reports are held until this router is approved.</p>
      {device.secret_mismatch && (
        <p className="set-note router-warn" style={{ padding: 0 }}>
          This MAC reported with a different secret — the router was reset, reinstalled,
          or is being impersonated. Approving trusts the newest secret.
        </p>
      )}
      <DataTable
        ariaLabel="Router identity"
        columns={[
          { key: 'field', label: 'Field', width: '160px' },
          { key: 'value', label: 'Value', mono: true },
        ]}
        rows={rows.map(([field, value]) => ({ key: field, cells: [field, value] }))}
      />
    </div>
  );
}

export default function RouterDetail({ device }: { device: DeviceItem }) {
  const [tab, setTab] = useState<Tab>('dhcp');

  if (device.approval_state && device.approval_state !== 'approved') {
    return <RouterIdentity device={device} />;
  }

  const wifi = routerWifi(device);
  const vpn = routerVpn(device);

  return (
    <div>
      <div className="lease-tabs">
        <button type="button" className="lease-tab" aria-pressed={tab === 'dhcp'}
                onClick={() => setTab('dhcp')}>DHCP clients</button>
        <button type="button" className="lease-tab" aria-pressed={tab === 'wifi'}
                onClick={() => setTab('wifi')}>WiFi ({wifi.length})</button>
        <button type="button" className="lease-tab" aria-pressed={tab === 'vpn'}
                onClick={() => setTab('vpn')}>VPN ({vpn.length})</button>
      </div>

      {tab === 'dhcp' && <RouterLeases deviceId={device.id} />}

      {tab === 'wifi' && (wifi.length === 0 ? (
        <p className="set-note" style={{ padding: 0 }}>No WiFi reported yet.</p>
      ) : (
        <DataTable
          ariaLabel="WiFi networks"
          columns={[
            { key: 'ssid', label: 'SSID' },
            { key: 'band', label: 'Band', width: '90px' },
            { key: 'channel', label: 'Channel', width: '80px', mono: true },
            { key: 'radio', label: 'Radio', mono: true },
            { key: 'state', label: 'State', width: '70px' },
            { key: 'clients', label: 'Clients', width: '70px', align: 'center' },
          ]}
          rows={wifi.map((w, i) => ({
            key: `${w.radio ?? 'radio'}-${w.ssid ?? ''}-${i}`,
            cells: [
              dash(w.ssid), bandLabel(w.band), dash(w.channel), dash(w.radio),
              w.enabled === false ? 'Off' : 'On', dash(w.clients),
            ],
          }))}
        />
      ))}

      {tab === 'vpn' && (vpn.length === 0 ? (
        <p className="set-note" style={{ padding: 0 }}>No VPN tunnels configured.</p>
      ) : (
        <DataTable
          ariaLabel="VPN tunnels"
          columns={[
            { key: 'name', label: 'Name', mono: true },
            { key: 'type', label: 'Type', width: '100px' },
            { key: 'role', label: 'Role', width: '70px' },
            { key: 'state', label: 'State', width: '90px' },
            { key: 'endpoint', label: 'Endpoint', mono: true },
            { key: 'handshake', label: 'Last handshake', width: '120px', mono: true },
          ]}
          rows={vpn.map((t, i) => ({
            key: `${t.name ?? 'vpn'}-${i}`,
            cells: [
              dash(t.name), dash(t.type), dash(t.role),
              t.enabled === false
                ? <span className="chip">Disabled</span>
                : <span className={'chip' + (t.up ? ' c-green' : ' c-red')}>{t.up ? 'Up' : 'Down'}</span>,
              dash(t.endpoint),
              t.last_handshake_seconds == null ? '—' : `${formatUptime(t.last_handshake_seconds)} ago`,
            ],
          }))}
        />
      ))}
    </div>
  );
}
```

Check `portal/src/components/DataTable.tsx`'s props for `width`, `align`
and `mono` (used by `RouterLeases`) and for whether a cell accepts a
`ReactNode`. `RouterLeases` passes a `<span>`, so it does.

Append to `portal/src/styles/hardware.css`:

```css
/* Router expansion: the held-router warning line. Color only. */
.router-warn { color: var(--c-amber); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd portal && npx vitest run src/components/hardware/RouterDetail.test.tsx src/components/hardware/RouterLeases.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/hardware/RouterDetail.tsx portal/src/components/hardware/RouterDetail.test.tsx portal/src/styles/hardware.css
git commit -m "feat(portal): router expansion with DHCP/WiFi/VPN tabs and a held-reports identity panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The "How to add a router" modal

**Files:**
- Create: `portal/src/components/hardware/AddRouterModal.tsx`
- Modify: `portal/src/styles/hardware.css`
- Test: `portal/src/components/hardware/AddRouterModal.test.tsx`

**Interfaces:**
- Consumes: `routerInstallCommand` (Task 5) and `apiUrl()` (`lib/api.ts`).
- Produces: `default export AddRouterModal({ apiBase, onClose }: { apiBase: string; onClose: () => void })`.

- [ ] **Step 1: Write the failing test**

Create `portal/src/components/hardware/AddRouterModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import AddRouterModal from './AddRouterModal';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the header, steps and the install command for this API', () => {
  render(<AddRouterModal apiBase="https://api.example.com" onClose={vi.fn()} />);
  expect(screen.getByText('Scanning Hardware')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Add a router' })).toBeTruthy();
  expect(screen.getByText(/--api https:\/\/api\.example\.com$/)).toBeTruthy();
  expect(screen.queryByText(/isn.t HTTPS/)).toBeNull();
});

it('copies the command', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<AddRouterModal apiBase="https://api.example.com" onClose={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('install.sh | sh -s -- --api https://api.example.com'));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
});

it('warns when the API address is not HTTPS', () => {
  render(<AddRouterModal apiBase="http://localhost:8000" onClose={vi.fn()} />);
  expect(screen.getByText(/isn.t HTTPS/)).toBeTruthy();
});

it('closes from the footer button', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<AddRouterModal apiBase="https://api.example.com" onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd portal && npx vitest run src/components/hardware/AddRouterModal.test.tsx`
Expected: FAIL. The module is not found.

- [ ] **Step 3: Implement**

Create `portal/src/components/hardware/AddRouterModal.tsx`:

```tsx
/** "How to add a router": the one-line installer for a GL.iNet router,
 *  filled in with this deployment's API address. Routers register
 *  themselves; this modal only explains how and hands over the command.
 *  Report-generate header (eyebrow / title / description) per the house
 *  modal pattern. */

import { useState } from 'react';

import { routerInstallCommand } from '../../lib/devices';
import '../../styles/reports.css';

export default function AddRouterModal({ apiBase, onClose }: {
  apiBase: string; onClose: () => void;
}) {
  const command = routerInstallCommand(apiBase);
  const [copied, setCopied] = useState(false);
  const insecure = !/^https:\/\//i.test(apiBase);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card add-router-card" role="dialog"
           aria-label="Add a router">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Scanning Hardware</div>
            <h3>Add a router</h3>
            <p className="page-hint">
              GL.iNet routers (GL-AC2100, GL-MT3000) register themselves once the agent is installed.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <ol className="add-router-steps">
            <li>Sign in to the router over SSH as <code>root</code> (same password as its admin page).</li>
            <li>Paste this command and press Enter:</li>
          </ol>
          <div className="add-router-cmd">
            <code>{command}</code>
            <button type="button" className="mini-btn" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {insecure && (
            <p className="set-note router-warn" style={{ padding: 0 }}>
              This portal&apos;s API address isn&apos;t HTTPS, so the installer will refuse it.
              Use the deployment&apos;s public HTTPS API address instead.
            </p>
          )}
          <ol className="add-router-steps" start={3}>
            <li>
              The router appears here as <b>Pending</b> and everyone who manages scanning hardware
              gets an approval notification. Nothing it reports is stored until it&apos;s approved.
            </li>
            <li>
              Approve it from the notification or the row&apos;s Actions menu. Approval lasts until
              you revoke it; reinstalling the agent keeps the router&apos;s secret, so it stays approved.
            </li>
          </ol>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
```

Append to `portal/src/styles/hardware.css`:

```css
/* "Add a router" modal: sized to the one-line command, which wraps. */
.modal-card.reports-modal-card.rgm-card.add-router-card { width: min(760px, 96vw); max-width: 96vw; }
.add-router-steps { margin: 0 0 10px; padding-left: 20px; display: grid; gap: 6px; }
.add-router-cmd {
  display: flex; gap: 10px; align-items: flex-start;
  margin: 0 0 12px; padding: 10px 12px;
  border: 1px solid var(--paper-line); border-radius: 8px; background: var(--paper-2, var(--paper));
}
.add-router-cmd code { flex: 1; word-break: break-all; white-space: pre-wrap; }
```

The list-typography guardrail forbids font rules on list selectors, and
these rules contain none. Confirm that `var(--paper-line)` exists, as
`reports.css` uses it. If `--paper-2` is not a defined token, fall back to
`var(--paper)` alone.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd portal && npx vitest run src/components/hardware/AddRouterModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/hardware/AddRouterModal.tsx portal/src/components/hardware/AddRouterModal.test.tsx portal/src/styles/hardware.css
git commit -m "feat(portal): How to add a router modal with the one-line installer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Routers page: Approval and Status columns, row actions, `?focus=`, install button

**Files:**
- Modify: `portal/src/pages/Routers.tsx`
- Modify: `portal/src/pages/Routers.test.tsx`

**Interfaces:**
- Consumes:
  - From Task 5: `approveRouter`, `revokeRouter`, `approvalLabel`,
    `routerStatus`, `routerStatusLabel` and `vpnChipClass`.
  - `RouterDetail` (Task 6) and `AddRouterModal` (Task 7).
  - `RowActionsMenu` (existing).
  - `apiUrl` from `lib/api`.

- [ ] **Step 1: Update the existing tests and write the new ones**

In `portal/src/pages/Routers.test.tsx`:

1. Add `import { MemoryRouter } from 'react-router-dom';`.
2. Add a helper after the `Routers` import, then replace every
   `render(<Routers />)` with `renderRouters()`. Use `sed -i '' 's/render(<Routers \/>)/renderRouters()/g'`.

```tsx
function renderRouters(entry = '/hardware/routers') {
  return render(<MemoryRouter initialEntries={[entry]}><Routers /></MemoryRouter>);
}
```

3. Add `approveRouter: vi.fn()` and `revokeRouter: vi.fn()` to the hoisted
   `api` mock. In `beforeEach`, add:
   - `api.approveRouter.mockResolvedValue(DEVICES[0]);`
   - `api.revokeRouter.mockResolvedValue(DEVICES[0]);`
4. In `DEVICES`, give `d1` (dock-router-1) these fields:
   - `approval_state: 'approved'`, `secret_mismatch: false`,
     `agent_source_ip: '203.0.113.14'`, `model: 'GL.iNet GL-MT3000'`
   - Set `vpn_status` to `'up'`.

   Give `d2` (zebra-router-2) these fields:
   - `approval_state: 'pending'`, `secret_mismatch: true`,
     `agent_source_ip: '203.0.113.22'`
   - Set `vpn_status` to `'down'`.
5. In "renders seeded rows sorted by name…", delete the two serial
   assertions (`GL-MT300N-A1`, `GL-MT300N-Z2`). Serial is no longer a
   default column.
6. Delete the test "shows the Register router button, present but
   disabled".
7. Rewrite "hides Delete when can(...) is false" and "clicking Delete +
   confirm…" to open the row menu first. `RowActionsMenu` renders a
   button named `Actions ▾` and portals its items to `document.body`.

```tsx
it('hides the row Actions menu entirely without change/delete rights', async () => {
  auth.can = () => false;
  renderRouters();
  await screen.findByText('dock-router-1');
  expect(screen.queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('Delete from the row menu confirms, deletes and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(confirmSpy).toHaveBeenCalledWith('Delete "dock-router-1"? This cannot be undone.');
  await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  confirmSpy.mockRestore();
});
```

8. In "renders VPN chips and token-expiry chips per state", remove every
   token-expiry assertion and rename it "renders VPN chips per state".
   - Set its fixture `vpn_status` values to `'up'` and `'down'`.
   - Assert that an element with text `Up` has class `c-green` and that
     `Down` has class `c-red`.
   - Keep the shape the test already uses to find chips.
9. Append the new tests:

```tsx
it('shows Approval chips with the secret-changed badge, and Status', async () => {
  renderRouters();
  const approved = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  expect(within(approved).getByText('Approved').className).toContain('c-green');
  const pending = screen.getByText('zebra-router-2').closest('.dir-row') as HTMLElement;
  expect(within(pending).getByText('Pending').className).toContain('c-amber');
  expect(within(pending).getByText('Secret changed')).toBeTruthy();
  // both fixtures were last seen long ago
  expect(within(approved).getByText('Offline')).toBeTruthy();
});

it('Approve on a pending row confirms with MAC/model/IP and calls approveRouter', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('zebra-router-2')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.queryByRole('menuitem', { name: 'Revoke' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(confirmSpy.mock.calls[0][0]).toContain('94:83:C4:00:00:02');
  expect(confirmSpy.mock.calls[0][0]).toContain('203.0.113.22');
  await waitFor(() => expect(api.approveRouter).toHaveBeenCalledWith('d2'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  confirmSpy.mockRestore();
});

it('Revoke on an approved row', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.queryByRole('menuitem', { name: 'Approve' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
  await waitFor(() => expect(api.revokeRouter).toHaveBeenCalledWith('d1'));
  confirmSpy.mockRestore();
});

it('cancelling the confirm does nothing', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('zebra-router-2')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(api.approveRouter).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it('change rights without delete: Approve/Revoke but no Delete', async () => {
  auth.can = (_r, action) => action !== 'delete';
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
});

it('How to add a router opens the install modal', async () => {
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('dock-router-1');
  await user.click(screen.getByRole('button', { name: 'How to add a router' }));
  expect(screen.getByRole('heading', { name: 'Add a router' })).toBeTruthy();
});

it('?focus=<id> opens that row', async () => {
  renderRouters('/hardware/routers?focus=d2');
  expect(await screen.findByText('Reports are held until this router is approved.')).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd portal && npx vitest run src/pages/Routers.test.tsx`
Expected: the new and rewritten tests FAIL.

- [ ] **Step 3: Implement the page changes**

In `portal/src/pages/Routers.tsx`:

1. Replace the header doc comment's last paragraph with:

```ts
 *  Routers self-register through the GL.iNet agent (router_agent/) and
 *  stay Pending — reports held — until approved here or from the inbox.
 *  "How to add a router" shows the one-line installer. Row actions
 *  (Approve / Revoke / Delete) live behind the shared RowActionsMenu;
 *  ?focus=<id> (the approval notification's link) opens that row. */
```

2. Update the imports:

```ts
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, apiUrl, approveRouter, deleteDevice, listDevices, revokeRouter, type DeviceItem,
} from '../lib/api';
```
```ts
import {
  approvalLabel, deviceCellText, deviceSearchText, deviceSortValue, routerStatus,
  routerStatusLabel, vpnChipClass, vpnLabel,
} from '../lib/devices';
```
```ts
import AddRouterModal from '../components/hardware/AddRouterModal';
import RouterDetail from '../components/hardware/RouterDetail';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
```
Remove the `RouterLeases` and `tokenExpiryState` imports.

3. Replace `COLUMNS` and `CSV_COLUMNS`:

```ts
// Fit: default columns + trailing compute to well under LIST_FIT.page
// (1172px — measured 1174px in the browser at a 1512px window, nav expanded).
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.4fr', default: true, min: 140 },
  { key: 'approval', label: 'Approval', width: '1fr', default: true, min: 110 },
  { key: 'status', label: 'Status', width: '80px', default: true },
  { key: 'wan_ip', label: 'WAN IP', width: '1fr', default: true, min: 100 },
  { key: 'lan_ip', label: 'LAN IP', width: '1fr', default: true, min: 100 },
  { key: 'mac', label: 'MAC', width: '1fr', default: true, min: 116 },
  { key: 'vpn', label: 'VPN', width: '72px', default: true },
  { key: 'connected', label: 'Clients', width: '72px', default: true },
  { key: 'uptime', label: 'Uptime', width: '75px', default: true },
  { key: 'model', label: 'Model', width: '1fr', default: false, min: 110 },
  { key: 'serial', label: 'Serial', width: '1fr', default: false, min: 110 },
  { key: 'last_seen', label: 'Last seen', width: '1fr', default: false, min: 96 },
  { key: 'site', label: 'Site', width: '1fr', default: false },
];
```
```ts
const CSV_COLUMNS: [string, (d: DeviceItem) => string][] = [
  ['ID', (d) => d.id],
  ['Name', (d) => d.name],
  ['Approval', (d) => deviceCellText(d, 'approval')],
  ['Status', (d) => deviceCellText(d, 'status')],
  ['WAN IP', (d) => deviceCellText(d, 'wan_ip')],
  ['LAN IP', (d) => deviceCellText(d, 'lan_ip')],
  ['MAC', (d) => deviceCellText(d, 'mac')],
  ['VPN', (d) => deviceCellText(d, 'vpn')],
  ['Clients', (d) => deviceCellText(d, 'connected')],
  ['Uptime', (d) => deviceCellText(d, 'uptime')],
  ['Model', (d) => deviceCellText(d, 'model')],
  ['Serial', (d) => deviceCellText(d, 'serial')],
  ['Last seen', (d) => deviceCellText(d, 'last_seen')],
  ['Site', (d) => deviceCellText(d, 'site')],
  ['Reporting from', (d) => d.agent_source_ip ?? ''],
];
```

4. Change `msgFor` so it no longer assumes a delete:

```ts
const msgFor = (err: unknown, what: string): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : `Couldn't ${what} the router.`;
```

5. In the component, after `const canDelete = …`, add
   `const canChange = can('scanning_hardware', 'change');`. After the
   `openId` state, add:

```ts
  const [adding, setAdding] = useState(false);
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('focus');
```

   After `useEffect(() => { void load(); }, []);`, add:

```ts
  // The approval notification links here with ?focus=<id>: open that row
  // once the list has it, and bring it into view.
  useEffect(() => {
    if (!focusId || !devices?.some((d) => d.id === focusId)) return;
    setOpenId(focusId);
    document.querySelector(`[data-device-id="${CSS.escape(focusId)}"]`)
      ?.scrollIntoView?.({ block: 'center' });
  }, [focusId, devices]);
```

   jsdom has no `CSS.escape`. Guard it as
   `typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focusId) : focusId`.

6. Add the Approval facet. In `facetGroups`, collect
   `approvals.add(approvalLabel(d.approval_state))` and append
   `{ key: 'approval', title: 'Approval', options: … }` the same way as
   `vpn`. In `facetValues`, add
   `if (groupKey === 'approval') return [approvalLabel(d.approval_state)];`.

7. Replace `remove` with three actions:

```ts
  const act = async (fn: () => Promise<unknown>, what: string) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(msgFor(err, what));
    }
  };

  const remove = (d: DeviceItem) => {
    if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    void act(() => deleteDevice(d.id), 'delete');
  };

  const approve = (d: DeviceItem) => {
    if (!window.confirm(
      `Approve "${d.name}"? MAC ${d.mac ?? '—'} · ${d.model ?? 'unknown model'} · `
      + `reporting from ${d.agent_source_ip ?? 'an unknown address'}. `
      + 'Its reports are stored from its next check-in.',
    )) return;
    void act(() => approveRouter(d.id), 'approve');
  };

  const revoke = (d: DeviceItem) => {
    if (!window.confirm(
      `Revoke "${d.name}"? Its reports stop being stored right away; `
      + 'it shows as pending again the next time it checks in.',
    )) return;
    void act(() => revokeRouter(d.id), 'revoke');
  };

  const actionsFor = (d: DeviceItem) => {
    const agent = d.approval_state != null;
    return [
      ...(canChange && agent && d.approval_state !== 'approved'
        ? [{ key: 'approve', label: 'Approve', onSelect: () => approve(d) }] : []),
      ...(canChange && d.approval_state === 'approved'
        ? [{ key: 'revoke', label: 'Revoke', onSelect: () => revoke(d) }] : []),
      ...(canDelete
        ? [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => remove(d) }] : []),
    ];
  };
```

8. In `cellFor`, replace the `vpn` and `token_expires` cases with:

```tsx
      case 'vpn':
        return d.vpn_status == null
          ? <span>—</span>
          : <span className={'chip' + vpnChipClass(d.vpn_status)}>{vpnLabel(d.vpn_status)}</span>;
      case 'approval': {
        if (d.approval_state == null) return <span>—</span>;
        const tone = d.approval_state === 'approved' ? ' c-green'
          : d.approval_state === 'pending' ? ' c-amber' : '';
        return (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            <span className={'chip' + tone}>{approvalLabel(d.approval_state)}</span>
            {d.secret_mismatch && (
              <span className="chip c-red"
                    title="This MAC reported with a different secret — the router was reset, reinstalled, or is being impersonated.">
                Secret changed
              </span>
            )}
          </span>
        );
      }
      case 'status': {
        const state = routerStatus(d.last_seen_at);
        return (
          <span className={'chip' + (state === 'online' ? ' c-green' : '')}>
            {routerStatusLabel(state)}
          </span>
        );
      }
```

9. Replace the disabled "Register router" button with:

```tsx
          <button type="button" className="btn-solid" onClick={() => setAdding(true)}>
            How to add a router
          </button>
```

10. Change the empty-state copy to
    `No routers yet. Use “How to add a router” to install the agent on a GL.iNet router.`

11. In the row render:
    - Add `data-device-id={d.id}` to the `.dir-row` div.
    - Replace the Delete `mini-btn` cell content with
      `<RowActionsMenu actions={actionsFor(d)} />`. Keep the cell's flex
      style.
    - Replace `{open && <RouterLeases deviceId={d.id} />}` with
      `{open && <RouterDetail device={d} />}`.

12. Before the closing `</div>` of `.portal-page`, render:

```tsx
      {adding && <AddRouterModal apiBase={apiUrl()} onClose={() => setAdding(false)} />}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd portal && npx vitest run src/pages/Routers.test.tsx src/lib/devices.test.ts src/components/hardware`
Expected: PASS.

- [ ] **Step 5: Run the full portal suite and build**

Run: `cd portal && npx vitest run && npm run build` (foreground, 600000 ms timeout)
Expected: every test passes, including the list-typography and
column-floor guardrails, and the build succeeds. If a guardrail flags
`hardware.css`, move the offending property onto an allowlisted selector
as the guardrail message instructs. Never weaken a guardrail.

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/Routers.tsx portal/src/pages/Routers.test.tsx
git commit -m "feat(portal): Routers page — Approval/Status columns, Approve/Revoke/Delete actions, ?focus, How to add a router

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Inbox popover: approve or reject a router

**Files:**
- Modify: `portal/src/components/NotificationsPanel.tsx`
- Modify: `portal/src/components/NotificationsPanel.test.tsx`

**Interfaces:**
- Consumes: `approveRouter` and `revokeRouter` (Task 5). The notification
  payload is `{device_id, mac, state, decided_by?}` (Task 2/4).

- [ ] **Step 1: Write the failing tests**

In `portal/src/components/NotificationsPanel.test.tsx`, add
`approveRouter: vi.fn(() => Promise.resolve())` and
`revokeRouter: vi.fn(() => Promise.resolve())` to the hoisted `api`
object, then append:

```tsx
const routerItem = (id: string, payload: Record<string, unknown>): InboxItem => item(id, {
  kind: 'router_approval',
  title: 'Router waiting for approval',
  body: 'GL.iNet GL-MT3000 · GL-MT3000-1a2 · 94:83:c4:aa:bb:cc · from 203.0.113.7',
  link: '/hardware/routers?focus=r1',
  payload,
});

it('a pending router_approval row approves the router and refreshes without navigating', async () => {
  const user = userEvent.setup();
  ctx.items = [routerItem('n1', { device_id: 'r1', mac: '94:83:c4:aa:bb:cc', state: 'pending' })];
  const onClose = renderPanel();
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(api.approveRouter).toHaveBeenCalledWith('r1');
  expect(ctx.refresh).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('Reject on a router row revokes it (no note field)', async () => {
  const user = userEvent.setup();
  ctx.items = [routerItem('n1', { device_id: 'r1', mac: '94:83:c4:aa:bb:cc', state: 'pending' })];
  renderPanel();
  await user.click(screen.getByRole('button', { name: 'Reject' }));
  expect(api.revokeRouter).toHaveBeenCalledWith('r1');
  expect(screen.queryByPlaceholderText('Reason (optional)')).toBeNull();
});

it('a decided router row shows the outcome and no buttons', () => {
  ctx.items = [
    routerItem('n1', { device_id: 'r1', state: 'approved', decided_by: 'Ada' }),
    routerItem('n2', { device_id: 'r2', state: 'revoked', decided_by: 'Bo' }),
  ];
  renderPanel();
  expect(screen.getByText('Approved by Ada')).toBeTruthy();
  expect(screen.getByText('Rejected by Bo')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('a router decision error shows inline', async () => {
  const { ApiError } = await import('../lib/api');
  api.approveRouter.mockRejectedValueOnce(new ApiError(404, 'device_not_found'));
  const user = userEvent.setup();
  ctx.items = [routerItem('n1', { device_id: 'r1', state: 'pending' })];
  renderPanel();
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('That router was deleted.')).toBeTruthy();
});
```

Check the `ApiError` constructor signature in `portal/src/lib/api.ts`. It
may take `(status, code, …)` in a different order. Adjust the test's
construction to match.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd portal && npx vitest run src/components/NotificationsPanel.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

In `portal/src/components/NotificationsPanel.tsx`:

1. Extend the api import with `approveRouter, revokeRouter`.
2. Add, after `MembershipRequestStrip`:

```tsx
const ROUTER_ERRORS: Record<string, string> = {
  device_not_found: 'That router was deleted.',
  not_an_agent_router: 'That router no longer reports through the agent.',
  forbidden: "You can't approve routers.",
};

const routerErrorMsg = (err: unknown): string =>
  err instanceof ApiError ? (ROUTER_ERRORS[err.code] ?? `Request failed (${err.code}).`) : 'Network error — try again.';

interface RouterApprovalPayload {
  device_id: string;
  state: string;
  decided_by?: string | null;
}

/** The inline strip under a `router_approval` row: Approve / Reject while
 *  pending (Reject revokes — a router has no note to keep), otherwise the
 *  outcome. Stops propagation so the row click (which opens the Routers
 *  page focused on this router) never fires from inside it. */
function RouterApprovalStrip({ payload, refresh }: {
  payload: RouterApprovalPayload; refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (payload.state !== 'pending') {
    const who = payload.decided_by ?? '';
    const label = payload.state === 'approved' ? `Approved by ${who}` : `Rejected by ${who}`;
    return <span className="notif-body notif-outcome">{label}</span>;
  }

  const decide = async (fn: (id: string) => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn(payload.device_id);
      await refresh();
    } catch (err) {
      setError(routerErrorMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="notif-strip" onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Enter') e.stopPropagation(); }}>
      <button type="button" className="mini-btn sm" disabled={busy}
              onClick={() => void decide(approveRouter)}>
        Approve
      </button>
      <button type="button" className="mini-btn sm danger" disabled={busy}
              onClick={() => void decide(revokeRouter)}>
        Reject
      </button>
      {error && <span className="pf-error">{error}</span>}
    </span>
  );
}
```

3. In `KindIcon`, add before the fallback:

```tsx
  if (kind === 'router_approval') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 16.5h.01M11 16.5h.01" />
        <path d="M15 13V9M9 7.5a4.2 4.2 0 0 1 6 0M6.5 5a7.8 7.8 0 0 1 11 0" />
      </svg>
    );
  }
```

4. Below the `membership_request` strip render, add:

```tsx
                {n.kind === 'router_approval' && (
                  <RouterApprovalStrip payload={n.payload as unknown as RouterApprovalPayload} refresh={refresh} />
                )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd portal && npx vitest run src/components/NotificationsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/NotificationsPanel.tsx portal/src/components/NotificationsPanel.test.tsx
git commit -m "feat(portal): approve or reject a router from the inbox popover

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The router agent script and its fixture tests

**Files:**
- Create: `router_agent/basecamp-router.sh`
- Create: `router_agent/test/run.sh`, `router_agent/test/agent_test.sh`
- Create: `router_agent/test/stubs/{uci,ubus,iwinfo,ip,wg,logger}`, all
  executable
- Create the fixture trees `router_agent/test/fixtures/fw4-mt3000/` and
  `router_agent/test/fixtures/fw3-ac2100/`, listed below.

**Interfaces:**
- Produces: `basecamp-router {run|once|dry-run|mac}`. The `dry-run`
  command prints the report JSON with `"secret": "<hidden>"`, and `mac`
  prints the WAN MAC. The environment overrides are `BASECAMP_ROOT`
  (prefixes every file path) and `JSHN` (path to `jshn.sh`). The payload
  is the spec's `schema_version: 1` shape.

Docker image: OpenWrt 23.05 rootfs.
- On arm64 hosts (this Mac), use `openwrt/rootfs:armsr-armv8-23.05.5`.
- On amd64, use `openwrt/rootfs:x86-64-23.05.5`.
- If a tag doesn't exist, list the available ones with
  `curl -s 'https://hub.docker.com/v2/repositories/openwrt/rootfs/tags?page_size=100&name=23.05' | python3 -m json.tool | grep '"name"'`.
  Pin the newest 23.05 tag for the host arch in `run.sh`, and note it in
  the commit message.

- [ ] **Step 1: Write the stubs and the test runner**

`router_agent/test/run.sh`:
```sh
#!/bin/sh
# Runs the router agent tests inside an OpenWrt rootfs container (real
# BusyBox ash, uci, jsonfilter, jshn). Needs Docker.
#   router_agent/test/run.sh            agent + installer tests
#   router_agent/test/run.sh agent      agent only
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  arm64|aarch64) IMAGE="${OPENWRT_IMAGE:-openwrt/rootfs:armsr-armv8-23.05.5}" ;;
  *) IMAGE="${OPENWRT_IMAGE:-openwrt/rootfs:x86-64-23.05.5}" ;;
esac
suites="${1:-agent install}"
for s in $suites; do
  echo "== $s tests ($IMAGE)"
  docker run --rm -v "$HERE:/src:ro" "$IMAGE" /bin/sh "/src/test/${s}_test.sh"
done
```

`router_agent/test/stubs/uci` (real uci, fixture config dir):
```sh
#!/bin/sh
exec /sbin/uci -c "$FIXTURE/config" "$@"
```

`router_agent/test/stubs/ubus`:
```sh
#!/bin/sh
# ubus call <object> <method> -> fixtures/<fx>/ubus/<object>.<method>.json
[ "$1" = call ] || exit 1
f="$FIXTURE/ubus/$2.$3.json"
[ -r "$f" ] || exit 4
cat "$f"
```

`router_agent/test/stubs/iwinfo`:
```sh
#!/bin/sh
# iwinfo <ifname> <info|assoclist> -> fixtures/<fx>/iwinfo/<ifname>.<cmd>.txt
f="$FIXTURE/iwinfo/$1.$2.txt"
[ -r "$f" ] || exit 1
cat "$f"
```

`router_agent/test/stubs/ip`:
```sh
#!/bin/sh
[ "$1" = neigh ] || exit 1
cat "$FIXTURE/ip-neigh.txt"
```

`router_agent/test/stubs/wg`:
```sh
#!/bin/sh
# wg show <if> <latest-handshakes|endpoints>. Fixture handshakes hold an
# AGE in seconds (0 = never); turn it into the epoch wg would print.
f="$FIXTURE/wg/$2.$3.txt"
[ -r "$f" ] || exit 1
if [ "$3" = latest-handshakes ]; then
  now=$(date +%s)
  awk -v now="$now" '{ print $1 "\t" ($2 == 0 ? 0 : now - $2) }' "$f"
else
  cat "$f"
fi
```

`router_agent/test/stubs/logger`:
```sh
#!/bin/sh
exit 0
```

`router_agent/test/agent_test.sh`:
```sh
#!/bin/sh
# Agent fixture tests: run `basecamp-router dry-run` against each fixture
# router and check the JSON with jsonfilter. expect.tsv lines are
# <jsonfilter expression><TAB><expected value>.
FAIL=0
TAB=$(printf '\t')
mkdir -p /tmp/lock /tmp/run
for F in /src/test/fixtures/*/; do
  F=${F%/}; fx=${F##*/}
  OUT=$(FIXTURE="$F" BASECAMP_ROOT="$F/root" PATH="/src/test/stubs:$PATH" \
        sh /src/basecamp-router.sh dry-run 2>/tmp/err)
  if [ $? -ne 0 ]; then echo "FAIL $fx: dry-run exited non-zero: $(cat /tmp/err)"; FAIL=1; continue; fi
  echo "$OUT" | jsonfilter -e '@' >/dev/null 2>&1 || { echo "FAIL $fx: not JSON: $OUT"; FAIL=1; continue; }
  while IFS="$TAB" read -r expr want; do
    [ -n "$expr" ] || continue
    got=$(echo "$OUT" | jsonfilter -e "$expr" 2>/dev/null)
    if [ "$got" = "$want" ]; then echo "ok   $fx $expr"
    else echo "FAIL $fx $expr: want [$want] got [$got]"; FAIL=1; fi
  done < "$F/expect.tsv"
  FIXTURE="$F" BASECAMP_ROOT="$F/root" PATH="/src/test/stubs:$PATH" sh /src/basecamp-router.sh mac > /tmp/mac
  want_mac=$(awk -F"$TAB" '$1 == "@.wan_mac" { print $2 }' "$F/expect.tsv")
  [ "$(cat /tmp/mac)" = "$want_mac" ] && echo "ok   $fx mac" || { echo "FAIL $fx mac"; FAIL=1; }
done
[ "$FAIL" = 0 ] && echo "ALL AGENT TESTS PASSED"
exit $FAIL
```

- [ ] **Step 2: Write the fw4-mt3000 fixture (GL 4.x firmware, MT3000)**

Under `router_agent/test/fixtures/fw4-mt3000/`. Use **literal tabs** in
UCI files and in `expect.tsv`.

`config/network`:
```
config interface 'loopback'
	option device 'lo'
	option proto 'static'
	option ipaddr '127.0.0.1'
	option netmask '255.0.0.0'

config interface 'lan'
	option device 'br-lan'
	option proto 'static'
	option ipaddr '192.168.8.1'
	option netmask '255.255.255.0'

config interface 'wan'
	option device 'eth0'
	option proto 'dhcp'

config interface 'wgclient'
	option proto 'wgclient'
	option config 'peer_2001'

config interface 'wgserver'
	option proto 'wgserver'
	option disabled '1'
```

`config/wireless`:
```
config wifi-device 'mt798111'
	option type 'mac80211'
	option band '2g'
	option channel '6'

config wifi-device 'mt798112'
	option type 'mac80211'
	option band '5g'
	option channel '36'

config wifi-iface 'wifi2g'
	option device 'mt798111'
	option mode 'ap'
	option ssid 'Site-WiFi'

config wifi-iface 'wifi5g'
	option device 'mt798112'
	option mode 'ap'
	option ssid 'Site-WiFi-5G'

config wifi-iface 'guest2g'
	option device 'mt798111'
	option mode 'ap'
	option ssid 'Guest'
	option disabled '1'
```

`config/dhcp`:
```
config host
	option name 'kiosk-01'
	option mac 'AA:BB:CC:DD:EE:01'
	option ip '192.168.8.120'

config host
	option name 'printer'
	option mac 'aa:bb:cc:dd:ee:09'
	option ip '192.168.8.200'
```

`config/system`:
```
config system
	option hostname 'GL-MT3000-1a2'
```

`config/openvpn`: an empty file. `config/basecamp`:
```
config agent 'agent'
	option api_url 'https://api.example.test'
	option interval '300'
```

`root/sys/class/net/eth0/address`: `94:83:C4:AA:BB:CC`.
`root/proc/uptime`: `86400.55 170000.10`.
`root/tmp/sysinfo/model`: `GL.iNet GL-MT3000`.
`root/etc/glversion`: `4.5.0`.
`root/etc/basecamp/secret`: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`.

`root/tmp/dhcp.leases`:
```
1759400000 aa:bb:cc:dd:ee:01 192.168.8.120 kiosk-01 01:aa:bb:cc:dd:ee:01
1759400000 aa:bb:cc:dd:ee:02 192.168.8.121 * 01:aa:bb:cc:dd:ee:02
1759400000 aa:bb:cc:dd:ee:03 192.168.8.122 phone-3 *
```

`ip-neigh.txt`:
```
192.168.8.120 dev br-lan lladdr aa:bb:cc:dd:ee:01 REACHABLE
192.168.8.121 dev br-lan lladdr aa:bb:cc:dd:ee:02 STALE
192.168.8.122 dev br-lan lladdr aa:bb:cc:dd:ee:03 FAILED
203.0.113.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
```

`ubus/network.interface.wan.status.json`:
```json
{"up": true, "proto": "dhcp", "device": "eth0", "l3_device": "eth0",
 "ipv4-address": [{"address": "203.0.113.7", "mask": 24}],
 "route": [{"target": "0.0.0.0", "mask": 0, "nexthop": "203.0.113.1", "source": "203.0.113.7/32"}]}
```
`ubus/network.interface.lan.status.json`:
```json
{"up": true, "proto": "static", "device": "br-lan", "ipv4-address": [{"address": "192.168.8.1", "mask": 24}]}
```
`ubus/network.interface.wgclient.status.json`: `{"up": true, "proto": "wgclient", "device": "wgclient"}`
`ubus/network.interface.wgserver.status.json`: `{"up": false, "proto": "wgserver"}`
`ubus/network.wireless.status.json`:
```json
{"mt798111": {"up": true, "interfaces": [
   {"section": "wifi2g", "ifname": "phy0-ap0", "config": {"ssid": "Site-WiFi"}},
   {"section": "guest2g", "ifname": "phy0-ap1", "config": {"ssid": "Guest"}}]},
 "mt798112": {"up": true, "interfaces": [
   {"section": "wifi5g", "ifname": "phy1-ap0", "config": {"ssid": "Site-WiFi-5G"}}]}}
```

`iwinfo/phy0-ap0.info.txt`:
```
phy0-ap0  ESSID: "Site-WiFi"
          Access Point: 94:83:C4:AA:BB:CD
          Mode: Master  Channel: 6 (2.437 GHz)  HT Mode: HE20
```
`iwinfo/phy0-ap0.assoclist.txt`:
```
AA:BB:CC:DD:EE:02  -52 dBm / -95 dBm (SNR 43)  10 ms ago
	RX: 144.4 MBit/s, HE-MCS 7, 20MHz, HE-NSS 2         1234 Pkts.
	TX: 144.4 MBit/s, HE-MCS 7, 20MHz, HE-NSS 2          567 Pkts.
	expected throughput: 98.1 MBit/s

```
`iwinfo/phy1-ap0.info.txt`:
```
phy1-ap0  ESSID: "Site-WiFi-5G"
          Mode: Master  Channel: 44 (5.220 GHz)  HT Mode: HE80
```
`iwinfo/phy1-ap0.assoclist.txt`:
```
AA:BB:CC:DD:EE:04  -60 dBm / -95 dBm (SNR 35)  20 ms ago
	RX: 600.4 MBit/s, HE-MCS 9, 80MHz, HE-NSS 2         99 Pkts.
```

`wg/wgclient.latest-handshakes.txt`: `PUBKEYAAAA= 42`
`wg/wgclient.endpoints.txt`: `PUBKEYAAAA=	198.51.100.10:51820` (tab separated)

`expect.tsv` (tab separated):
```
@.schema_version	1
@.wan_mac	94:83:c4:aa:bb:cc
@.secret	<hidden>
@.model	GL.iNet GL-MT3000
@.firmware	4.5.0
@.hostname	GL-MT3000-1a2
@.uptime_seconds	86400
@.wan.interface	wan
@.wan.ip	203.0.113.7
@.wan.gateway	203.0.113.1
@.wan.up	true
@.lan.ip	192.168.8.1
@.lan.netmask	255.255.255.0
@.wifi[0].ssid	Site-WiFi
@.wifi[0].band	2g
@.wifi[0].channel	6
@.wifi[0].clients	1
@.wifi[1].ssid	Site-WiFi-5G
@.wifi[1].channel	44
@.wifi[1].clients	1
@.wifi[2].ssid	Guest
@.wifi[2].enabled	false
@.clients.wireless	2
@.clients.wired	1
@.clients.total	3
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:01"].reserved	true
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:01"].up	true
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:01"].hostname	kiosk-01
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:02"].up	true
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:02"].reserved	false
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:03"].up	false
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:09"].hostname	printer
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:09"].ip	192.168.8.200
@.dhcp_clients[@.mac="aa:bb:cc:dd:ee:09"].up	false
@.vpn[@.name="wgclient"].type	wireguard
@.vpn[@.name="wgclient"].role	client
@.vpn[@.name="wgclient"].up	true
@.vpn[@.name="wgclient"].endpoint	198.51.100.10:51820
@.vpn[@.name="wgserver"].role	server
@.vpn[@.name="wgserver"].enabled	false
@.vpn[@.name="wgserver"].up	false
```

- [ ] **Step 3: Write the fw3-ac2100 fixture (GL 3.x firmware, AC2100, repeater uplink)**

Under `router_agent/test/fixtures/fw3-ac2100/`:

`config/network`:
```
config interface 'lan'
	option ifname 'lan1 lan2'
	option type 'bridge'
	option proto 'static'
	option ipaddr '192.168.8.1'
	option netmask '255.255.255.0'

config interface 'wan'
	option ifname 'wan'
	option proto 'dhcp'

config interface 'wwan'
	option proto 'dhcp'

config interface 'wg0'
	option proto 'wireguard'
	option private_key 'x'
```

`config/wireless`:
```
config wifi-device 'mt7615e2'
	option hwmode '11g'
	option channel 'auto'

config wifi-device 'mt7615e5'
	option hwmode '11a'
	option channel '149'

config wifi-iface 'default_radio0'
	option device 'mt7615e2'
	option ifname 'ra0'
	option ssid 'Dock WiFi'

config wifi-iface 'default_radio1'
	option device 'mt7615e5'
	option ifname 'rai0'
	option ssid 'Dock WiFi 5G'
	option disabled '1'
```

`config/dhcp`: an empty file. `config/system`:
```
config system
	option hostname 'GL-AC2100'
```

`config/openvpn`:
```
config openvpn 'office'
	option enabled '1'
	option client '1'
	list remote 'vpn.office.example 1194'

config openvpn 'sample_server'
	option enabled '0'
	option server '10.8.0.0 255.255.255.0'
```

`config/basecamp`: the same as fw4.

`root/sys/class/net/wan/address`: `94:83:c4:11:22:33`.
`root/proc/uptime`: `3600.10 7000.00`.
`root/tmp/sysinfo/model`: `GL.iNet GL-AC2100`.
`root/etc/glversion`: `3.216`.
`root/etc/basecamp/secret`: the same 64 hex characters as fw4.
`root/var/run/openvpn.office.pid`: `1`.

`root/tmp/dhcp.leases`:
```
1759400000 aa:bb:cc:00:00:01 192.168.8.150 tablet 01:aa:bb:cc:00:00:01
1759400000 aa:bb:cc:00:00:02 192.168.8.151 laptop 01:aa:bb:cc:00:00:02
```

`ip-neigh.txt`:
```
192.168.8.150 dev br-lan lladdr aa:bb:cc:00:00:01 REACHABLE
192.168.8.151 dev br-lan lladdr aa:bb:cc:00:00:02 DELAY
```

`ubus/network.interface.wan.status.json`: `{"up": false, "proto": "dhcp", "device": "wan"}`
`ubus/network.interface.wwan.status.json`:
```json
{"up": true, "proto": "dhcp", "device": "apcli0", "l3_device": "apcli0",
 "ipv4-address": [{"address": "10.0.0.50", "mask": 24}],
 "route": [{"target": "0.0.0.0", "mask": 0, "nexthop": "10.0.0.1"}]}
```
`ubus/network.interface.lan.status.json`: `{"up": true, "proto": "static", "device": "br-lan", "ipv4-address": [{"address": "192.168.8.1", "mask": 24}]}`
`ubus/network.interface.wg0.status.json`: `{"up": true, "proto": "wireguard", "device": "wg0"}`

There is no `network.wireless.status.json` file, so the stub exits 4 and
the agent falls back to the uci `ifname`.

`iwinfo/ra0.info.txt`:
```
ra0       ESSID: "Dock WiFi"
          Mode: Master  Channel: 11 (2.462 GHz)
```
`iwinfo/ra0.assoclist.txt`:
```
AA:BB:CC:00:00:01  -48 dBm / -95 dBm (SNR 47)  0 ms ago
```

`wg/wg0.latest-handshakes.txt`: `PK= 600`
`wg/wg0.endpoints.txt`: `PK=	203.0.113.50:51820` (tab separated)

`expect.tsv`:
```
@.wan_mac	94:83:c4:11:22:33
@.model	GL.iNet GL-AC2100
@.firmware	3.216
@.hostname	GL-AC2100
@.uptime_seconds	3600
@.wan.interface	wwan
@.wan.ip	10.0.0.50
@.wan.gateway	10.0.0.1
@.lan.netmask	255.255.255.0
@.wifi[0].ssid	Dock WiFi
@.wifi[0].band	2g
@.wifi[0].channel	11
@.wifi[0].clients	1
@.wifi[1].band	5g
@.wifi[1].enabled	false
@.wifi[1].channel	149
@.clients.wireless	1
@.clients.wired	1
@.clients.total	2
@.vpn[@.name="wg0"].type	wireguard
@.vpn[@.name="wg0"].up	false
@.vpn[@.name="wg0"].endpoint	203.0.113.50:51820
@.vpn[@.name="office"].type	openvpn
@.vpn[@.name="office"].role	client
@.vpn[@.name="office"].up	true
@.vpn[@.name="office"].endpoint	vpn.office.example:1194
@.vpn[@.name="sample_server"].name	
```

The last line expects an empty value: disabled stock OpenVPN sections are
not reported.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `chmod +x router_agent/test/*.sh router_agent/test/stubs/* && router_agent/test/run.sh agent`
Expected: FAIL. `/src/basecamp-router.sh` doesn't exist.

- [ ] **Step 5: Write the agent**

Create `router_agent/basecamp-router.sh`:

```sh
#!/bin/sh
# BaseCamp router agent: sends this GL.iNet router's status to the
# BaseCamp API every few minutes. Send-only — the only thing it reads
# back is the HTTP status code. Nothing it sends is stored until the
# router is approved in the portal (Scanning Hardware › Routers).
#
#   basecamp-router run       report forever (the procd service runs this)
#   basecamp-router once      send one report now and print the result
#   basecamp-router dry-run   print the report (secret hidden), send nothing
#   basecamp-router mac       print the WAN MAC this router registers with
#
# Config: uci basecamp.agent.{api_url,interval,enabled}; secret in
# /etc/basecamp/secret. BASECAMP_ROOT prefixes every file path (tests).

AGENT_VERSION="1.0.0"
ROOT="${BASECAMP_ROOT:-}"
SECRET_FILE="$ROOT/etc/basecamp/secret"
MAX_DHCP=512
MAX_VPN=32
HANDSHAKE_FRESH=180
HEX='[0-9A-Fa-f][0-9A-Fa-f]'
MAC_RE="^$HEX:$HEX:$HEX:$HEX:$HEX:$HEX\$"
TMP="${TMPDIR:-/tmp}/basecamp.$$"

umask 077
. "${JSHN:-/usr/share/libubox/jshn.sh}"

log() { logger -t basecamp "$*"; }
cfg() { uci -q get "basecamp.agent.$1"; }
lower() { tr 'A-Z' 'a-z'; }
iface_status() { ubus call "network.interface.$1" status 2>/dev/null; }
jget() { jsonfilter -e "$1" 2>/dev/null | head -n 1; }  # stdin JSON

# prefix length -> dotted netmask
netmask() {
  bits=${1:-0}; mask=""; i=0
  while [ $i -lt 4 ]; do
    if [ "$bits" -ge 8 ]; then oct=255; bits=$((bits - 8))
    else oct=$((256 - (1 << (8 - bits)))); bits=0; fi
    mask="${mask:+$mask.}$oct"; i=$((i + 1))
  done
  echo "$mask"
}

str_or_null() {  # name value
  if [ -n "$2" ] && [ "$2" != "-" ]; then json_add_string "$1" "$2"; else json_add_null "$1"; fi
}

# The WAN port's own MAC — stable whichever uplink (cable, repeater,
# tethering) is active, so the router keeps one identity.
wan_mac() {
  dev=$(uci -q get network.wan.device || uci -q get network.wan.ifname)
  [ -n "$dev" ] || dev=$(iface_status wan | jget '@.device')
  set -- $dev
  [ -n "${1:-}" ] && [ -r "$ROOT/sys/class/net/$1/address" ] || return 1
  lower < "$ROOT/sys/class/net/$1/address"
}

model() {
  if [ -s "$ROOT/tmp/sysinfo/model" ]; then cat "$ROOT/tmp/sysinfo/model"
  else ubus call system board 2>/dev/null | jget '@.model'; fi
}

firmware() {
  if [ -s "$ROOT/etc/glversion" ]; then cat "$ROOT/etc/glversion"
  elif [ -r "$ROOT/etc/openwrt_release" ]; then
    (. "$ROOT/etc/openwrt_release"; echo "${DISTRIB_RELEASE:-}")
  fi
}

add_wan() {
  name=wan
  if [ "$(iface_status wan | jget '@.up')" != true ] \
     && [ "$(iface_status wwan | jget '@.up')" = true ]; then
    name=wwan
  fi
  s=$(iface_status "$name")
  if [ -z "$s" ]; then json_add_null wan; return; fi
  json_add_object wan
  json_add_string interface "$name"
  str_or_null ip "$(echo "$s" | jget '@["ipv4-address"][0].address')"
  str_or_null gateway "$(echo "$s" | jget '@.route[@.target="0.0.0.0"].nexthop')"
  str_or_null proto "$(echo "$s" | jget '@.proto')"
  if [ "$(echo "$s" | jget '@.up')" = true ]; then json_add_boolean up 1; else json_add_boolean up 0; fi
  json_close_object
}

add_lan() {
  s=$(iface_status lan)
  if [ -z "$s" ]; then json_add_null lan; return; fi
  json_add_object lan
  str_or_null ip "$(echo "$s" | jget '@["ipv4-address"][0].address')"
  bits=$(echo "$s" | jget '@["ipv4-address"][0].mask')
  if [ -n "$bits" ]; then json_add_string netmask "$(netmask "$bits")"; else json_add_null netmask; fi
  json_close_object
}

# One entry per wifi-iface (SSID). Station MACs go to $TMP.assoc for the
# wired/wireless split.
add_wifi() {
  : > "$TMP.assoc"
  status=$(ubus call network.wireless status 2>/dev/null)
  json_add_array wifi
  for s in $(uci -q show wireless | sed -n "s/^wireless\.\([^.=]*\)=wifi-iface$/\1/p"); do
    radio=$(uci -q get "wireless.$s.device")
    band=$(uci -q get "wireless.$radio.band")
    if [ -z "$band" ]; then
      case "$(uci -q get "wireless.$radio.hwmode")" in 11a|11ac|11ax_5g) band=5g ;; *) band=2g ;; esac
    fi
    enabled=1
    [ "$(uci -q get "wireless.$radio.disabled")" = 1 ] && enabled=0
    [ "$(uci -q get "wireless.$s.disabled")" = 1 ] && enabled=0
    ifname=$(echo "$status" | jget "@.$radio.interfaces[@.section='$s'].ifname")
    [ -n "$ifname" ] || ifname=$(uci -q get "wireless.$s.ifname")
    channel=""; clients=0
    if [ "$enabled" = 1 ] && [ -n "$ifname" ]; then
      channel=$(iwinfo "$ifname" info 2>/dev/null | sed -n 's/.*Channel: \([0-9][0-9]*\).*/\1/p' | head -n 1)
      iwinfo "$ifname" assoclist 2>/dev/null | awk -v re="$MAC_RE" '$1 ~ re { print tolower($1) }' > "$TMP.one"
      clients=$(wc -l < "$TMP.one" | tr -d ' ')
      cat "$TMP.one" >> "$TMP.assoc"
    fi
    if [ -z "$channel" ]; then
      channel=$(uci -q get "wireless.$radio.channel")
      case "$channel" in ''|*[!0-9]*) channel="" ;; esac
    fi
    json_add_object ""
    json_add_string radio "$radio"
    json_add_string band "$band"
    json_add_string ssid "$(uci -q get "wireless.$s.ssid")"
    if [ -n "$channel" ]; then json_add_int channel "$channel"; else json_add_null channel; fi
    json_add_boolean enabled "$enabled"
    json_add_int clients "$clients"
    json_close_object
  done
  json_close_array
}

# Leases + static reservations, merged per MAC; up = in the neighbor table.
add_dhcp() {
  : > "$TMP.raw"
  if [ -r "$ROOT/tmp/dhcp.leases" ]; then
    awk '{ h = ($4 == "*" ? "-" : $4); print "L", tolower($2), $3, h }' "$ROOT/tmp/dhcp.leases" >> "$TMP.raw"
  fi
  i=0
  while uci -q get "dhcp.@host[$i]" >/dev/null; do
    hip=$(uci -q get "dhcp.@host[$i].ip"); hname=$(uci -q get "dhcp.@host[$i].name")
    for m in $(uci -q get "dhcp.@host[$i].mac"); do
      echo "R $(echo "$m" | lower) ${hip:--} ${hname:--}" >> "$TMP.raw"
    done
    i=$((i + 1))
  done
  ip neigh show 2>/dev/null | awk '/lladdr/ && /REACHABLE|STALE|DELAY|PROBE|PERMANENT/ {
    for (i = 1; i < NF; i++) if ($i == "lladdr") print tolower($(i + 1)) }' > "$TMP.neigh"
  awk -v neigh="$TMP.neigh" '
    BEGIN { while ((getline m < neigh) > 0) up[m] = 1 }
    { mac = $2
      if (!(mac in seen)) { seen[mac] = 1; order[++n] = mac; ip[mac] = "-"; host[mac] = "-" }
      if ($1 == "R") { res[mac] = 1; if (ip[mac] == "-") ip[mac] = $3; if (host[mac] == "-") host[mac] = $4 }
      else { ip[mac] = $3; if ($4 != "-") host[mac] = $4 } }
    END { for (i = 1; i <= n; i++) { m = order[i]
            print m, ip[m], host[m], ((m in res) ? 1 : 0), ((m in up) ? 1 : 0) } }
  ' "$TMP.raw" | head -n "$MAX_DHCP" > "$TMP.dhcp"

  wired=0
  json_add_array dhcp_clients
  while read -r mac cip chost reserved isup; do
    json_add_object ""
    json_add_string mac "$mac"
    str_or_null ip "$cip"
    str_or_null hostname "$chost"
    json_add_boolean reserved "$reserved"
    json_add_boolean up "$isup"
    json_close_object
    if [ "$isup" = 1 ] && ! grep -qx "$mac" "$TMP.assoc"; then wired=$((wired + 1)); fi
  done < "$TMP.dhcp"
  json_close_array

  wireless=$(sort -u "$TMP.assoc" | grep -c .)
  json_add_object clients
  json_add_int total $((wired + wireless))
  json_add_int wired "$wired"
  json_add_int wireless "$wireless"
  json_close_object
}

add_tunnel() {  # name type role enabled up endpoint handshake_age
  [ "$VPN_COUNT" -lt "$MAX_VPN" ] || return 0
  json_add_object ""
  json_add_string name "$1"
  json_add_string type "$2"
  json_add_string role "$3"
  json_add_boolean enabled "$4"
  json_add_boolean up "$5"
  str_or_null endpoint "$6"
  if [ -n "$7" ]; then json_add_int last_handshake_seconds "$7"; else json_add_null last_handshake_seconds; fi
  json_close_object
  VPN_COUNT=$((VPN_COUNT + 1))
}

add_vpn() {
  VPN_COUNT=0
  now=$(date +%s)
  json_add_array vpn
  # WireGuard / OpenVPN as network interfaces: stock OpenWrt 'wireguard',
  # GL.iNet 4.x 'wgclient'/'wgserver'/'ovpnclient'/'ovpnserver'.
  uci -q show network | sed -nE \
    "s/^network\.([^.=]+)\.proto='?(wireguard|wgclient|wgserver|ovpnclient|ovpnserver)'?$/\1 \2/p" > "$TMP.vpnifs"
  while read -r s proto; do
    enabled=1; [ "$(uci -q get "network.$s.disabled")" = 1 ] && enabled=0
    case "$proto" in *server) role=server ;; *) role=client ;; esac
    case "$proto" in w*) type=wireguard ;; *) type=openvpn ;; esac
    ifup=$(iface_status "$s" | jget '@.up')
    up=0; endpoint=""; age=""
    if [ "$type" = wireguard ]; then
      latest=$(wg show "$s" latest-handshakes 2>/dev/null | awk 'BEGIN { m = 0 } $2 > m { m = $2 } END { print m }')
      if [ "${latest:-0}" -gt 0 ]; then
        age=$((now - latest))
        [ "$age" -le "$HANDSHAKE_FRESH" ] && up=1
      fi
      if [ "$role" = server ]; then
        # a server with no peer connected right now is still up
        [ "$ifup" = true ] && up=1
      else
        endpoint=$(wg show "$s" endpoints 2>/dev/null | awk '$2 != "(none)" { print $2; exit }')
      fi
    else
      [ "$ifup" = true ] && up=1
    fi
    [ "$enabled" = 1 ] || up=0
    add_tunnel "$s" "$type" "$role" "$enabled" "$up" "$endpoint" "$age"
  done < "$TMP.vpnifs"

  # Stock OpenVPN instances (/etc/config/openvpn). The package ships
  # disabled samples, so only enabled instances are reported.
  for s in $(uci -q show openvpn | sed -nE "s/^openvpn\.([^.=]+)=openvpn$/\1/p"); do
    [ "$(uci -q get "openvpn.$s.enabled")" = 1 ] || continue
    role=client
    if [ -n "$(uci -q get "openvpn.$s.server")" ] || [ "$(uci -q get "openvpn.$s.mode")" = server ]; then
      role=server
    fi
    up=0; pidf="$ROOT/var/run/openvpn.$s.pid"
    if [ -r "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then up=1; fi
    endpoint=""
    [ "$role" = client ] && endpoint=$(uci -q get "openvpn.$s.remote" | awk '{ print $1 ($2 ? ":" $2 : ""); exit }')
    add_tunnel "$s" openvpn "$role" 1 "$up" "$endpoint" ""
  done

  if command -v tailscale >/dev/null 2>&1; then
    up=0; tailscale status >/dev/null 2>&1 && up=1
    add_tunnel tailscale tailscale client 1 "$up" "" ""
  fi
  if command -v zerotier-cli >/dev/null 2>&1; then
    up=0; zerotier-cli info 2>/dev/null | grep -q ONLINE && up=1
    add_tunnel zerotier zerotier client 1 "$up" "" ""
  fi
  json_close_array
}

build_report() {
  mac=$(wan_mac) || { log "can't find the WAN MAC address"; return 1; }
  secret=$(cat "$SECRET_FILE" 2>/dev/null)
  case "$secret" in
    *[!0-9a-f]*|'') log "missing or damaged secret in $SECRET_FILE — reinstall the agent"; return 1 ;;
  esac
  [ ${#secret} -eq 64 ] || { log "damaged secret in $SECRET_FILE — reinstall the agent"; return 1; }
  json_init
  json_add_int schema_version 1
  json_add_string agent_version "$AGENT_VERSION"
  json_add_string wan_mac "$mac"
  json_add_string secret "$secret"
  str_or_null model "$(model)"
  str_or_null firmware "$(firmware)"
  str_or_null hostname "$(uci -q get system.@system[0].hostname || cat "$ROOT/proc/sys/kernel/hostname" 2>/dev/null)"
  json_add_int uptime_seconds "$(cut -d. -f1 "$ROOT/proc/uptime")"
  add_wan
  add_lan
  add_wifi
  add_dhcp
  add_vpn
  json_dump
}

send_report() {  # prints the HTTP status ("000" = no answer)
  api=$(cfg api_url)
  if [ -z "$api" ]; then log "api_url is not set (uci basecamp.agent.api_url)"; echo 000; return; fi
  build_report > "$TMP.json" || { echo 000; return; }
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H 'Content-Type: application/json' --data-binary "@$TMP.json" \
    "${api%/}/router-agent/report" 2>>"$TMP.err") || true
  rm -f "$TMP.json"
  [ -s "$TMP.err" ] && log "$(tail -n 1 "$TMP.err")"
  : > "$TMP.err"
  echo "${code:-000}"
}

describe() {
  case "$1" in
    200) echo "approved — reporting" ;;
    202) echo "registered — waiting for approval in the portal (Scanning Hardware › Routers)" ;;
    429) echo "rate limited — will retry" ;;
    000) echo "could not reach the API" ;;
    *) echo "the API answered HTTP $1" ;;
  esac
}

jitter() { awk -v max="$1" 'BEGIN { srand(); print int(rand() * (max + 1)) }'; }

run_loop() {
  # let the WAN come up after a boot, and stay clear of the installer's report
  sleep $((30 + $(jitter 30)))
  while :; do
    interval=$(cfg interval)
    case "$interval" in ''|*[!0-9]*) interval=300 ;; esac
    [ "$interval" -ge 60 ] || interval=60
    code=$(send_report)
    case "$code" in 200|202) ;; *) log "report not accepted: $(describe "$code")" ;; esac
    extra=0; [ "$code" = 429 ] && extra=$interval
    sleep $((interval + extra + $(jitter 30)))
  done
}

trap 'rm -f "$TMP".*' EXIT
trap 'exit 0' INT TERM

case "${1:-}" in
  run) run_loop ;;
  once)
    code=$(send_report)
    echo "BaseCamp: $(describe "$code")"
    [ "$code" = 200 ] || [ "$code" = 202 ]
    ;;
  dry-run) build_report | sed 's/"secret": *"[0-9a-f]*"/"secret": "<hidden>"/' ;;
  mac) wan_mac ;;
  *) echo "usage: basecamp-router run|once|dry-run|mac" >&2; exit 2 ;;
esac
```

Notes for the implementer:
- `json_add_null` and `json_add_boolean` exist in OpenWrt's `jshn.sh`.
  Verify with `grep -n 'json_add_null\|json_add_boolean' /usr/share/libubox/jshn.sh`
  inside the container. If `json_add_null` is missing in that release,
  define it as `json_add_null() { _json_add_generic null "$1" "" "$JSON_CUR"; }`,
  matching the generic helper's signature in that file.
- `dry-run` exit status: `build_report | sed` returns sed's status. Make
  `dry-run` fail when `build_report` fails:
  `build_report > "$TMP.dry" && sed … "$TMP.dry"`.
- Jsonfilter's expression grammar is the OpenWrt one. If
  `@.route[@.target="0.0.0.0"].nexthop` or
  `@.$radio.interfaces[@.section='$s'].ifname` is rejected, use the
  quoting form jsonfilter accepts in that release. The fixture test will
  show which one works.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `router_agent/test/run.sh agent` (foreground, 600000 ms timeout; the first image pull is slow)
Expected: every line is `ok`, ending with `ALL AGENT TESTS PASSED`. Fix
the agent rather than the expectations. Change an expectation only when it
contradicts the spec's payload definition, and say so in the commit
message.

- [ ] **Step 7: Commit**

```bash
chmod +x router_agent/basecamp-router.sh
git add router_agent/basecamp-router.sh router_agent/test
git commit -m "feat(router-agent): BusyBox agent for GL.iNet routers — WAN/LAN, WiFi, DHCP clients, VPN tunnels; OpenWrt-container fixture tests (fw3 AC2100, fw4 MT3000)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Installer, procd service and README

**Files:**
- Create: `router_agent/install.sh`
- Create: `router_agent/basecamp-router.init`
- Create: `router_agent/README.md`
- Create: `router_agent/test/install_test.sh`
- Create: `router_agent/test/install-stubs/{curl,ubus,logger}`, all
  executable

**Interfaces:**
- Consumes: `basecamp-router once` and `basecamp-router mac` (Task 10).
- Produces: `install.sh` with the flags `--api URL`, `--interval SECONDS`,
  `--ref REF`, `--source BASEURL`, `--uninstall` and `--keep-secret`.

- [ ] **Step 1: Write the stubs and the failing test**

`router_agent/test/install-stubs/curl`:
```sh
#!/bin/sh
# Test stand-in for curl: `curl -fsSL file:///path -o out` copies the
# file; anything else (the agent's report POST) fails like an
# unreachable API and prints 000.
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    file://*|http://*|https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  file://*)
    p=${url#file://}
    [ -r "$p" ] || exit 22
    if [ -n "$out" ]; then cat "$p" > "$out"; else cat "$p"; fi ;;
  *) printf 000; exit 7 ;;
esac
```

`router_agent/test/install-stubs/ubus`: `#!/bin/sh` followed by `exit 4`.
`router_agent/test/install-stubs/logger`: `#!/bin/sh` followed by `exit 0`.

`router_agent/test/install_test.sh`:
```sh
#!/bin/sh
# install.sh in a real OpenWrt rootfs: files, UCI config, secret, sysupgrade
# keep-list, rc.d link; re-install keeps the secret; uninstall cleans up.
FAIL=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAIL=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
mkdir -p /tmp/lock /tmp/run
touch /etc/sysupgrade.conf
export PATH="/src/test/install-stubs:$PATH"
SRC=file:///src
INSTALL="sh /src/install.sh --source $SRC"

$INSTALL --api http://api.example.test >/tmp/out 2>&1
check "refuses a plain-http API" '[ $? -ne 0 ] && [ ! -e /usr/bin/basecamp-router ]'
$INSTALL >/tmp/out 2>&1
check "requires --api on a first install" '[ $? -ne 0 ]'

$INSTALL --api https://api.example.test/ >/tmp/out 2>&1
rc=$?
check "installs (exit 0 even though the first report can't reach the API)" '[ $rc -eq 0 ]'
check "agent installed and executable" '[ -x /usr/bin/basecamp-router ]'
check "service installed" '[ -x /etc/init.d/basecamp-router ]'
check "service enabled at boot" '[ -e /etc/rc.d/S99basecamp-router ]'
check "api_url saved without trailing slash" '[ "$(uci -q get basecamp.agent.api_url)" = https://api.example.test ]'
check "interval defaults to 300" '[ "$(uci -q get basecamp.agent.interval)" = 300 ]'
check "secret is 64 hex chars" 'grep -qE "^[0-9a-f]{64}$" /etc/basecamp/secret'
check "secret is owner-only" '[ "$(ls -l /etc/basecamp/secret | cut -c1-10)" = "-rw-------" ]'
for f in /etc/basecamp/ /etc/config/basecamp /usr/bin/basecamp-router /etc/init.d/basecamp-router; do
  check "sysupgrade keeps $f" 'grep -qxF "$f" /etc/sysupgrade.conf'
done
check "tells the user it is waiting on the portal" 'grep -q "Scanning Hardware" /tmp/out'
first=$(cat /etc/basecamp/secret)

$INSTALL --api https://api2.example.test --interval 600 >/tmp/out 2>&1
check "re-install keeps the secret" '[ "$(cat /etc/basecamp/secret)" = "$first" ]'
check "re-install updates api_url" '[ "$(uci -q get basecamp.agent.api_url)" = https://api2.example.test ]'
check "re-install sets the interval" '[ "$(uci -q get basecamp.agent.interval)" = 600 ]'
check "no duplicate keep-list lines" '[ "$(grep -cxF /etc/basecamp/ /etc/sysupgrade.conf)" = 1 ]'
$INSTALL --interval 30 >/tmp/out 2>&1
check "refuses an interval under 60s" '[ $? -ne 0 ]'

$INSTALL --uninstall --keep-secret >/tmp/out 2>&1
check "uninstall --keep-secret keeps the secret" '[ "$(cat /etc/basecamp/secret)" = "$first" ]'
check "uninstall removes the agent" '[ ! -e /usr/bin/basecamp-router ] && [ ! -e /etc/init.d/basecamp-router ]'
check "uninstall removes the rc.d link" '[ ! -e /etc/rc.d/S99basecamp-router ]'
check "uninstall removes the config" '[ ! -e /etc/config/basecamp ]'

$INSTALL --api https://api.example.test >/tmp/out 2>&1
check "install after --keep-secret reuses it" '[ "$(cat /etc/basecamp/secret)" = "$first" ]'
$INSTALL --uninstall >/tmp/out 2>&1
check "full uninstall removes the secret" '[ ! -e /etc/basecamp ]'
check "full uninstall cleans the keep-list" '! grep -q basecamp /etc/sysupgrade.conf'

[ "$FAIL" = 0 ] && echo "ALL INSTALL TESTS PASSED"
exit $FAIL
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `chmod +x router_agent/test/install_test.sh router_agent/test/install-stubs/* && router_agent/test/run.sh install`
Expected: FAIL. `install.sh` doesn't exist.

- [ ] **Step 3: Write the procd service**

`router_agent/basecamp-router.init`:
```sh
#!/bin/sh /etc/rc.common
# BaseCamp router agent: reports this router's status to BaseCamp.
# Installed by router_agent/install.sh. Logs: logread -e basecamp

START=99
STOP=10
USE_PROCD=1

start_service() {
	[ "$(uci -q get basecamp.agent.enabled)" = 0 ] && return 0
	procd_open_instance
	procd_set_param command /usr/bin/basecamp-router run
	procd_set_param respawn 3600 5 0
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance
}
```

- [ ] **Step 4: Write the installer**

`router_agent/install.sh`:
```sh
#!/bin/sh
# BaseCamp router agent installer for GL.iNet (OpenWrt) routers.
# Run on the router over SSH:
#   curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --api https://<api-host>
#
#   --api URL            BaseCamp API address (https:// only; kept on re-install)
#   --interval SECONDS   report interval, 60 or more (default 300)
#   --ref REF            git branch or tag to install from (default main)
#   --source BASEURL     install from another location (testing)
#   --uninstall          remove the agent (add --keep-secret to keep its identity)
set -u

REF=main
SOURCE=""
API=""
INTERVAL=""
UNINSTALL=0
KEEP_SECRET=0
BIN=/usr/bin/basecamp-router
INIT=/etc/init.d/basecamp-router
SECRET_DIR=/etc/basecamp
SECRET=$SECRET_DIR/secret
KEEP_FILES="/etc/basecamp/ /etc/config/basecamp $BIN $INIT"

say() { echo "basecamp: $*"; }
die() { echo "basecamp: error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --api) API=${2:-}; shift ;;
    --interval) INTERVAL=${2:-}; shift ;;
    --ref) REF=${2:-}; shift ;;
    --source) SOURCE=${2:-}; shift ;;
    --uninstall) UNINSTALL=1 ;;
    --keep-secret) KEEP_SECRET=1 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[ -n "$SOURCE" ] || SOURCE="https://raw.githubusercontent.com/encondata/BaseCampV3/$REF/router_agent"
SOURCE=${SOURCE%/}

[ -f /etc/openwrt_release ] || die "this doesn't look like an OpenWrt / GL.iNet router"
[ -w /etc ] || die "run this as root"

drop_keep_lines() {
  [ -f /etc/sysupgrade.conf ] || return 0
  for f in $KEEP_FILES; do
    [ "$KEEP_SECRET" = 1 ] && [ "$f" = /etc/basecamp/ ] && continue
    grep -vxF "$f" /etc/sysupgrade.conf > /tmp/sysupgrade.conf.$$ || true
    cat /tmp/sysupgrade.conf.$$ > /etc/sysupgrade.conf
  done
  rm -f /tmp/sysupgrade.conf.$$
}

if [ "$UNINSTALL" = 1 ]; then
  if [ -x "$INIT" ]; then
    "$INIT" stop >/dev/null 2>&1
    "$INIT" disable >/dev/null 2>&1
  fi
  rm -f "$BIN" "$INIT" /etc/config/basecamp
  if [ "$KEEP_SECRET" = 1 ]; then say "kept $SECRET"; else rm -rf "$SECRET_DIR"; fi
  drop_keep_lines
  say "uninstalled"
  exit 0
fi

command -v curl >/dev/null 2>&1 || die "curl is required: opkg update && opkg install curl"

[ -n "$API" ] || API=$(uci -q get basecamp.agent.api_url)
case "$API" in
  https://?*) ;;
  '') die "--api https://<api-host> is required" ;;
  *) die "the API address must start with https:// (got $API)" ;;
esac
API=${API%/}
if [ -n "$INTERVAL" ]; then
  case "$INTERVAL" in *[!0-9]*) die "--interval must be a number of seconds" ;; esac
  [ "$INTERVAL" -ge 60 ] || die "--interval must be at least 60 seconds"
fi

fetch() {  # url dest
  curl -fsSL "$1" -o "$2.new" || { rm -f "$2.new"; die "couldn't download $1"; }
  [ -s "$2.new" ] || { rm -f "$2.new"; die "downloaded an empty file from $1"; }
  chmod 755 "$2.new" && mv "$2.new" "$2"
}
say "downloading the agent from $SOURCE"
fetch "$SOURCE/basecamp-router.sh" "$BIN"
fetch "$SOURCE/basecamp-router.init" "$INIT"

[ -f /etc/config/basecamp ] || : > /etc/config/basecamp
uci -q get basecamp.agent >/dev/null || uci set basecamp.agent=agent
uci set basecamp.agent.api_url="$API"
if [ -n "$INTERVAL" ]; then
  uci set basecamp.agent.interval="$INTERVAL"
elif [ -z "$(uci -q get basecamp.agent.interval)" ]; then
  uci set basecamp.agent.interval=300
fi
uci set basecamp.agent.enabled=1
uci commit basecamp

# The secret is this router's identity together with its WAN MAC: made
# once, kept across re-installs and firmware upgrades, never sent
# anywhere but the BaseCamp API.
umask 077
mkdir -p "$SECRET_DIR" && chmod 700 "$SECRET_DIR"
if ! grep -qE '^[0-9a-f]{64}$' "$SECRET" 2>/dev/null; then
  hexdump -v -n 32 -e '/1 "%02x"' /dev/urandom > "$SECRET.new" 2>/dev/null \
    || head -c 32 /dev/urandom | od -An -tx1 -v | tr -d ' \n' > "$SECRET.new"
  grep -qE '^[0-9a-f]{64}$' "$SECRET.new" || { rm -f "$SECRET.new"; die "couldn't generate a secret"; }
  chmod 600 "$SECRET.new" && mv "$SECRET.new" "$SECRET"
  say "generated this router's secret"
fi
umask 022

touch /etc/sysupgrade.conf
for f in $KEEP_FILES; do
  grep -qxF "$f" /etc/sysupgrade.conf || echo "$f" >> /etc/sysupgrade.conf
done

"$INIT" stop >/dev/null 2>&1
say "sending a first report to $API"
"$BIN" once || say "the first report didn't go through; the service keeps retrying (logread -e basecamp)"
"$INIT" enable || say "warning: couldn't enable the service at boot"
"$INIT" start >/dev/null 2>&1 || say "warning: couldn't start the service; run $INIT start"

say "installed. This router registers with WAN MAC $("$BIN" mac 2>/dev/null || echo unknown)."
say "Approve it in the portal: Scanning Hardware › Routers (or from the approval notification)."
```

`basecamp-router once` exits non-zero when the API can't be reached. That
is deliberately not fatal, which is why the call is guarded with `||`.

- [ ] **Step 5: Write the README**

`router_agent/README.md`, with these sections and exact content:

```markdown
# BaseCamp router agent (GL.iNet)

Sends a GL.iNet router's status to BaseCamp every 5 minutes: WAN and LAN
IPs, uptime, WiFi networks, DHCP clients, connected-client counts, and
VPN tunnels. Tested against GL-AC2100 (firmware 3.x) and GL-MT3000
(firmware 4.x) layouts. Send-only: the router never takes commands from
BaseCamp.

## Install

SSH into the router as `root` (same password as its admin page) and run:

    curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --api https://<api-host>

The router registers with its WAN MAC address and shows up in the portal
under **Scanning Hardware › Routers** as **Pending**. Everyone who manages
scanning hardware gets an approval notification. Nothing the router sends
is stored until someone approves it; approval lasts until it's revoked.

Options: `--interval SECONDS` (60 or more, default 300), `--ref BRANCH`
(install from a branch or tag instead of `main`).

## Identity

On install the router generates a random secret (`/etc/basecamp/secret`)
and sends it with every report. Approval pins that MAC + secret pair, so
another device can't report as this router just by copying its MAC.
Re-running the installer keeps the secret; so do firmware upgrades (the
installer adds the agent to `/etc/sysupgrade.conf`). A factory reset
creates a new secret: the router shows as **Pending** with a "Secret
changed" badge and needs approving again.

## Troubleshooting

    basecamp-router once       # send a report now and show the result
    basecamp-router dry-run    # show what would be sent (secret hidden)
    basecamp-router mac        # the WAN MAC it registers with
    logread -e basecamp        # the service's log

## Uninstall

    curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --uninstall

Add `--keep-secret` to keep the router's identity for a later reinstall.
Revoke or delete the router in the portal as well.

## Development

`router_agent/test/run.sh` runs the agent and installer tests in an
OpenWrt rootfs container (needs Docker). Fixtures under
`test/fixtures/` are canned `uci`/`ubus`/`iwinfo`/`wg` output; replace
them with captures from a real router when formats differ.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `chmod +x router_agent/install.sh router_agent/basecamp-router.init && router_agent/test/run.sh` (both suites, foreground, 600000 ms timeout)
Expected: `ALL AGENT TESTS PASSED` and `ALL INSTALL TESTS PASSED`.

If `/etc/init.d/basecamp-router enable` fails in the container because
`rc.common` needs a missing piece, check for the `/etc/rc.d/S99…`
symlink. If it was created, the test is right and the warning is
harmless. Otherwise, fix the init script; do not weaken the check.

- [ ] **Step 7: Commit**

```bash
git add router_agent/install.sh router_agent/basecamp-router.init router_agent/README.md router_agent/test/install_test.sh router_agent/test/install-stubs
git commit -m "feat(router-agent): one-line installer/uninstaller, procd service, README; installer tests in an OpenWrt container

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Live end-to-end verification against the dev stack

The controller runs this task. It is not handed to an implementer, because
it needs the browser pane and the running dev servers.

**Files:** none, unless verification finds a bug. Any fix goes through the
task that owns the file and gets its own test.

- [ ] **Step 1: Migrate the dev DB and start the stack**

- Re-check that 0087 is still free on the dev DB.
- Run `alembic upgrade head` against the dev DB using the worktree's
  migrations: `cd api && .venv/bin/alembic upgrade head`, with the
  worktree `.env` symlinked to the main checkout's.
- Start the API on port 8001 and the portal on port 5175 from this
  worktree, following the user-detail live-verify recipe. Use detached
  `nohup` processes if they must outlive the turn.

- [ ] **Step 2: Simulate a router from the fixture**

Build a report from the fw4 fixture inside the container, restore the
fixture's real secret in place of `<hidden>`, and POST it to the dev API
from the host:

```bash
docker run --rm -v "$PWD/router_agent:/src:ro" -e FIXTURE=/src/test/fixtures/fw4-mt3000 \
  -e BASECAMP_ROOT=/src/test/fixtures/fw4-mt3000/root openwrt/rootfs:armsr-armv8-23.05.5 \
  sh -c 'PATH=/src/test/stubs:$PATH sh /src/basecamp-router.sh dry-run' \
  | sed "s/<hidden>/$(cat router_agent/test/fixtures/fw4-mt3000/root/etc/basecamp/secret)/" > "$TMPDIR/report.json"
curl -s -w ' %{http_code}\n' -H 'Content-Type: application/json' --data-binary @"$TMPDIR/report.json" http://localhost:8001/router-agent/report
```
Expected: `{"state":"pending"} 202`.

- [ ] **Step 3: Verify in the browser**

Sign in as `claude-dev@test.example.com`, which has the admin role.
1. The bell shows "Router waiting for approval".
2. `/hardware/routers` lists GL-MT3000-1a2 with a **Pending** chip.
3. The expansion shows the identity panel and the held-reports line.
4. Approve from the popover. The popover row changes to "Approved by …".
5. Push `last_seen_at` back:
   `UPDATE devices SET last_seen_at = now() - interval '1 minute' WHERE mac = '94:83:c4:aa:bb:cc'`.
   Re-POST the report and expect `{"state":"approved"} 200`.
6. Reload. The row shows WAN 203.0.113.7, LAN 192.168.8.1, VPN Up,
   Clients 3, Uptime 1d 0h and Status Online.
7. The DHCP, WiFi and VPN tabs render the fixture's data.
8. "How to add a router" shows the command.
9. Change one hex digit of the secret in `report.json`, age the row, and
   POST again. The row goes back to **Pending** with the **Secret changed**
   badge.
10. Revoke, then re-POST. The row shows Pending with no new notification.
11. Take a screenshot of the final list and the expansion for the user.

- [ ] **Step 4: Clean up**

- Delete the test router row from the dev DB (with an audit-friendly
  `DELETE` via the portal's Delete action).
- Stop the servers you started.
- Never commit `_dev_reload.py`.

- [ ] **Step 5: Record the hardware gap**

Real GL-AC2100 and GL-MT3000 hardware is unverified until Jimmy runs the
install command on a router after the branch is pushed. Before the merge,
`--ref router-agent` works only once the branch is on GitHub, and pushing
needs his go-ahead. Say this in the final report.
