"""Kiosk Setup's network and verify checks (spec §2): one check per call so the
kiosk can tick them off in order. Every answer is HTTP 200 with
{"name", "ok", "state", "detail", "info"?}; the pairing token never appears."""

import asyncio
from urllib.parse import urlparse

from edge import hostnet, laptop_setup
from edge.rfid import events, pairing
from edge.rfid.ziotc import ReaderError
from edge.upstream import CloudOffline

CHECK_NAMES = ("reader", "router", "portal", "registration", "setup")
GATEWAY_PORTS = (53, 80, 443)
GATEWAY_TIMEOUT_S = 1.5
OFFLINE = "Can't reach the portal"


def result(name: str, state: str, detail: str, info: dict | None = None) -> dict:
    out = {"name": name, "ok": state == "ok", "state": state, "detail": detail}
    if info:
        out["info"] = info
    return out


async def knock(ip: str, port: int) -> bool:
    """True when something at ip:port answered: connected, or refused (the host is up)."""
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, port),
                                                 GATEWAY_TIMEOUT_S)
    except ConnectionRefusedError:
        return True
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    return True


async def run(name: str, st, session) -> dict:
    out = await CHECKS[name](name, st, session)
    if name == "registration":
        ok = out["ok"]
        events.record(st.store, "portal_check_in",
                      "Portal check-in successful" if ok else "Portal check-in failed",
                      "Connected to ServerSherpa" if ok else out["detail"])
    return out


async def _reader(name, st, session) -> dict:
    row = pairing.current_row(st.store)
    if row is None:
        return result(name, "fail", "Pair a reader first")
    token = row["token"]
    try:
        async with st.pair_lock:
            client, version, row = await pairing.open_current(
                st.store, transport=st.reader_transport)
            async with client:
                status = await client.status()
                config = await client.get_config()
    except ReaderError as exc:
        return result(name, "fail", pairing.redact_token(exc.message, token))
    ours = next((c for c in pairing.get_connections(config)
                 if pairing.is_ours(c, st.identity, row["serial"], token)), None)
    info = {"reader_ip": row["ip"],
            "reading": status.get("radioActivitiy") == "active"}
    if ours is not None:
        url = pairing.connection_url(ours)
        info["endpoint_ip"] = urlparse(url).hostname
        info["endpoint_url"] = pairing.redact_url(url)
    radio = status.get("radioConnection")
    if ours is None:
        return result(name, "fail",
                      "The reader no longer sends to this laptop — pair it again", info)
    if radio != "connected":
        return result(name, "fail", f"Reader radio is {radio or 'unknown'}", info)
    model = version.get("model") or row["model"]
    return result(name, "ok", f"{model} {row['serial']} — radio connected", info)


async def _router(name, st, session) -> dict:
    data_dir = st.settings.data_dir
    gateway = hostnet.read_gateway(data_dir)
    interfaces, fresh = hostnet.read_host_network(data_dir)
    row = pairing.current_row(st.store)
    if row is not None:
        lan_ip = hostnet.laptop_ip_for(row["ip"], interfaces)
    else:
        lan_ip = interfaces[0].ipv4 if fresh and interfaces else None
    if gateway is None:
        return result(name, "unknown", "Re-run the install command to update the network helper",
                      {"lan_ip": lan_ip})
    hits = await asyncio.gather(*(st.gateway_knock(gateway, p) for p in GATEWAY_PORTS))
    info = {"gateway": gateway, "lan_ip": lan_ip}
    if any(hits):
        return result(name, "ok", f"Router {gateway} answered", info)
    return result(name, "fail", f"Router {gateway} didn't answer", info)


async def _portal(name, st, session) -> dict:
    if session.offline or not await st.upstream.probe():
        return result(name, "fail", OFFLINE)
    return result(name, "ok", "Portal responded")


async def _as_person(name, st, session, method, path, **kw):
    """(response, None) or (None, a failed check result)."""
    try:
        resp = await st.upstream.as_person(session.person_id, method, path, **kw)
    except CloudOffline:
        return None, result(name, "fail", OFFLINE)
    if resp is None:
        return None, result(name, "fail", "Sign in again")
    return resp, None


async def _registration(name, st, session) -> dict:
    if session.offline:
        return result(name, "fail", OFFLINE)
    resp, failed = await _as_person(
        name, st, session, "POST", "/kiosk/heartbeat",
        json={"serial": st.identity.serial, "name": st.identity.name, "mode": "laptop"})
    if failed:
        return failed
    if resp.status_code != 200:
        return result(name, "fail", f"Portal answered {resp.status_code}")
    body = resp.json()
    registration = body.get("registration")
    device = body.get("name")
    info = {"wan_ip": body.get("client_ip"), "registration": registration,
            "device_name": device}
    if registration in ("ok", "soon"):
        return result(name, "ok", f"Registered as {device}", info)
    if registration == "none":
        return result(name, "fail", "This kiosk isn't registered yet", info)
    return result(name, "fail", "This kiosk's registration has expired — "
                  "ask an admin to renew it on the portal", info)


async def _setup(name, st, session) -> dict:
    if session.offline:
        return result(name, "fail", OFFLINE)
    saved = laptop_setup.load(st.store)
    if saved is None:
        return result(name, "fail", "Finish Kiosk Setup first")
    resp, failed = await _as_person(name, st, session, "GET", "/kiosk/setup",
                                    params={"serial": st.identity.serial})
    if failed:
        return failed
    if resp.status_code == 404:
        return result(name, "fail", "The portal has no setup for this kiosk")
    if resp.status_code != 200:
        return result(name, "fail", f"Portal answered {resp.status_code}")
    portal = resp.json()
    row = pairing.current_row(st.store)
    portal_reader = portal.get("reader") or {}
    reader_serial = portal_reader.get("serial")
    pairs = (("Move", saved.get("initiative_id"), portal.get("initiative_id")),
             ("Site", saved.get("site_id"), portal.get("site_id")),
             ("Scan type", saved.get("scan_status"), portal.get("scan_status")),
             ("Station type", saved.get("station_type"), portal.get("station_type")),
             ("Reader", row["serial"] if row else None, reader_serial))
    info = {"initiative_name": portal.get("initiative_name"),
            "site_name": portal.get("site_name"),
            "scan_status_label": portal.get("scan_status_label"),
            "reader_serial": reader_serial}
    for label, mine, theirs in pairs:
        if (None if mine is None else str(mine)) != (None if theirs is None else str(theirs)):
            return result(name, "fail", f"{label} on the portal doesn't match this laptop", info)
    return result(name, "ok", "Portal has this kiosk's setup", info)


CHECKS = {"reader": _reader, "router": _router, "portal": _portal,
          "registration": _registration, "setup": _setup}
