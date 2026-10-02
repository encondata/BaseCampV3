"""Pairing an FX reader with this laptop (spec §2.4): point the reader's
ZIOTC tag-data endpoint (`READER-GATEWAY.endpointConfig.data.event.connections`)
at `http://<laptop-ip>:8091/rfid/<reader-serial>/<token>`, read it back to
verify, and record the pairing in SQLite.

A connection is ours when its name carries our prefix (`ServerSherpa Kiosk
<last4> `) AND its URL carries this laptop's stored token for that reader;
any other connection named `ServerSherpa Kiosk…` belongs to another kiosk
(two kiosks can share the last 4 serial characters, so the name alone proves
nothing). Discovery, connect and pair all use this rule via `paired_with`.
When pairing, every `ServerSherpa Kiosk…` connection and any connection
carrying our token (one somebody renamed) is replaced by ours. The token is a secret: it is redacted as `…` in every
response and log line.

A reader answers on https 443 or http 80; connect and pair use where the
latest scan found it, else where it answered before, else 443 then 80, and
remember the winner per serial. Pairing a different reader than the current
one takes our connection off the old reader, best effort (`release`)."""

import copy
import ipaddress
import json
import logging
import secrets

import httpx

from edge import hostnet
from edge.db import Store, now_iso
from edge.deps import err
from edge.identity import Identity
from edge.rfid import ziotc
from edge.rfid.ziotc import ReaderError

log = logging.getLogger("edge.rfid.pairing")

PAIR_PREFIX = "ServerSherpa Kiosk"
READER_PORT = 8091
REDACTED = "…"
MAX_CONNECTIONS = 2  # the reader maps at most 2 data endpoints
CONNECTIONS_PATH = ("endpointConfig", "data", "event", "connections")
VERSION_KEYS = ("readerApplication", "radioFirmware", "cloudAgentApplication")


# ── the shared connections helper (discovery reads it too) ──

def get_connections(config) -> list[dict]:
    """The data-event connections in a full `/cloud/config` answer; [] when
    the shape is missing or wrong."""
    try:
        node = config["READER-GATEWAY"]
        for key in CONNECTIONS_PATH:
            node = node[key]
    except (KeyError, TypeError):
        return []
    return [c for c in node if isinstance(c, dict)] if isinstance(node, list) else []


def with_connections(config: dict, connections: list[dict]) -> dict:
    """A copy of the config's READER-GATEWAY object with its connections replaced."""
    gateway = copy.deepcopy(config.get("READER-GATEWAY"))
    if not isinstance(gateway, dict):
        gateway = {}
    node = gateway
    for key in CONNECTIONS_PATH[:-1]:
        if not isinstance(node.get(key), dict):
            node[key] = {}
        node = node[key]
    node[CONNECTIONS_PATH[-1]] = connections
    return gateway


def _name(conn: dict) -> str:
    return str(conn.get("name") or "")


def connection_url(conn: dict) -> str:
    options = conn.get("options")
    return str(options.get("URL") or "") if isinstance(options, dict) else ""


# ── names, URLs and redaction ──

def own_prefix(identity: Identity) -> str:
    return f"{PAIR_PREFIX} {identity.serial[-4:]} "


def connection_name(identity: Identity) -> str:
    return f"{own_prefix(identity)}({identity.name})"


def endpoint_url(laptop_ip: str, serial: str, token: str) -> str:
    return f"http://{laptop_ip}:{READER_PORT}/rfid/{serial}/{token}"


def redact_url(url: str) -> str:
    head, sep, _token = url.rpartition("/")
    return f"{head}/{REDACTED}" if sep else REDACTED


def token_matches(conn: dict, serial: str, token: str | None) -> bool:
    return bool(token) and connection_url(conn).endswith(f"/rfid/{serial}/{token}")


def is_ours(conn: dict, identity: Identity, serial: str, token: str | None) -> bool:
    return _name(conn).startswith(own_prefix(identity)) and token_matches(conn, serial, token)


def paired_with(config, identity: Identity | None, serial: str,
                token: str | None) -> str | None:
    """The name of another kiosk's connection on the reader (the first
    `ServerSherpa Kiosk…` connection that isn't ours), or None."""
    for conn in get_connections(config):
        if _name(conn).startswith(PAIR_PREFIX) and not (
                identity is not None and is_ours(conn, identity, serial, token)):
            return _name(conn)
    return None


def redact_token(text: str, token: str | None) -> str:
    return text.replace(token, REDACTED) if token else text


def valid_ipv4(value) -> str:
    try:
        return str(ipaddress.IPv4Address(str(value)))
    except ValueError:
        raise err(422, "bad_ip") from None


# ── storage ──

def _row(store: Store, serial: str):
    return store.one("SELECT * FROM rfid_readers WHERE serial = ?", (serial,))


def stored_token(store: Store, serial: str) -> str | None:
    row = _row(store, serial)
    return row["token"] if row else None


def password_first(store: Store, ip: str) -> int | None:
    """The last winning password index for the reader last seen at this IP."""
    row = store.one("SELECT password_index FROM rfid_readers WHERE ip = ? "
                    "ORDER BY COALESCE(paired_at, '') DESC LIMIT 1", (ip,))
    return row["password_index"] if row else None


def remember(store: Store, *, serial: str, ip: str, model: str, versions: dict,
             password_index: int | None, token: str | None = None,
             scheme: str | None = None, port: int | None = None) -> None:
    """Upsert what we know of a reader. A NULL token, password index, scheme
    or port never overwrites a stored one."""
    store.run(
        "INSERT INTO rfid_readers (serial, ip, model, versions, password_index, token, "
        "scheme, port) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (serial) DO UPDATE SET "
        "ip = excluded.ip, model = excluded.model, versions = excluded.versions, "
        "password_index = COALESCE(excluded.password_index, rfid_readers.password_index), "
        "token = COALESCE(excluded.token, rfid_readers.token), "
        "scheme = COALESCE(excluded.scheme, rfid_readers.scheme), "
        "port = COALESCE(excluded.port, rfid_readers.port)",
        (serial, ip, model, json.dumps(versions), password_index, token, scheme, port))


def remembered_endpoint(store: Store, ip: str) -> tuple[str, int] | None:
    """(scheme, port) the reader last seen at this IP answered on."""
    row = store.one("SELECT scheme, port FROM rfid_readers WHERE ip = ? AND scheme IS NOT NULL "
                    "AND port IS NOT NULL ORDER BY COALESCE(paired_at, '') DESC LIMIT 1", (ip,))
    return (row["scheme"], row["port"]) if row else None


def endpoints(store: Store, ip: str, found_at: tuple[str, int] | None = None
              ) -> list[tuple[str, int]]:
    """Where to try a reader, in order: where the latest scan found it, where
    it answered before, then https 443 and http 80 (a manually entered IP)."""
    order: list[tuple[str, int]] = []
    for candidate in (found_at, remembered_endpoint(store, ip), *ziotc.DEFAULT_ENDPOINTS):
        if candidate and tuple(candidate) not in order:
            order.append(tuple(candidate))
    return order


def _public(row) -> dict:
    url = endpoint_url(row["laptop_ip"], row["serial"], row["token"]) \
        if row["laptop_ip"] and row["token"] else None
    return {"ip": row["ip"], "serial": row["serial"], "model": row["model"],
            "versions": json.loads(row["versions"]) if row["versions"] else None,
            "paired_at": row["paired_at"], "laptop_ip": row["laptop_ip"],
            "endpoint_url": redact_url(url) if url else None}


def current(store: Store) -> dict | None:
    """The paired reader (token redacted), or None."""
    row = store.one("SELECT r.* FROM rfid_pairing p JOIN rfid_readers r ON r.serial = p.serial "
                    "WHERE p.id = 1")
    return _public(row) if row else None


def cloud_reader(store: Store) -> dict | None:
    """The current reader as the cloud's KioskReaderIn takes it."""
    reader = current(store)
    if reader is None:
        return None
    versions = {k: v for k, v in (reader["versions"] or {}).items() if isinstance(v, str)}
    return {"ip": reader["ip"], "serial": reader["serial"], "model": reader["model"],
            "versions": versions}


# ── connect and pair ──

def _reader_status(code: str) -> int:
    return 409 if code in ("reader_paired_elsewhere", "reader_endpoints_full") else 502


def reader_http_error(exc: ReaderError):
    return err(_reader_status(exc.code), exc.code, message=exc.message)


def _versions(version: dict) -> dict:
    return {key: version.get(key) for key in VERSION_KEYS}


async def connect(store: Store, identity: Identity, ip: str, *, transport=None,
                  probe=ziotc.probe, found_at: tuple[str, int] | None = None) -> dict:
    """An explicit Connect: the full password list (remembered index first),
    on each endpoint in turn while the reader can't be reached."""
    order = endpoints(store, ip, found_at)
    for i, (scheme, port) in enumerate(order):
        try:
            found = await probe(ip, transport, password_first(store, ip), scheme=scheme,
                                port=port, with_config=True)
            break
        except ReaderError as exc:
            if exc.code != "reader_unreachable" or i == len(order) - 1:
                raise
            _log_fallback(ip, order[i], order[i + 1])
    if not found or not found.get("serial"):
        raise ReaderError("reader_not_iotc", "This isn't an FX reader in IoT Connector mode.")
    serial = str(found["serial"])
    # the winning index and where it answered, by serial (and so by IP); no token yet
    remember(store, serial=serial, ip=ip, model=found["model"], versions=found["versions"],
             password_index=found.get("password_index"), scheme=scheme, port=port)
    elsewhere = paired_with(found.get("config"), identity, serial, stored_token(store, serial))
    log.debug("connected to reader %s at %s (paired with: %s)", serial, ip, elsewhere)
    return {"ip": ip, "model": found["model"], "serial": serial,
            "versions": found["versions"], "status": found["status"],
            "paired_with": elsewhere}


def laptop_address(data_dir, reader_ip: str, given: str | None) -> str:
    """The laptop IP the reader should send to: the one given, else the
    fresh laptop address on the reader's subnet. No fresh address file is
    409 `host_network_unknown`; a fresh one with no address on the reader's
    subnet is 409 `reader_not_on_subnet` (routed networks, bridges, VLANs)."""
    if given:
        return valid_ipv4(given)
    interfaces, fresh = hostnet.read_host_network(data_dir)
    if not fresh:
        raise err(409, "host_network_unknown")
    found = hostnet.laptop_ip_for(reader_ip, interfaces)
    if found is None:
        raise err(409, "reader_not_on_subnet")
    return found


RELEASE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)


async def release(row, identity: Identity, *, transport=None) -> None:
    """Best effort: take our connection off a reader this laptop is leaving
    (a different reader was paired, or the station became a Label Station).

    It never sends the password list: the address must still pass the
    unauthenticated fingerprint, only the stored password index is tried
    (none stored: skipped), and the reader's serial must still be the one we
    paired. Only connections `is_ours` matches are removed. Any failure is
    logged (never the token) and swallowed — it never fails the caller."""
    serial, token, ip = row["serial"], row["token"], row["ip"]
    scheme = row["scheme"] or "https"
    port = row["port"]
    index = row["password_index"]
    if index is None:
        log.info("not releasing reader %s: no stored password index", serial)
        return
    try:
        if not await ziotc.fingerprint(ip, scheme=scheme, port=port, transport=transport,
                                       timeout=RELEASE_TIMEOUT):
            log.info("not releasing reader %s: %s no longer looks like a Zebra reader",
                     serial, ip)
            return
        async with ziotc.ZiotcClient(ip, scheme=scheme, port=port, transport=transport,
                                     passwords=[index], timeout=RELEASE_TIMEOUT) as client:
            found = str((await client.version()).get("serialNumber") or "")
            if found != serial:
                log.info("not releasing reader %s: %s is now another reader", serial, ip)
                return
            config = await client.get_config()
            connections = get_connections(config)
            kept = [c for c in connections if not is_ours(c, identity, serial, token)]
            if len(kept) == len(connections):
                log.info("reader %s holds no connection of ours", serial)
                return
            await client.put_config({"READER-GATEWAY": with_connections(config, kept)})
        log.info("removed our connection from reader %s", serial)
    except ReaderError as exc:
        log.warning("couldn't remove our connection from reader %s (%s)", serial, exc.code)
    except Exception as exc:  # never fail the caller
        log.warning("couldn't remove our connection from reader %s (%s)", serial,
                    type(exc).__name__)


def current_row(store: Store):
    """The raw rfid_readers row of the paired reader (token included), or None."""
    return store.one("SELECT r.* FROM rfid_pairing p JOIN rfid_readers r "
                     "ON r.serial = p.serial WHERE p.id = 1")


def _log_fallback(ip: str, tried: tuple[str, int], following: tuple[str, int]) -> None:
    log.debug("unreachable: falling back from %s:%d to %s:%d for %s",
              tried[0], tried[1], following[0], following[1], ip)


async def pair(store: Store, identity: Identity, ip: str, laptop_ip: str, *,
               confirm_takeover: bool = False, transport=None,
               found_at: tuple[str, int] | None = None) -> dict:
    tokens: list[str] = []  # the token once known, for redacting reader messages
    try:
        return await _pair(store, identity, ip, laptop_ip, confirm_takeover, transport, tokens,
                           found_at)
    except ReaderError as exc:
        # a reader may echo the endpoint URL back in its error message
        message = exc.message
        for token in tokens:
            message = redact_token(message, token)
        if message != exc.message:
            raise ReaderError(exc.code, message) from None
        raise


async def open_reader(store: Store, ip: str, *, transport=None,
                      found_at: tuple[str, int] | None = None
                      ) -> tuple[ziotc.ZiotcClient, dict]:
    """A signed-in client and the reader's /cloud/version, on the first
    endpoint that answers (see `endpoints`). The caller closes the client."""
    order = endpoints(store, ip, found_at)
    for i, (scheme, port) in enumerate(order):
        client = ziotc.ZiotcClient(ip, scheme=scheme, port=port, transport=transport,
                                   password_first=password_first(store, ip))
        try:
            return client, await client.version()
        except ReaderError as exc:
            await client.aclose()
            if exc.code != "reader_unreachable" or i == len(order) - 1:
                raise
            _log_fallback(ip, order[i], order[i + 1])
    raise ReaderError("reader_unreachable", f"Can't reach {ip}.")  # no endpoints: unreachable


async def _pair(store: Store, identity: Identity, ip: str, laptop_ip: str,
                confirm_takeover: bool, transport, tokens: list[str],
                found_at: tuple[str, int] | None) -> dict:
    client, version = await open_reader(store, ip, transport=transport, found_at=found_at)
    try:
        model = str(version.get("model") or "")
        serial = str(version.get("serialNumber") or "")
        if not model.startswith("FX") or not serial:
            raise ReaderError("reader_not_iotc", "This isn't an FX reader in IoT Connector mode.")
        versions = _versions(version)
        # keep the token before writing, so a failed verify can't orphan our connection
        token = stored_token(store, serial) or secrets.token_urlsafe(32)
        tokens.append(token)
        remember(store, serial=serial, ip=ip, model=model, versions=versions,
                 password_index=client.password_index, token=token,
                 scheme=client.scheme, port=client.port)

        config = await client.get_config()
        if not isinstance(config.get("READER-GATEWAY"), dict):
            raise ReaderError("reader_error", "The reader's config has no READER-GATEWAY.")
        connections = get_connections(config)
        foreign = paired_with(config, identity, serial, token)
        if foreign and not confirm_takeover:
            raise err(409, "reader_paired_elsewhere", name=foreign)
        url = endpoint_url(laptop_ip, serial, token)
        mine = {"type": "httpPost", "name": connection_name(identity),
                "description": f"ServerSherpa kiosk {identity.serial}",
                "options": {"URL": url, "security": {"verifyPeer": False, "verifyHost": False,
                                                     "authenticationType": "NONE"}}}
        # drop every kiosk connection, and ours even if someone renamed it
        kept = [c for c in connections if not _name(c).startswith(PAIR_PREFIX)
                and not token_matches(c, serial, token)]
        edited = [*kept, mine]
        if len(edited) > MAX_CONNECTIONS:
            raise err(409, "reader_endpoints_full")

        log.debug("pairing reader %s at %s -> %s", serial, ip, redact_url(url))
        await client.put_config({"READER-GATEWAY": with_connections(config, edited)})
        check = get_connections(await client.get_config())
        if not any(c.get("name") == mine["name"] and connection_url(c) == url for c in check):
            log.info("reader %s did not keep %s", serial, redact_url(url))
            raise ReaderError("reader_verify_failed",
                              "The reader didn't keep the new endpoint.")
    finally:
        await client.aclose()

    previous = current_row(store)
    paired_at = now_iso()
    with store.tx() as c:
        c.execute("UPDATE rfid_readers SET laptop_ip = ?, paired_at = ? WHERE serial = ?",
                  (laptop_ip, paired_at, serial))
        c.execute("INSERT INTO rfid_pairing (id, serial) VALUES (1, ?) "
                  "ON CONFLICT (id) DO UPDATE SET serial = excluded.serial", (serial,))
    log.info("paired reader %s at %s -> %s", serial, ip, redact_url(url))
    if previous is not None and previous["serial"] != serial:
        await release(previous, identity, transport=transport)
    reader = current(store)
    return {"paired": True,
            "reader": {k: reader[k] for k in ("ip", "serial", "model", "versions", "paired_at")},
            "endpoint_url": reader["endpoint_url"]}
