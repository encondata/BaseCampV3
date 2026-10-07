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
_SECRET_HINT = re.compile(r"SECRET|PASSWORD|KEY|TOKEN|DSN|PEPPER|WORDS", re.IGNORECASE)
_LINE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
# A standalone full-line comment — NOT a trailing " # ..." description on a
# KEY=... line (those match _LINE instead, since they start with the key).
_COMMENT = re.compile(r"^\s*#\s?(.*)$")

SENTINEL_PATH = Path(__file__).resolve().parents[1] / "_dev_reload.py"


def has_linebreak(value: str) -> bool:
    """True if value contains any character str.splitlines() (used by
    _parse) would treat as a line break — the full set, not just \\n/\\r,
    so a written value can never become extra physical lines on re-read."""
    return value != "" and value.splitlines() != [value]


def default_env_path() -> Path:
    return _REPO_ROOT / ".env"


def default_example_path() -> Path:
    """The template next to the .env being edited. Its keys are the only
    ones the Env tab may ADD to .env."""
    return default_env_path().with_name(".env.example")


def _secret_keys() -> set[str]:
    keys = set()
    for name, field in Settings.model_fields.items():
        if field.annotation is SecretStr:
            keys.add(f"SS_{name.upper()}")
    return keys


def is_hidden(key: str) -> bool:
    return key.upper().startswith(HIDDEN_PREFIXES)


def is_secret(key: str) -> bool:
    return key.upper() in _secret_keys() or bool(_SECRET_HINT.search(key))


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


def _value_token(value: str, has_comment: bool) -> str:
    """Render a value for writing. An EMPTY value followed by a trailing
    comment (`KEY=  # desc`) is misread by python-dotenv / pydantic-
    settings as the comment TEXT (they only strip inline comments after a
    non-empty value), so quote the empty so the parser sees "". Non-empty
    values and comment-less empties need no quoting."""
    if value == "" and has_comment:
        return '""'
    return value


def _split_value_comment(rest: str) -> tuple[str, str]:
    """Split a KEY=rest line's right-hand side on the first " #" into
    (value, description). The description is the raw comment text with
    the leading "#" and its surrounding whitespace trimmed; inner
    spacing is left alone. No " #" -> description is "". An empty-quote
    token (`""`/`''`, the form we write for empty+comment) unwraps to ""
    so it round-trips for display/edit."""
    value, sep, comment = rest.partition(" #")
    if not sep:
        value, comment = value, ""
    else:
        value, comment = value.rstrip(), comment.lstrip()
    if value in ('""', "''"):
        value = ""
    return value, comment


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


def _missing_entries(
    env_path: Path, example_path: Path | None,
) -> list[dict]:
    """Allowed additions, with the raw example value (internal — the
    public read_missing drops it for secrets). One per key that
    `example_path` defines, `env_path` lacks, and is not hidden, in
    example order. No example file -> []."""
    if example_path is None or not example_path.is_file():
        return []
    _lines, env_index, _sections = _parse(env_path)
    lines, index, sections = _parse(example_path)
    out = []
    for key, i in index.items():
        if key in env_index or is_hidden(key):
            continue
        rest = _LINE.match(lines[i]).group(2)
        value, description = _split_value_comment(rest)
        out.append({"key": key, "secret": is_secret(key),
                    "section": sections.get(key, ""),
                    "description": description, "_value": value})
    return out


def read_missing(env_path: Path, example_path: Path) -> list[dict]:
    """Settings `.env.example` defines but `.env` lacks (hidden keys
    excluded), in example order. A secret's example value is never
    returned."""
    out = []
    for item in _missing_entries(env_path, example_path):
        entry = {"key": item["key"], "secret": item["secret"],
                 "section": item["section"],
                 "description": item["description"]}
        if not item["secret"]:
            entry["example"] = item["_value"]
        out.append(entry)
    return out


class EnvUpdateError(Exception):
    def __init__(self, unknown: list[str]) -> None:
        super().__init__(f"invalid env keys: {unknown}")
        self.unknown = unknown


def apply_updates(
    path: Path, values: dict[str, str],
    descriptions: dict[str, str] | None = None,
    *, example_path: Path | None = None,
) -> list[str]:
    """Apply updates; returns the changed keys (added keys included)."""
    return apply_updates_detailed(
        path, values, descriptions, example_path=example_path)[0]


def apply_updates_detailed(
    path: Path, values: dict[str, str],
    descriptions: dict[str, str] | None = None,
    *, example_path: Path | None = None,
) -> tuple[list[str], list[str]]:
    """Like apply_updates, but returns (changed, added). `added` is the
    subset of `changed` appended to .env because `example_path` defines
    them and .env lacked them; with no example_path nothing can be added.
    Added keys go at the end under a `# {section}` heading, one per
    section, in example order."""
    descriptions = descriptions or {}
    lines, index, _sections = _parse(path)
    missing = {m["key"]: m for m in _missing_entries(path, example_path)}
    unknown = [k for k in values if (k not in index and k not in missing)
               or is_hidden(k)]
    unknown += [k for k in descriptions if k not in index or is_hidden(k)]
    if unknown:
        raise EnvUpdateError(sorted(set(unknown)))

    # Defense-in-depth: a value containing any line-break character (as
    # defined by str.splitlines(), not just \n/\r) would splice a new
    # physical line into .env on rewrite below, letting a value smuggle in
    # an arbitrary extra KEY=... line (e.g. a hidden SS_DATABASE_URL) past
    # the classification gate. The route also rejects this before calling
    # in; guard here too so this function stays safe to call directly.
    # Descriptions get the same guard — they land in the same trailing-
    # comment slot and could splice a line just as easily.
    invalid = [k for k, v in values.items() if has_linebreak(v)]
    invalid += [k for k, v in descriptions.items() if has_linebreak(v)]
    if invalid:
        raise EnvUpdateError(sorted(set(invalid)))

    changed: set[str] = set()
    added: list[str] = []
    for key, new_value in values.items():
        if is_secret(key) and new_value == "":
            continue                       # keep the stored secret
        if key in missing:
            added.append(key)
            continue
        i = index[key]
        rest = _LINE.match(lines[i]).group(2)
        current, _description = _split_value_comment(rest)
        if current == new_value:
            continue
        _value, sep, comment = rest.partition(" #")
        if sep:
            # preserve the original raw comment text verbatim, always
            # with exactly two spaces before "#"
            lines[i] = f"{key}={_value_token(new_value, True)}  #{comment}"
        else:
            lines[i] = f"{key}={new_value}"
        changed.add(key)

    for key, new_description in descriptions.items():
        i = index[key]
        rest = _LINE.match(lines[i]).group(2)
        current_value, current_description = _split_value_comment(rest)
        if current_description == new_description:
            continue
        if new_description == "":
            lines[i] = f"{key}={current_value}"
        else:
            lines[i] = (f"{key}={_value_token(current_value, True)}"
                        f"  # {new_description}")
        changed.add(key)

    # Appended after the in-place edits, in example order, so existing
    # lines never move. One "# section" heading per section per save.
    groups: dict[str, list[dict]] = {}
    for key, m in missing.items():
        if key in added:
            groups.setdefault(m["section"], []).append(m)
    for section, items in groups.items():
        if lines and lines[-1].strip() != "":
            lines.append("")
        if section:
            lines.append(f"# {section}")
        for m in items:
            # same rendering as an in-place edit of a comment-less line
            lines.append(
                f"{m['key']}={_value_token(values[m['key']], False)}")
    changed |= set(added)

    changed = sorted(changed)
    added = sorted(added)
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
    return changed, added


def touch_sentinel() -> None:
    stamp = datetime.now(UTC).isoformat()
    SENTINEL_PATH.write_text(
        '"""Dev restart sentinel. POST /system/env/restart rewrites this '
        "file so\nevery --reload process (uvicorn, watchfiles workers) "
        "restarts and\nre-reads .env. The content is meaningless; the "
        'mtime/content change is\nthe signal."""\n\n'
        f'_TOUCHED = "{stamp}"\n')
