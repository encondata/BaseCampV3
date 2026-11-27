"""One line on stderr for a problem, never an exception's text (it could quote a request)."""

from __future__ import annotations

import sys
import traceback


def leaf(exc: BaseException) -> BaseException:
    """The first exception inside nested exception groups."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc


def log(what: str, exc: BaseException | None = None) -> None:
    """One line on stderr: never the exception text, which could quote a request."""
    where = ""
    if exc is not None:
        inner = leaf(exc)
        frames = traceback.extract_tb(inner.__traceback__)
        where = f" ({type(inner).__name__} at {frames[-1].filename}:{frames[-1].lineno})" \
            if frames else f" ({type(inner).__name__})"
    print(f"loadtest: {what}{where}", file=sys.stderr)
