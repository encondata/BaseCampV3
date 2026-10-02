"""POST /router-agent/report — GL.iNet router self-registration, approval
gating, secret pinning, snapshot + lease sync. Spec:
docs/superpowers/specs/2026-10-01-router-agent-design.md."""

import hashlib

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Device, Notification
from serversherpa.services.router_agent import vpn_summary

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


async def test_a_matching_report_clears_the_candidate_but_keeps_the_mismatch_flag(client, db):
    await client.post("/router-agent/report", json=report())
    await _age(db)
    await client.post("/router-agent/report", json=report(secret=OTHER_SECRET))
    d = await _router(db)
    await db.refresh(d)
    assert d.pending_secret_hash and d.secret_mismatch is True
    await _age(db)
    await client.post("/router-agent/report", json=report())
    await db.refresh(d)
    # the flag means "a different secret was seen since the last admin decision"
    assert d.pending_secret_hash is None and d.secret_mismatch is True
    assert d.approval_state == "pending"


async def test_forged_then_genuine_report_on_an_approved_router_stays_flagged(client, db):
    await client.post("/router-agent/report", json=report())
    await db.execute(text("UPDATE devices SET approval_state = 'approved' WHERE mac = :m"),
                     {"m": MAC})
    await db.commit()
    await _age(db)
    await client.post("/router-agent/report", json=report(secret=OTHER_SECRET, firmware="9.9.9"))
    d = await _router(db)
    await db.refresh(d)
    assert d.approval_state == "pending" and d.version == "4.5.0"
    await _age(db)
    resp = await client.post("/router-agent/report", json=report(firmware="4.6.0"))
    assert resp.status_code == 202
    await db.refresh(d)
    assert d.approval_state == "pending"
    assert d.secret_mismatch is True and d.pending_secret_hash is None


async def test_forged_report_on_a_pending_router_leaves_no_trace_and_does_not_starve(client, db):
    await client.post("/router-agent/report", json=report())
    await _age(db)
    await db.execute(text("UPDATE devices SET agent_source_ip = '203.0.113.50' WHERE mac = :m"),
                     {"m": MAC})
    await db.commit()
    before = await _router(db)
    await db.refresh(before)
    seen = (before.agent_source_ip, before.version, before.last_seen_at, before.raw_info,
            before.model, before.agent_secret_hash)
    resp = await client.post("/router-agent/report",
                             json=report(secret=OTHER_SECRET, firmware="9.9.9"))
    assert resp.status_code == 202
    d = await _router(db)
    await db.refresh(d)
    assert (d.agent_source_ip, d.version, d.last_seen_at, d.raw_info,
            d.model, d.agent_secret_hash) == seen
    assert d.secret_mismatch is True and d.pending_secret_hash is not None
    # the genuine router's next report is not rate limited by the forgery
    resp = await client.post("/router-agent/report", json=report(firmware="4.6.0"))
    assert resp.status_code == 202
    await db.refresh(d)
    assert d.version == "4.6.0" and d.pending_secret_hash is None


async def test_approved_router_with_a_different_secret_goes_back_to_pending(client, db):
    await client.post("/router-agent/report", json=report())
    await db.execute(text("UPDATE devices SET approval_state = 'approved' WHERE mac = :m"),
                     {"m": MAC})
    await _age(db)
    await db.execute(text("UPDATE devices SET agent_source_ip = '203.0.113.50' WHERE mac = :m"),
                     {"m": MAC})
    await db.commit()
    before = await _router(db)
    await db.refresh(before)
    seen = (before.agent_source_ip, before.version, before.last_seen_at, before.raw_info)
    resp = await client.post("/router-agent/report",
                             json=report(secret=OTHER_SECRET, firmware="9.9.9"))
    assert resp.status_code == 202 and resp.json() == {"state": "pending"}
    d = await _router(db)
    await db.refresh(d)
    assert d.approval_state == "pending" and d.secret_mismatch is True
    assert d.wan_ip is None  # data discarded
    # a forged report touches nothing but the mismatch flags
    assert (d.agent_source_ip, d.version, d.last_seen_at, d.raw_info) == seen
    assert d.version == "4.5.0"
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


async def test_registration_cap_survives_moving_rows_to_another_ip(client, db):
    for i in range(10):
        resp = await client.post("/router-agent/report",
                                 json=report(wan_mac=f"94:83:c4:00:00:{i:02x}"))
        assert resp.status_code == 202, resp.text
    await db.execute(text("UPDATE devices SET agent_source_ip = '198.51.100.9' "
                          "WHERE device_type = 'router'"))
    await db.commit()
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


async def test_oversized_chunked_body_without_content_length_is_413(client):
    async def _chunks():
        yield b" " * 200_000
        yield b" " * 100_000
    resp = await client.post("/router-agent/report", content=_chunks(),
                             headers={"Content-Type": "application/json"})
    assert resp.status_code == 413 and resp.json()["detail"]["code"] == "payload_too_large"


async def test_response_never_explains_a_held_report(client, db):
    await client.post("/router-agent/report", json=report())
    await _age(db)
    resp = await client.post("/router-agent/report", json=report(secret=OTHER_SECRET))
    assert resp.json() == {"state": "pending"}


async def test_devices_has_the_router_agent_columns(db):
    cols = set((await db.scalars(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'devices'"))).all())
    assert {"approval_state", "approved_at", "approved_by", "agent_secret_hash",
            "pending_secret_hash", "secret_mismatch", "agent_source_ip"} <= cols
    bad = await db.scalar(text(
        "SELECT count(*) FROM pg_constraint WHERE conname = 'devices_approval_state_check'"))
    assert bad == 1


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
    await _approved(client, db)
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
