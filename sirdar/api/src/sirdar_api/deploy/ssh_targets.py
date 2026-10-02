"""Saved Custom (SSH) targets, kept in deploy-targets.env (dotenv).

Format:
    SIRDAR_SSH_TARGETS='<slug>,<slug>,...'      (order)
    SIRDAR_SSH_<KEY>_NAME / _HOST / _PORT / _USER / _PASSWORD / _KEY_PATH / _KEY_PASSPHRASE

<KEY> is the slug uppercased with "-" -> "_". Values are written single-quoted
('\\'' for an embedded quote); the parser also accepts unquoted and
double-quoted values. The file is re-read on every use. Every write takes an
exclusive flock on <file>.lock and atomically replaces the whole file; lines
that aren't SIRDAR_SSH_* keys (comments included) are kept as they are."""

import fcntl
import ipaddress
import os
import re
import shlex
import tempfile
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path

PREFIX = "SIRDAR_SSH_"
LIST_KEY = "SIRDAR_SSH_TARGETS"
SLUG_MAX = 32
_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
_USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_SUFFIXES = ("NAME", "HOST", "PORT", "USER", "PASSWORD", "KEY_PATH", "KEY_PASSPHRASE")
SECRET_MAX = 1024
# Control characters (Cc: \n \r \t \v \f NUL \x1c-\x1e \x85 ...) and the
# Unicode line/paragraph separators (Zl U+2028, Zp U+2029) are never allowed in
# a value: some of them are line breaks to str.splitlines() or other dotenv
# readers, so letting them through would let one value inject another line.
_BAD_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})


def has_bad_chars(value: str) -> bool:
    return any(unicodedata.category(ch) in _BAD_CATEGORIES for ch in value)


def _lines(text: str) -> list[str]:
    """Split on "\n" only (dropping one trailing "\r" per line) -- never on the
    other characters str.splitlines() treats as line breaks."""
    if not text:
        return []
    parts = text.split("\n")
    if parts[-1] == "":
        parts.pop()
    return [p[:-1] if p.endswith("\r") else p for p in parts]


class TargetError(Exception):
    """A validation failure; `code` is the API error code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SavedSshTarget:
    slug: str
    name: str
    host: str
    port: int
    user: str
    password: str | None = None
    key_path: str = ""
    passphrase: str | None = None

    def __repr__(self) -> str:                 # never print secrets
        return (f"SavedSshTarget(slug={self.slug!r}, name={self.name!r}, host={self.host!r}, "
                f"port={self.port}, user={self.user!r}, key_path={self.key_path!r}, "
                f"password_set={self.password is not None}, "
                f"passphrase_set={self.passphrase is not None})")

    @property
    def id(self) -> str:
        return f"ssh:{self.slug}"

    @property
    def configured(self) -> bool:
        return bool(self.host and self.user and (self.password is not None or self.key_path))

    def public(self) -> dict:
        """Editable, non-secret fields."""
        return {"slug": self.slug, "name": self.name, "host": self.host, "port": self.port,
                "user": self.user, "key_path": self.key_path or None,
                "password_set": self.password is not None,
                "passphrase_set": self.passphrase is not None}


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    s = s[:SLUG_MAX].strip("-")
    return s or "target"


def key_for(slug: str) -> str:
    return slug.upper().replace("-", "_")


def _unique_slug(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    n = 2
    while True:
        suffix = f"-{n}"
        candidate = base[:SLUG_MAX - len(suffix)].rstrip("-") + suffix
        if candidate not in taken:
            return candidate
        n += 1


def _quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def _unquote(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    try:
        lex = shlex.shlex(raw, posix=True)
        lex.whitespace_split = True
        lex.commenters = ""
        return " ".join(lex)
    except ValueError:                         # unbalanced quotes in a hand edit
        return raw


def _key_of(line: str) -> str | None:
    m = _LINE_RE.match(line)
    return m.group(1) if m else None


def _parse(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in _lines(text):
        m = _LINE_RE.match(line)
        if m:
            values[m.group(1)] = _unquote(m.group(2))
    return values


def _valid_host(host: str) -> bool:
    if "%" in host:                            # no IPv6 zone ids ("fe80::1%eth0")
        return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if not host or len(host) > 253:
        return False
    return all(_LABEL_RE.fullmatch(label) for label in host.split("."))


def valid_key_name(name: str) -> bool:
    return bool(name) and "/" not in name and "\\" not in name and ".." not in name \
        and not name.startswith(".")


class SshTargetStore:
    def __init__(self, path: str | os.PathLike, keys_dir: str | os.PathLike):
        self.path = Path(path)
        self.keys_dir = Path(keys_dir)
        self.lock_path = self.path.with_name(self.path.name + ".lock")

    # ---- reading ---------------------------------------------------------
    def _read_text(self) -> str:
        try:
            return self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    @staticmethod
    def _targets_from(text: str) -> list[SavedSshTarget]:
        v = _parse(text)
        out: list[SavedSshTarget] = []
        seen: set[str] = set()
        for slug in (s.strip() for s in v.get(LIST_KEY, "").split(",")):
            if not slug or slug in seen or len(slug) > SLUG_MAX or not _SLUG_RE.fullmatch(slug):
                continue
            seen.add(slug)
            k = f"{PREFIX}{key_for(slug)}_"
            try:
                port = int(v.get(k + "PORT", "") or 22)
            except ValueError:
                port = 22
            password = v.get(k + "PASSWORD") or None
            passphrase = v.get(k + "KEY_PASSPHRASE") or None
            out.append(SavedSshTarget(
                slug=slug, name=v.get(k + "NAME", "").strip() or slug,
                host=v.get(k + "HOST", "").strip(), port=port,
                user=v.get(k + "USER", "").strip(), password=password,
                key_path=v.get(k + "KEY_PATH", "").strip(), passphrase=passphrase))
        return out

    def load(self) -> list[SavedSshTarget]:
        return self._targets_from(self._read_text())

    def get(self, slug: str) -> SavedSshTarget | None:
        return next((t for t in self.load() if t.slug == slug), None)

    # ---- writing ---------------------------------------------------------
    def add(self, fields: dict) -> SavedSshTarget:
        def mutate(current: list[SavedSshTarget]):
            base = SavedSshTarget(slug="", name="", host="", port=22, user="")
            t = self._apply(base, fields)
            self._validate(t, current)
            t = replace(t, slug=_unique_slug(slugify(t.name), {c.slug for c in current}))
            return [*current, t], t
        return self._write(mutate)

    def update(self, slug: str, fields: dict) -> tuple[SavedSshTarget, SavedSshTarget]:
        """Returns (before, after), both read under the lock."""
        def mutate(current: list[SavedSshTarget]):
            i = next((i for i, c in enumerate(current) if c.slug == slug), None)
            if i is None:
                raise KeyError(slug)
            t = self._apply(current[i], fields)
            self._validate(t, current[:i] + current[i + 1:])
            return [*current[:i], t, *current[i + 1:]], (current[i], t)
        return self._write(mutate)

    def remove(self, slug: str) -> SavedSshTarget:
        def mutate(current: list[SavedSshTarget]):
            gone = next((c for c in current if c.slug == slug), None)
            if gone is None:
                raise KeyError(slug)
            return [c for c in current if c.slug != slug], gone
        return self._write(mutate)

    @staticmethod
    def _apply(t: SavedSshTarget, fields: dict) -> SavedSshTarget:
        """Absent or None = keep; "" clears the optional fields."""
        for key in ("password", "key_passphrase"):
            value = fields.get(key)
            if value is not None and not isinstance(value, str):
                raise ValueError("secret values must be strings")
            if isinstance(value, str) and len(value) > SECRET_MAX:
                raise TargetError("password_too_long" if key == "password"
                                  else "passphrase_too_long")
        for value in fields.values():
            if isinstance(value, str) and has_bad_chars(value):
                raise ValueError("values can't contain control or line-separator characters")
        changes: dict = {}
        for key in ("name", "host", "user"):
            if fields.get(key) is not None:
                changes[key] = str(fields[key]).strip()
        if fields.get("port") is not None:
            changes["port"] = fields["port"]
        if fields.get("key_path") is not None:
            changes["key_path"] = str(fields["key_path"]).strip()
        if fields.get("password") is not None:
            changes["password"] = fields["password"] or None
        if fields.get("key_passphrase") is not None:
            changes["passphrase"] = fields["key_passphrase"] or None
        return replace(t, **changes)

    def _validate(self, t: SavedSshTarget, others: list[SavedSshTarget]) -> None:
        if not 2 <= len(t.name) <= 40:
            raise TargetError("name_invalid")
        if not _valid_host(t.host):
            raise TargetError("host_invalid")
        if isinstance(t.port, bool) or not isinstance(t.port, int) or not 1 <= t.port <= 65535:
            raise TargetError("port_invalid")
        if not _USER_RE.fullmatch(t.user):
            raise TargetError("user_invalid")
        if t.key_path:
            if not valid_key_name(t.key_path):
                raise TargetError("key_file_invalid")
            key = self.keys_dir / t.key_path
            if key.is_symlink():               # must be a real file in deploy-keys
                raise TargetError("key_file_invalid")
            if not key.is_file():
                raise TargetError("key_file_not_found")
        if t.password is None and not t.key_path:
            raise TargetError("auth_required")
        if any(o.name.casefold() == t.name.casefold() for o in others):
            raise TargetError("name_taken")

    def _write(self, mutate):
        fd = os.open(self.lock_path,
                     os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            text = self._read_text()
            targets, result = mutate(self._targets_from(text))
            self._replace_file(self._render(text, targets))
            return result
        finally:
            os.close(fd)                       # closing releases the lock

    @staticmethod
    def _render(old_text: str, targets: list[SavedSshTarget]) -> str:
        block: list[str] = []
        if targets:
            block.append(f"{LIST_KEY}={_quote(','.join(t.slug for t in targets))}")
            for t in targets:
                k = f"{PREFIX}{key_for(t.slug)}_"
                block += [f"{k}NAME={_quote(t.name)}", f"{k}HOST={_quote(t.host)}",
                          f"{k}PORT={_quote(str(t.port))}", f"{k}USER={_quote(t.user)}"]
                if t.password is not None:
                    block.append(f"{k}PASSWORD={_quote(t.password)}")
                if t.key_path:
                    block.append(f"{k}KEY_PATH={_quote(t.key_path)}")
                if t.passphrase is not None:
                    block.append(f"{k}KEY_PASSPHRASE={_quote(t.passphrase)}")
        for line in block:
            if has_bad_chars(line):
                raise ValueError("values can't contain control or line-separator characters")
        out: list[str] = []
        placed = False
        for line in _lines(old_text):
            key = _key_of(line)
            if key is not None and key.startswith(PREFIX):
                if not placed:                 # our block goes where it was
                    out += block
                    placed = True
                continue
            out.append(line)
        if not placed:
            out += block
        return "\n".join(out) + "\n" if out else ""

    def _replace_file(self, text: str) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.",
                                   suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                os.fchmod(f.fileno(), 0o600)
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
        self._fsync_dir()

    def _fsync_dir(self) -> None:
        """Make the rename durable."""
        try:
            dfd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        except OSError:
            return
        try:
            os.fsync(dfd)
        except OSError:
            pass
        finally:
            os.close(dfd)
