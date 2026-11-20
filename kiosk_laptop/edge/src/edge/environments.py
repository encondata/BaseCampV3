"""The named environments a kiosk can pick: the built-in list, the published
list at status.serversherpa.com and the cached copy of its last good download.

Order of preference: a fresh download, then the last good download, then the
built-in list. The download is https only, follows no redirects, sends no
cookies or credentials, times out after 5 s and is capped at 64 KB."""

import asyncio
import json
import os
import re
from dataclasses import dataclass
from http.cookiejar import DefaultCookiePolicy
from pathlib import Path

import httpx

STATUS_LIST_URL = "https://status.serversherpa.com/environments.json"
CACHE_FILE = "environments-cache.json"
MAX_BYTES = 64 * 1024
TOTAL_TIMEOUT = 5.0  # the whole download, not each read
ROOT_DOMAIN = "serversherpa.com"

_ID = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_DOMAIN = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*serversherpa\.com$")


@dataclass(frozen=True)
class Env:
    id: str
    name: str
    domain: str

    @property
    def api_url(self) -> str:
        return f"https://api.{self.domain}"

    @property
    def portal_url(self) -> str:
        return f"https://portal.{self.domain}"

    @property
    def is_prod(self) -> bool:
        return self.domain == ROOT_DOMAIN


BUILT_IN: tuple[Env, ...] = (
    Env("prod", "Prod", ROOT_DOMAIN),
    Env("rc1", "RC1", f"rc1.{ROOT_DOMAIN}"),
    Env("uat", "UAT", f"uat.{ROOT_DOMAIN}"),
    Env("beta", "Beta", f"beta.{ROOT_DOMAIN}"),
    Env("alpha", "Alpha", f"alpha.{ROOT_DOMAIN}"),
    Env("dev", "Dev", f"dev.{ROOT_DOMAIN}"),
)


def parse_list(raw: bytes) -> list[Env] | None:
    """The valid entries of a downloaded list in file order, or None when the
    file is unusable (too big, not JSON, wrong version, no valid entry)."""
    if len(raw) > MAX_BYTES:
        return None
    try:
        doc = json.loads(raw)
    except (ValueError, RecursionError):
        # deep nesting well under the size cap blows the parser's stack
        return None
    if not isinstance(doc, dict):
        return None
    version = doc.get("version")
    if type(version) is not int or version != 1:  # 1.0 and true are not 1
        return None
    entries = doc.get("environments")
    if not isinstance(entries, list):
        return None
    out: list[Env] = []
    seen: set[str] = set()
    for item in entries:
        env = to_env(item)
        if env is None or env.id in seen:
            continue
        seen.add(env.id)
        out.append(env)
    return out or None


def to_env(item: object) -> Env | None:
    """One list entry (or a saved named environment) as an Env, or None when
    its id, name or domain breaks the rules."""
    if not isinstance(item, dict):
        return None
    env_id, name, domain = item.get("id"), item.get("name"), item.get("domain")
    if not (isinstance(env_id, str) and isinstance(name, str) and isinstance(domain, str)):
        return None
    if not _ID.fullmatch(env_id) or env_id.endswith("-"):
        return None
    if not name.strip() or not _DOMAIN.fullmatch(domain):
        return None
    return Env(env_id, name.strip(), domain)


class ListSource:
    def __init__(self, data_dir: Path, *, transport=None) -> None:
        self._cache = data_dir / CACHE_FILE
        self.client = httpx.AsyncClient(follow_redirects=False, timeout=5.0, transport=transport)
        # the list is public: never send or keep a cookie
        self.client.cookies.jar.set_policy(DefaultCookiePolicy(allowed_domains=[]))

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _download(self) -> bytes | None:
        # httpx's timeout is per phase; a server that drips bytes would hold
        # the download open far longer, so bound the whole thing
        try:
            async with asyncio.timeout(TOTAL_TIMEOUT):
                return await self._fetch()
        except TimeoutError:
            return None

    async def _fetch(self) -> bytes | None:
        try:
            async with self.client.stream("GET", STATUS_LIST_URL) as resp:
                if resp.status_code != 200:
                    return None
                out = bytearray()
                async for chunk in resp.aiter_bytes():
                    out += chunk
                    if len(out) > MAX_BYTES:
                        return None
                return bytes(out)
        except httpx.HTTPError:
            return None

    def _save(self, raw: bytes) -> None:
        tmp = self._cache.with_suffix(".json.tmp")
        try:
            tmp.write_bytes(raw)
            os.replace(tmp, self._cache)
        except OSError:
            pass  # the cache is a convenience; a full disk must not break the chooser

    async def current(self) -> tuple[list[Env], str]:
        raw = await self._download()
        envs = parse_list(raw) if raw is not None else None
        if envs is not None:
            self._save(raw)
            return envs, "fresh"
        try:
            saved = parse_list(self._cache.read_bytes())
        except OSError:
            saved = None
        if saved is not None:
            return saved, "saved"
        return list(BUILT_IN), "built_in"
