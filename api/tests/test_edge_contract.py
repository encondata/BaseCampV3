"""The laptop edge (kiosk_laptop/edge) treats cloud bodies as opaque JSON
except for these fields. If one of these assertions fails, the edge needs
the matching change before the cloud ships."""

import typing

from serversherpa.api.schemas import (
    HeartbeatIn, KioskScanBatchIn, KioskScanIn, SessionOut, SessionTemplateOut,
)

TOKEN_FIELDS = {"status", "access_token", "token_type", "expires_in", "session_expires_at"}


def test_session_template_is_sessionout_minus_token_fields():
    assert set(SessionTemplateOut.model_fields) == set(SessionOut.model_fields) - TOKEN_FIELDS


def test_sessionout_carries_what_the_edge_reads():
    assert {"access_token", "expires_in", "session_expires_at", "person", "max_rank",
            "kiosk_move"} <= set(SessionOut.model_fields)


def test_heartbeat_accepts_laptop_mode():
    assert "laptop" in typing.get_args(HeartbeatIn.model_fields["mode"].annotation)


def test_scan_batch_shape_and_limit():
    assert {"serial", "scans"} <= set(KioskScanBatchIn.model_fields)
    limit = [m.max_length for m in KioskScanBatchIn.model_fields["scans"].metadata
             if hasattr(m, "max_length")]
    assert limit == [100]
    assert "client_scan_id" in KioskScanIn.model_fields
