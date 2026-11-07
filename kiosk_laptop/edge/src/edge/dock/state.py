"""The Dock Station's crate window and the clearing of its pass data.

The window W is a laptop setting (`dock_window`, one row; none means
`DEFAULT_WINDOW_S`): an asset packs into a crate when one of its reads is
within W of the crate tag's first read, and crates whose first reads are
within 2W are flagged together (`edge.dock.grouper`). Each burst keeps the W
it opened with (`dock_passes.quiet_gap_s`), so a change applies from the next
burst. An admin sets a whole number of seconds from `ADMIN_MIN_S` to
`ADMIN_MAX_S`, a developer any number above 0 up to `MAX_WINDOW_S`
(`parse_window`, PUT /edge/dock/window). The window survives a move change
and a station type change; Clear Setup (`reset`) and Wipe put it back to the
default.

The Dock has no other settings: no dry run (every crate packs and the reads
go up as scans). The `dock_settings` table and the `dry_run` columns stay in
the schema for laptops upgraded from a build that had them: nothing reads
that table any more (its window never comes back), and a read stamped
`raw_tag_reads.dry_run = 1` back then still never uploads, so its pass still
reads "Would pack". Nothing new is ever stamped.

Pass data is cleared with the alarm tables: on a move change, a change to
another station type or a change to a Dock from another type
(`clear_passes`), and by Clear Setup (`reset`, which drops any legacy
settings row too). Wipe empties the same tables itself.

Imports nothing from `edge`, so `laptop_setup` can import it."""

import math

DEFAULT_WINDOW_S = 5
ADMIN_MIN_S = 1       # an admin's whole seconds, inclusive
ADMIN_MAX_S = 10
MAX_WINDOW_S = 3600   # a developer's ceiling, so a typo can't hold the Dock up for good


def window_s(c) -> float:
    """The saved window W in seconds, or `DEFAULT_WINDOW_S`."""
    row = c.execute("SELECT window_s FROM dock_window WHERE id = 1").fetchone()
    return row["window_s"] if row else DEFAULT_WINDOW_S


def parse_window(value, *, developer: bool) -> float:
    """W as PUT /edge/dock/window sends it, if the caller may set it: a
    developer any number above 0 up to `MAX_WINDOW_S`, anyone else a whole
    number from `ADMIN_MIN_S` to `ADMIN_MAX_S`. Raises ValueError on
    anything else: a bool (an int to Python), a string, null, NaN or
    infinity."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) \
            or isinstance(value, float) and not math.isfinite(value):
        raise ValueError("not a number of seconds")
    if not 0 < value <= MAX_WINDOW_S:
        raise ValueError("out of range")
    if not developer and not (ADMIN_MIN_S <= value <= ADMIN_MAX_S and value == int(value)):
        raise ValueError("not a whole number of seconds in an admin's range")
    return float(value)


def save_window(c, value: float) -> None:
    """Save W (from `parse_window`); the next burst opens with it."""
    c.execute("INSERT INTO dock_window (id, window_s) VALUES (1, ?) "
              "ON CONFLICT (id) DO UPDATE SET window_s = excluded.window_s", (value,))


def clear_passes(c) -> None:
    """Forget every pass, its tags and reads; the grouper starts after the
    newest raw read, so no earlier read lands in a new pass."""
    c.execute("DELETE FROM dock_passes")
    c.execute("DELETE FROM dock_pass_tags")
    c.execute("DELETE FROM dock_pass_reads")
    c.execute("INSERT INTO dock_meta (id, last_raw_id) "
              "VALUES (1, (SELECT COALESCE(MAX(id), 0) FROM raw_tag_reads)) "
              "ON CONFLICT (id) DO UPDATE SET last_raw_id = excluded.last_raw_id")


def reset(c) -> None:
    """Clear Setup: the passes, the window (back to the default) and any
    legacy settings row."""
    clear_passes(c)
    c.execute("DELETE FROM dock_window")
    c.execute("DELETE FROM dock_settings")
