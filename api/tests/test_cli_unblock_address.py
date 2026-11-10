"""`serversherpa unblock-address` (SS-487): the break-glass when every admin
is shut out. typer's CliRunner would call asyncio.run() inside the running
test loop, so the usage errors go through the runner and the work through
the async helper the command wraps."""
from datetime import UTC, datetime

from sqlalchemy import select
from typer.testing import CliRunner

from serversherpa import cli
from serversherpa.db.models import AddressBlock, AuditLog
from tests.test_address_block_notifications import trip

runner = CliRunner()


def test_needs_exactly_one_of_address_or_all():
    for args in ([], ["203.0.113.7", "--all"]):
        result = runner.invoke(cli.app, ["unblock-address", *args])
        assert result.exit_code == 2
        assert "address" in result.output.lower()


async def test_clears_one_address_and_audits(db):
    await trip(db, "203.0.113.7", datetime.now(UTC))
    await trip(db, "203.0.113.8", datetime.now(UTC))
    lines, code = await cli._unblock_addresses("203.0.113.7", False)
    assert code == 0 and lines == ["Cleared 203.0.113.7."]
    db.expire_all()
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "address_block_cleared"))
    assert log.entity_id == "203.0.113.7" and log.actor_person_id is None
    assert log.changes == {"address": "203.0.113.7", "level": 1, "via": "cli"}
    other = await db.get(AddressBlock, "203.0.113.8")
    assert other.cleared_at is None


async def test_ipv6_address_is_normalized_to_its_64(db):
    await trip(db, "2001:db8::5", datetime.now(UTC))
    lines, code = await cli._unblock_addresses("2001:db8::99", False)
    assert code == 0 and lines == ["Cleared 2001:db8::/64."]


async def test_all_clears_every_active_block(db):
    await trip(db, "203.0.113.7", datetime.now(UTC))
    await trip(db, "203.0.113.8", datetime.now(UTC))
    lines, code = await cli._unblock_addresses(None, True)
    assert code == 0 and sorted(lines) == ["Cleared 203.0.113.7.", "Cleared 203.0.113.8."]
    logs = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "address_block_cleared"))).all()
    assert len(logs) == 2


async def test_no_active_block_exits_1(db):
    lines, code = await cli._unblock_addresses("203.0.113.7", False)
    assert code == 1 and lines == ["No active block for 203.0.113.7."]
