"""The whitelist of keys `PATCH /wiki/spaces/{key}` may write into a
space's `settings` JSONB, their defaults, and the one place that reads a
setting back out. Keeping the validation table here means Phase 2's
knobs — and Phase 3's `allow_public_links` — get added here and nowhere
else.

`ALLOWED[key]` is either a plain type (checked with `isinstance`) or a
tuple of types where `None` stands for "null is also legal" — see
`review_interval_months`, which is `int | None` in range 1-60."""

ALLOWED: dict[str, type | tuple] = {
    "readers_can_comment": bool,
    "require_approval": bool,
    "review_interval_months": (int, None),
}

DEFAULTS: dict[str, bool | int | None] = {
    "readers_can_comment": True,
    "require_approval": False,
    "review_interval_months": None,
}

REVIEW_INTERVAL_MONTHS_MIN = 1
REVIEW_INTERVAL_MONTHS_MAX = 60


def _type_ok(key: str, value: object) -> bool:
    spec = ALLOWED[key]
    if isinstance(spec, tuple):
        if value is None:
            return None in spec
        types = tuple(t for t in spec if t is not None)
        # bool is technically an int subclass — never let True/False
        # stand in for an int setting.
        return isinstance(value, types) and not isinstance(value, bool)
    if spec is bool:
        return isinstance(value, bool)
    return isinstance(value, spec) and not isinstance(value, bool)


def validate(key: str, value: object) -> bool:
    """True when `value` is a legal value for settings key `key`: the key
    is known, `value` has the right type, and (for
    `review_interval_months`) is in range. Used by `PATCH /wiki/spaces/
    {key}` to reject the whole request with 422 `bad_setting` on any
    failure — unknown key, wrong type, or out of range."""
    if key not in ALLOWED:
        return False
    if not _type_ok(key, value):
        return False
    if key == "review_interval_months" and value is not None:
        return REVIEW_INTERVAL_MONTHS_MIN <= value <= REVIEW_INTERVAL_MONTHS_MAX
    return True


def space_setting(space, key: str):
    """The effective value of `key` for `space`: its stored value, or
    `DEFAULTS[key]` when the space's `settings` doesn't carry it (a space
    created before the key existed, or one that never overrode it)."""
    return (space.settings or {}).get(key, DEFAULTS[key])
