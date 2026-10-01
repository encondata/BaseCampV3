"""The laptop edge (kiosk_laptop/edge) treats cloud bodies as opaque JSON
except for these fields. If one of these assertions fails, the edge needs
the matching change before the cloud ships."""

import typing

from serversherpa.api.schemas import (
    HeartbeatIn,
    KioskEdgeMovePassword,
    KioskEdgeMovePasswordsOut,
    KioskScanBatchIn,
    KioskScanBatchOut,
    KioskScanIn,
    KioskScanRejected,
    KioskSetupOut,
    PairPollOut,
    SessionOut,
    SessionTemplateOut,
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
    # the edge validates these before queuing (routes/kiosk.py::_valid_scan)
    assert {"client_scan_id", "scanned_value", "scan_type", "scanned_at"} <= \
        set(KioskScanIn.model_fields)
    assert set(typing.get_args(KioskScanIn.model_fields["scan_type"].annotation)) == \
        {"rfid", "barcode"}
    value_max = [m.max_length for m in KioskScanIn.model_fields["scanned_value"].metadata
                 if hasattr(m, "max_length")]
    assert value_max == [200]


def test_scan_batch_answer_carries_what_the_outbox_reads():
    assert {"accepted", "rejected"} <= set(KioskScanBatchOut.model_fields)
    assert {"client_scan_id", "code"} <= set(KioskScanRejected.model_fields)


def test_pair_poll_carries_the_session():
    assert {"status", "session"} <= set(PairPollOut.model_fields)


def test_setup_answer_carries_the_initiative():
    assert "initiative_id" in KioskSetupOut.model_fields


def test_move_passwords_carry_what_the_sync_reads():
    assert {"moves", "unchanged"} <= set(KioskEdgeMovePasswordsOut.model_fields)
    assert {"initiative_id", "name", "argon2_hash", "session", "version"} <= \
        set(KioskEdgeMovePassword.model_fields)
