"""Replace every known secret value in text with [redacted] before it is
stored or shown. Values shorter than MIN_SECRET_LENGTH are left alone:
they would blank out ordinary words."""

import re
from collections.abc import Iterable

REDACTED = "[redacted]"
MIN_SECRET_LENGTH = 4


class Redactor:
    def __init__(self, secrets: Iterable[str | None]):
        values = {s for s in secrets if s and len(s) >= MIN_SECRET_LENGTH}
        # Longest first, so a secret that contains another is replaced whole.
        ordered = sorted(values, key=len, reverse=True)
        self._pattern = re.compile("|".join(map(re.escape, ordered))) if ordered else None

    def __call__(self, text: str) -> str:
        return self._pattern.sub(REDACTED, text) if self._pattern else text
