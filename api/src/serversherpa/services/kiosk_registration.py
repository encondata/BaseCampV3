"""Kiosk registration state, shared by the kiosk routes and the station-key
dependency (deps.py cannot import routes)."""

from datetime import datetime, timedelta

REGISTRATION_SOON = timedelta(days=7)   # same threshold as the Kiosk Devices page


def registration_state(token_expires_at: datetime | None, now: datetime) -> str:
    """`none` (never registered), `expired`, `soon` (within REGISTRATION_SOON
    of expiring) or `ok`."""
    if token_expires_at is None:
        return "none"
    if token_expires_at <= now:
        return "expired"
    return "soon" if token_expires_at - now <= REGISTRATION_SOON else "ok"
