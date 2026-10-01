"""Who this laptop is. Generated once, kept in /data/identity.json, and
never regenerated while that file exists — the cloud upserts the kiosk's
Device row by serial, so a new serial would make the laptop a stranger.
A corrupt file is an error, not a reason to mint a new identity."""

import json
import os
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

from edge.db import now_iso

NAME_MAX = 80


@dataclass(frozen=True)
class Identity:
    serial: str
    name: str
    created_at: str


def default_name(serial: str) -> str:
    return f"Kiosk {serial[-4:].upper()}"


def _path(data_dir: Path) -> Path:
    return data_dir / "identity.json"


def _write(path: Path, ident: Identity) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(asdict(ident)))
    os.replace(tmp, path)


def load_or_create(data_dir: Path) -> Identity:
    path = _path(data_dir)
    if path.exists():
        raw = json.loads(path.read_text())  # ValueError on corruption: refuse to start
        return Identity(serial=raw["serial"], name=raw["name"], created_at=raw["created_at"])
    serial = f"kiosk-laptop-{uuid.uuid4()}"
    ident = Identity(serial=serial, name=default_name(serial), created_at=now_iso())
    _write(path, ident)
    return ident


def rename(data_dir: Path, current: Identity, name: str) -> Identity:
    trimmed = name.strip()
    if not trimmed or len(trimmed) > NAME_MAX:
        raise ValueError("bad_name")
    renamed = Identity(serial=current.serial, name=trimmed, created_at=current.created_at)
    _write(_path(data_dir), renamed)
    return renamed
