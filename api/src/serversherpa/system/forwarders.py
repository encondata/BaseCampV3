"""Remote log transports. Primary: Grafana Loki HTTP push (the user's
collector). Secondary: syslog RFC 5424 over UDP/TCP/TLS (Wazuh-ready).
Builders are pure; senders are thin and raise on failure so the
log-service owns retry/backoff policy."""

import asyncio
import base64
import json
import ssl

import httpx

_SEVERITY = {10: 7, 20: 6, 30: 4, 40: 3, 50: 2}   # levelno -> syslog sev
_FACILITY = 16                                     # local0
_LOKI_PUSH_PATH = "/loki/api/v1/push"


def transport_configured(cfg: dict) -> bool:
    if cfg.get("mode") == "local":
        return False
    if cfg.get("transport", "loki") == "loki":
        return bool(cfg.get("loki", {}).get("url"))
    return bool(cfg.get("syslog", {}).get("host"))


# ── Loki ────────────────────────────────────────────────────────────

def build_loki_payload(rows: list[dict], hostname: str) -> dict:
    """Streams grouped by (process, level) — low label cardinality on
    purpose; everything else lives in the line."""
    streams: dict[tuple[str, str], list[list[str]]] = {}
    for r in rows:
        ns = str(int(r["at"].timestamp() * 1_000_000_000))
        line = (f"{r['logger']}: {r['message']}" if r["logger"]
                else r["message"])
        streams.setdefault((r["process"], r["level"]), []).append([ns, line])
    return {"streams": [
        {"stream": {"app": "serversherpa", "process": process,
                    "level": level, "host": hostname},
         "values": values}
        for (process, level), values in streams.items()]}


def loki_headers(loki_cfg: dict) -> dict:
    headers = {"Content-Type": "application/json"}
    if loki_cfg.get("username"):
        raw = f"{loki_cfg['username']}:{loki_cfg.get('password', '')}"
        headers["Authorization"] = (
            "Basic " + base64.b64encode(raw.encode()).decode())
    if loki_cfg.get("tenant_id"):
        headers["X-Scope-OrgID"] = loki_cfg["tenant_id"]
    return headers


async def send_loki(loki_cfg: dict, rows: list[dict],
                    hostname: str) -> None:
    url = loki_cfg["url"].rstrip("/") + _LOKI_PUSH_PATH
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=build_loki_payload(rows, hostname),
                                 headers=loki_headers(loki_cfg))
    if resp.status_code >= 300:
        raise RuntimeError(
            f"loki push failed: HTTP {resp.status_code}: {resp.text[:200]}")


# ── syslog RFC 5424 ─────────────────────────────────────────────────

def build_syslog_frame(row: dict, hostname: str) -> bytes:
    pri = _FACILITY * 8 + _SEVERITY.get(row["levelno"], 6)
    ts = row["at"].isoformat()
    msg = json.dumps({"process": row["process"], "level": row["level"],
                      "logger": row["logger"], "message": row["message"],
                      "at": ts, "extra": row.get("extra") or {}})
    return (f"<{pri}>1 {ts} {hostname} serversherpa-{row['process']} "
            f"- - - {msg}").encode()


async def send_syslog(syslog_cfg: dict, rows: list[dict],
                      hostname: str) -> None:
    frames = [build_syslog_frame(r, hostname) for r in rows]
    host = syslog_cfg["host"]
    port = int(syslog_cfg["port"])
    protocol = syslog_cfg.get("protocol", "udp")
    if protocol == "udp":
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            asyncio.DatagramProtocol, remote_addr=(host, port))
        try:
            for frame in frames:
                transport.sendto(frame)
        finally:
            transport.close()
        return
    ssl_ctx = ssl.create_default_context() if protocol == "tls" else None
    reader, writer = await asyncio.open_connection(host, port, ssl=ssl_ctx)
    try:
        for frame in frames:                     # octet-counting framing
            writer.write(f"{len(frame)} ".encode() + frame)
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()
