"""Google's Android attestation revocation list, cached in system_config.

Google publishes the serial numbers of revoked or suspended attestation
certificates at https://android.googleapis.com/attestation/status
(`{"entries": {"<lowercase hex serial>": {"status": "REVOKED" | "SUSPENDED",
...}}}`). The notification worker refreshes it once a day
(`refresh_attestation_status`), and `serversherpa refresh-attestation-status`
does it on demand. Biometric enroll reads it back with `load_status` and
refuses with attestation_status_unavailable when it is missing or older than
seven days (`AttestationStatus.fresh`)."""

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings

logger = logging.getLogger("serversherpa.security.attestation_status")

SECTION = "attestation_status"
MAX_AGE = timedelta(days=7)
# Statuses that mean "don't trust this certificate" (Google's schema enum).
UNTRUSTED = frozenset({"REVOKED", "SUSPENDED"})
FETCH_TIMEOUT = httpx.Timeout(30.0)
# The list is ~180 KB today; anything far bigger is not Google's list.
MAX_BYTES = 16 * 1024 * 1024


class AttestationStatusFetchError(Exception):
    """The list could not be fetched or wasn't the expected shape. The
    previously stored list is left as it was."""


@dataclass(frozen=True)
class AttestationStatus:
    fetched_at: datetime
    revoked_serials: set[str]

    def fresh(self, now: datetime) -> bool:
        """True while the list is at most seven days old."""
        return now - self.fetched_at <= MAX_AGE


def normalize_serial(value: str) -> str | None:
    """A certificate serial as lowercase hex without leading zeros (the form
    `format(cert.serial_number, "x")` gives), or None when it isn't hex."""
    text = value.strip().lower()
    try:
        return format(int(text, 16), "x")
    except ValueError:
        return None


async def _fetch(url: str, transport: httpx.AsyncBaseTransport | None) -> dict:
    try:
        async with (httpx.AsyncClient(follow_redirects=False, timeout=FETCH_TIMEOUT,
                                      transport=transport) as client,
                    client.stream("GET", url,
                                  headers={"Cache-Control": "no-cache"}) as resp):
            if resp.status_code != 200:
                raise AttestationStatusFetchError(
                    f"HTTP {resp.status_code} from {url}")
            body = bytearray()
            async for chunk in resp.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise AttestationStatusFetchError(
                        f"the list from {url} is over {MAX_BYTES} bytes")
    except httpx.HTTPError as exc:
        raise AttestationStatusFetchError(f"could not fetch {url}: {exc}") from exc
    try:
        payload = json.loads(bytes(body))
    except ValueError as exc:
        raise AttestationStatusFetchError(f"{url} did not return JSON") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), dict):
        raise AttestationStatusFetchError(f"{url} returned no 'entries' object")
    return payload["entries"]


def _clean_entries(entries: dict) -> dict[str, dict]:
    """Keep each entry's documented string fields; drop anything else."""
    kept: dict[str, dict] = {}
    for serial, entry in entries.items():
        if not isinstance(serial, str) or not isinstance(entry, dict):
            continue
        kept[serial] = {k: v for k, v in entry.items()
                        if k in ("status", "reason", "expires") and isinstance(v, str)}
    return kept


async def refresh_attestation_status(
        db: AsyncSession, *, transport: httpx.AsyncBaseTransport | None = None,
        now: datetime | None = None) -> None:
    """Fetch Google's list and store `{fetched_at, entries}` under
    system_config['attestation_status']. The caller commits. Raises
    AttestationStatusFetchError (and writes nothing) when the fetch fails."""
    from serversherpa.db.models import SystemConfig

    url = get_settings().attestation_status_url
    entries = _clean_entries(await _fetch(url, transport))
    now = now or datetime.now(UTC)
    data = {"fetched_at": now.isoformat(), "entries": entries}
    row = await db.get(SystemConfig, SECTION)
    if row is None:
        db.add(SystemConfig(section=SECTION, data=data, updated_at=now))
    else:
        row.data = data
        row.updated_at = now
    await db.flush()
    logger.info("attestation status list refreshed: %d entr%s", len(entries),
                "y" if len(entries) == 1 else "ies")


async def load_status(db: AsyncSession) -> AttestationStatus | None:
    """The cached list, or None when there is none yet or it can't be read."""
    from serversherpa.db.models import SystemConfig

    row = await db.get(SystemConfig, SECTION)
    if row is None or not isinstance(row.data, dict):
        return None
    try:
        fetched_at = datetime.fromisoformat(row.data["fetched_at"])
    except (KeyError, TypeError, ValueError):
        return None
    if fetched_at.tzinfo is None:
        return None
    entries = row.data.get("entries")
    if not isinstance(entries, dict):
        return None
    revoked = set()
    for serial, entry in entries.items():
        if isinstance(entry, dict) and entry.get("status") in UNTRUSTED:
            normalized = normalize_serial(serial) if isinstance(serial, str) else None
            if normalized is not None:
                revoked.add(normalized)
    return AttestationStatus(fetched_at=fetched_at, revoked_serials=revoked)
