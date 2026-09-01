"""Placeholder tokens: exactly `{key}` with keys ^[a-z0-9_]+$.

The single canonical format — V2's quoted variants ({'x'}, {row['x']})
are deliberately not supported. Unknown tokens resolve to empty string
at substitution time (logged upstream at generation time)."""

import re

TOKEN_RE = re.compile(r"\{([a-z0-9_]+)\}")


def resolve_tokens(value: str, subs: dict[str, str] | None) -> str:
    """None = leave tokens intact (storage form); dict = substitute."""
    if subs is None:
        return value
    return TOKEN_RE.sub(lambda m: subs.get(m.group(1), ""), value)


def apply_placeholders(code: str, values: dict[str, str]) -> str:
    """Raw-code templates: substitute every token; unknown -> ''."""
    return TOKEN_RE.sub(lambda m: values.get(m.group(1), ""), code)
