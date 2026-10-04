"""Resolve a git ref to a commit SHA by running `git ls-remote` on the
target: the target is what clones the repo, so its view is the one that
counts. A full 40-hex SHA is used as is (the host key is still checked)."""

import re
import shlex

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.deploy import ConnectFailed, ssh
from sirdar_api.deploy.ssh import SshTargetConfig

LS_REMOTE_TIMEOUT = 60
SHA_RE = re.compile(r"[0-9a-f]{40}")
_ANY_SHA_RE = re.compile(r"[0-9a-fA-F]{40}")
# Branch and tag names: no leading "-", no "..", no shell or space characters.
_REF_RE = re.compile(r"(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}")


class RefError(Exception):
    """`code`: ref_invalid | ref_not_found | git_missing | ref_lookup_failed."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def valid_ref(ref: str) -> bool:
    return bool(_REF_RE.fullmatch(ref)) and not ref.endswith(("/", ".lock"))


def is_full_sha(ref: str) -> bool:
    return bool(_ANY_SHA_RE.fullmatch(ref))


def ls_remote_command(repo_url: str, ref: str) -> str:
    return f"git ls-remote {shlex.quote(repo_url)} {shlex.quote(ref)}"


def pick_sha(output: str, ref: str) -> str | None:
    """The commit for `ref` in ls-remote output: a branch first, then a tag
    (its peeled commit when listed), then an exact name such as HEAD."""
    found: dict[str, str] = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) == 2 and SHA_RE.fullmatch(parts[0]):
            found[parts[1]] = parts[0]
    for name in (f"refs/heads/{ref}", f"refs/tags/{ref}^{{}}", f"refs/tags/{ref}", ref):
        if name in found:
            return found[name]
    return None


async def resolve_ref(cfg: SshTargetConfig, db: AsyncSession, repo_url: str, ref: str) -> str:
    if _ANY_SHA_RE.fullmatch(ref):
        await ssh.pinned_host_key(db, cfg.host, cfg.port)   # same host-key gate as a lookup
        return ref.lower()
    if not valid_ref(ref):
        raise RefError("ref_invalid")
    result = await ssh.run_command(cfg, db, ls_remote_command(repo_url, ref),
                                   timeout=LS_REMOTE_TIMEOUT)
    if result.exit_status is None:
        raise ConnectFailed("The target didn't answer git ls-remote in time.")
    if result.exit_status == 127:
        raise RefError("git_missing")
    if result.exit_status != 0:
        raise RefError("ref_lookup_failed")
    sha = pick_sha(result.stdout, ref)
    if sha is None:
        raise RefError("ref_not_found")
    return sha
