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
# A standalone full-line comment — NOT a trailing " # ..." description on a
# KEY=... line (those match _LINE instead, since they start with the key).
_COMMENT = re.compile(r"^\s*#\s?(.*)$")

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


def _parse(path: Path) -> tuple[list[str], dict[str, int], dict[str, str]]:
    """(raw lines, key -> line index, key -> section) — comments/blank
    lines untouched. `section` is the text of the nearest preceding
    standalone-comment line (leading "#" and one optional space stripped,
    rstripped), or "" if none precedes the key."""
    lines = path.read_text().splitlines()
    index: dict[str, int] = {}
    sections: dict[str, str] = {}
    current_section = ""
    for i, line in enumerate(lines):
        match = _LINE.match(line)
        if match:
            index[match.group(1)] = i
            sections[match.group(1)] = current_section
            continue
        comment = _COMMENT.match(line)
        if comment:
            current_section = comment.group(1).rstrip()
    return lines, index, sections


def _split_value_comment(rest: str) -> tuple[str, str]:
    """Split a KEY=rest line's right-hand side on the first " #" into
    (value, description). The description is the raw comment text with
    the leading "#" and its surrounding whitespace trimmed; inner
    spacing is left alone. No " #" -> description is ""."""
    value, sep, comment = rest.partition(" #")
    if not sep:
        return value, ""
    return value.rstrip(), comment.lstrip()


def read_entries(path: Path) -> list[dict]:
    lines, index, sections = _parse(path)
    entries = []
    for key, i in index.items():
        if is_hidden(key):
            continue
        rest = _LINE.match(lines[i]).group(2)
        value, description = _split_value_comment(rest)
        section = sections.get(key, "")
        if is_secret(key):
            entries.append({"key": key, "secret": True,
                            "set": value != "", "description": description,
                            "section": section})
        else:
            entries.append({"key": key, "secret": False, "value": value,
                            "description": description, "section": section})
    return entries


class EnvUpdateError(Exception):
    def __init__(self, unknown: list[str]) -> None:
        super().__init__(f"invalid env keys: {unknown}")
        self.unknown = unknown


def apply_updates(path: Path, values: dict[str, str]) -> list[str]:
    lines, index, _sections = _parse(path)
    unknown = [k for k in values
               if k not in index or is_hidden(k)]
    if unknown:
        raise EnvUpdateError(sorted(unknown))

    # Defense-in-depth: a value containing a raw newline/carriage-return
    # would splice a new physical line into .env on rewrite below,
    # letting a value smuggle in an arbitrary extra KEY=... line (e.g. a
    # hidden SS_DATABASE_URL) past the classification gate. The route
    # also rejects this before calling in; guard here too so this
    # function stays safe to call directly.
    invalid = [k for k, v in values.items() if "\n" in v or "\r" in v]
    if invalid:
        raise EnvUpdateError(sorted(invalid))

    changed: list[str] = []
    for key, new_value in values.items():
        if is_secret(key) and new_value == "":
            continue                       # keep the stored secret
        i = index[key]
        rest = _LINE.match(lines[i]).group(2)
        current, _description = _split_value_comment(rest)
        if current == new_value:
            continue
        _value, sep, comment = rest.partition(" #")
        if sep:
            # preserve the original raw comment text verbatim, always
            # with exactly two spaces before "#"
            lines[i] = f"{key}={new_value}  #{comment}"
        else:
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
