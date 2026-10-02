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
