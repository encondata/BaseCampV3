"""Deploy page, step 1: deployment targets and connection tests.

Nothing in this package may return or log a secret (tokens, passwords,
passphrases, key contents) or a raw library error message."""

from dataclasses import asdict, dataclass, field
from typing import Literal

CheckStatus = Literal["pass", "warn", "fail"]


@dataclass
class Check:
    label: str
    status: CheckStatus
    value: str


@dataclass
class ConnectResult:
    ok: bool
    target: str
    checks: list[Check] = field(default_factory=list)
    facts: dict = field(default_factory=dict)       # non-secret only

    def as_dict(self) -> dict:
        return asdict(self)


class ConnectFailed(Exception):
    """The test couldn't connect. `reason` is user-facing copy we wrote —
    never library error text, which may carry secrets or internals."""

    code = "connect_failed"

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason
