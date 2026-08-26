""".env reader/writer for the System Config ENV tab.

Classification: HIDDEN keys (DB/Spaces + compose companions) never leave
the server; SECRET keys (Settings SecretStr fields + a name heuristic)
are masked and keep-on-empty; the rest are plain. Rewrites are atomic
and byte-preserve comments, order, and untouched lines."""

import contextlib
import os
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from pydantic import SecretStr

from serversherpa.config import _REPO_ROOT, Settings

HIDDEN_PREFIXES = ("SS_DATABASE_", "SS_SPACES_", "POSTGRES_", "MINIO_")
_SECRET_HINT = re.compile(r"SECRET|PASSWORD|KEY|TOKEN|DSN|PEPPER|WORDS")
_LINE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

SENTINEL_PATH = Path(__file__).resolve().parents[1] / "_dev_reload.py"


def default_env_path() -> Path:
    return _REPO_ROOT / ".env"


def _secret_keys() -> set[str]:
    keys = set()
    for name, field in Settings.model_fields.items():
        if field.annotation is SecretStr:
            keys.add(f"SS_{name.upper()}")
    return keys


def is_hidden(key: str) -> bool:
    return key.startswith(HIDDEN_PREFIXES)


def is_secret(key: str) -> bool:
    return key in _secret_keys() or bool(_SECRET_HINT.search(key))


def _parse(path: Path) -> tuple[list[str], dict[str, int]]:
    """(raw lines, key -> line index) — comments/blank lines untouched."""
    lines = path.read_text().splitlines()
    index: dict[str, int] = {}
    for i, line in enumerate(lines):
        match = _LINE.match(line)
        if match:
            index[match.group(1)] = i
    return lines, index


def read_entries(path: Path) -> list[dict]:
    lines, index = _parse(path)
    entries = []
    for key, i in index.items():
        if is_hidden(key):
            continue
        value = _LINE.match(lines[i]).group(2)
        if is_secret(key):
            entries.append({"key": key, "secret": True,
                            "set": value != ""})
        else:
            entries.append({"key": key, "secret": False, "value": value})
    return entries


class EnvUpdateError(Exception):
    def __init__(self, unknown: list[str]) -> None:
        super().__init__(f"invalid env keys: {unknown}")
        self.unknown = unknown


def apply_updates(path: Path, values: dict[str, str]) -> list[str]:
    lines, index = _parse(path)
    unknown = [k for k in values
               if k not in index or is_hidden(k)]
    if unknown:
        raise EnvUpdateError(sorted(unknown))

    changed: list[str] = []
    for key, new_value in values.items():
        if is_secret(key) and new_value == "":
            continue                       # keep the stored secret
        i = index[key]
        current = _LINE.match(lines[i]).group(2)
        if current == new_value:
            continue
        lines[i] = f"{key}={new_value}"
        changed.append(key)

    if changed:
        shutil.copy2(path, path.with_suffix(".bak"))
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".env.tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                fh.write("\n".join(lines) + "\n")
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    return changed


def touch_sentinel() -> None:
    stamp = datetime.now(UTC).isoformat()
    SENTINEL_PATH.write_text(
        '"""Dev restart sentinel. POST /system/env/restart rewrites this '
        "file so\nevery --reload process (uvicorn, watchfiles workers) "
        "restarts and\nre-reads .env. The content is meaningless; the "
        'mtime/content change is\nthe signal."""\n\n'
        f'_TOUCHED = "{stamp}"\n')
