"""Reproducible ids: scan ids, RFID tags and device names/serials."""

from __future__ import annotations

import random
import uuid


def scan_id(run_id: uuid.UUID, stage_key: str, subject_id: str) -> uuid.UUID:
    """A stable id for one scan, so a replayed run sends the same ids."""
    return uuid.uuid5(run_id, f"{stage_key}:{subject_id}")


def make_tags(rng: random.Random, count: int) -> list[str]:
    """`count` unique 24-digit uppercase hex RFID tags, never starting with 0."""
    tags: dict[str, None] = {}
    while len(tags) < count:
        tags[f"{rng.randrange(1 << 92, 1 << 96):024X}"] = None
    return list(tags)


def device_serial(stage_key: str, n: int) -> str:
    """Serial for the n-th (1-based) device of a stage, e.g. LOADTEST-LABEL-2."""
    return f"LOADTEST-{stage_key.upper().replace('_', '-')}-{n}"


def device_name(stage_label: str, n: int, of: int) -> str:
    """Display name for the n-th of `of` devices; no number when there is only one."""
    base = f"Load test – {stage_label}"
    return base if of == 1 else f"{base} {n}"
