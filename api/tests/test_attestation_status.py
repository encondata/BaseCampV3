"""Google's attestation revocation list (security/attestation_status.py):
fetched into system_config['attestation_status'] by the notification
worker once a day, or on demand by `serversherpa refresh-attestation-status`,
and read back by load_status. The HTTP side is always a fake."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from typer.testing import CliRunner

from serversherpa import cli
from serversherpa.cli import app
from serversherpa.db.models import SystemConfig
from serversherpa.security.attestation_status import (
    AttestationStatus,
    AttestationStatusFetchError,
    load_status,
    refresh_attestation_status,
)

NOW = datetime(2026, 10, 23, 12, 0, tzinfo=UTC)
GOOGLE_LIST = {"entries": {
    "2c8cdddfd5e03bfc": {"status": "REVOKED", "expires": "2020-11-13",
                         "reason": "KEY_COMPROMISE", "comment": "Key stored on unsecure system"},
    "c8966fcb2fbb0d7a": {"status": "SUSPENDED", "reason": "SOFTWARE_FLAW"},
    "6681152659205225093": {"status": "REVOKED", "reason": "KEY_COMPROMISE"},
}}


def fake_google(body, *, status_code=200, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(str(request.url))
        content = body if isinstance(body, bytes) else json.dumps(body).encode()
        return httpx.Response(status_code, content=content,
                              headers={"content-type": "application/json"})
    return httpx.MockTransport(handler)


async def test_refresh_stores_the_list_and_load_reads_it(db):
    seen: list[str] = []
    await refresh_attestation_status(db, transport=fake_google(GOOGLE_LIST, seen=seen),
                                     now=NOW)
    await db.commit()
    assert seen == ["https://android.googleapis.com/attestation/status"]
    row = await db.get(SystemConfig, "attestation_status")
    assert row.data["fetched_at"] == NOW.isoformat()
    assert set(row.data["entries"]) == set(GOOGLE_LIST["entries"])

    status = await load_status(db)
    assert status == AttestationStatus(
        fetched_at=NOW,
        revoked_serials={"2c8cdddfd5e03bfc", "c8966fcb2fbb0d7a", "6681152659205225093"})


async def test_refresh_replaces_the_previous_list(db):
    await refresh_attestation_status(db, transport=fake_google(GOOGLE_LIST), now=NOW)
    await db.commit()
    later = NOW + timedelta(days=1)
    await refresh_attestation_status(db, transport=fake_google({"entries": {}}), now=later)
    await db.commit()
    status = await load_status(db)
    assert status == AttestationStatus(fetched_at=later, revoked_serials=set())


async def test_serials_are_normalized(db):
    db.add(SystemConfig(section="attestation_status", data={
        "fetched_at": NOW.isoformat(),
        "entries": {"00ABCdef": {"status": "REVOKED"}, "not hex": {"status": "REVOKED"},
                    "1234": {"status": "SOMETHING_NEW"}}}))
    await db.commit()
    status = await load_status(db)
    assert status.revoked_serials == {"abcdef"}


@pytest.mark.parametrize("body,status_code", [
    (b"<html>oops</html>", 200),
    ({"not_entries": {}}, 200),
    ({"entries": ["a list"]}, 200),
    (GOOGLE_LIST, 503),
])
async def test_a_bad_fetch_keeps_the_old_list(db, body, status_code):
    await refresh_attestation_status(db, transport=fake_google(GOOGLE_LIST), now=NOW)
    await db.commit()
    with pytest.raises(AttestationStatusFetchError):
        await refresh_attestation_status(
            db, transport=fake_google(body, status_code=status_code),
            now=NOW + timedelta(days=1))
    await db.rollback()
    assert (await load_status(db)).fetched_at == NOW


async def test_no_list_yet_loads_none(db):
    assert await load_status(db) is None


async def test_unreadable_row_loads_none(db):
    db.add(SystemConfig(section="attestation_status", data={"fetched_at": "yesterday"}))
    await db.commit()
    assert await load_status(db) is None


def test_status_stale_after_7_days():
    status = AttestationStatus(fetched_at=NOW, revoked_serials=set())
    assert status.fresh(NOW + timedelta(days=7))
    assert not status.fresh(NOW + timedelta(days=7, seconds=1))


# ── the notification worker's daily refresh ────────────────────────

async def test_worker_refresh_writes_and_reports_success(monkeypatch):
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.notifications import worker
    from serversherpa.security import attestation_status

    real = attestation_status.refresh_attestation_status

    async def with_fake(db, **kwargs):
        return await real(db, transport=fake_google(GOOGLE_LIST), now=NOW)

    monkeypatch.setattr(attestation_status, "refresh_attestation_status", with_fake)
    maker = get_sessionmaker()
    assert await worker.run_attestation_refresh(maker) is True
    async with maker() as db:
        assert (await load_status(db)).fetched_at == NOW


async def test_worker_refresh_failure_is_logged_not_raised(monkeypatch, caplog):
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.notifications import worker
    from serversherpa.security import attestation_status

    async def boom(db, **kwargs):
        raise AttestationStatusFetchError("network down")

    monkeypatch.setattr(attestation_status, "refresh_attestation_status", boom)
    assert await worker.run_attestation_refresh(get_sessionmaker()) is False
    assert "attestation" in caplog.text


# ── serversherpa refresh-attestation-status ────────────────────────

runner = CliRunner()


async def test_cli_helper_refreshes_through_the_fake(db):
    """The command's async body, run in the test's own loop (CliRunner would
    nest asyncio.run inside it), against a fake Google response."""
    count = await cli._refresh_attestation_status(transport=fake_google(GOOGLE_LIST))
    assert count == 3
    status = await load_status(db)
    assert status is not None and status.revoked_serials >= {"2c8cdddfd5e03bfc"}
    assert status.fresh(datetime.now(UTC))


def test_cli_command_reports_the_count(monkeypatch):
    async def fake(**kwargs):
        return 1765

    monkeypatch.setattr(cli, "_refresh_attestation_status", fake)
    result = runner.invoke(app, ["refresh-attestation-status"])
    assert result.exit_code == 0, result.output
    assert "1765" in result.output


def test_cli_command_fails_loudly(monkeypatch):
    async def fake(**kwargs):
        raise AttestationStatusFetchError("HTTP 503 from Google")

    monkeypatch.setattr(cli, "_refresh_attestation_status", fake)
    result = runner.invoke(app, ["refresh-attestation-status"])
    assert result.exit_code == 1
    assert "HTTP 503 from Google" in result.output


# ── settings ───────────────────────────────────────────────────────

def test_signing_digests_setting_is_comma_separated(monkeypatch):
    from serversherpa.config import Settings

    a, b = "ab" * 32, "CD:" * 31 + "CD"
    monkeypatch.setenv("SS_KIOSK_SIGNING_DIGESTS", f" {a} , {b},")
    settings = Settings()
    assert settings.kiosk_signing_digests == [a, "cd" * 32]
    assert settings.attestation_status_url == "https://android.googleapis.com/attestation/status"


def test_signing_digests_setting_refuses_a_bad_digest(monkeypatch):
    from pydantic import ValidationError

    from serversherpa.config import Settings

    monkeypatch.setenv("SS_KIOSK_SIGNING_DIGESTS", "not-a-sha256")
    with pytest.raises(ValidationError):
        Settings()
