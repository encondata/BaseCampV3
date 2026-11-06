"""The Dock Station's laptop settings and the clearing of its pass data.

Settings (one `dock_settings` row; none reads as `DEFAULTS`):
- `dry_run`: while on, nothing reaches the portal, no passes and no scans.
  Which reads count as dry run is decided when they are read (`tagreads`
  stamps `raw_tag_reads.dry_run`), so reads taken during dry run are never
  uploaded, not even after it is turned off. On by default.
- `quiet_gap_s`: a pass closes once no new tag has been read for this long.

Pass data is cleared with the alarm tables: on a move change, a change to
another station type or a change to a Dock from another type
(`clear_passes`), and by Clear Setup (`reset`, which drops the settings too).
Wipe empties the same tables itself.

Imports only `edge.db`, so `laptop_setup` and `tagreads` can import it."""

from edge.db import Store

DEFAULTS = {"dry_run": True, "quiet_gap_s": 5}
GAP_RANGE = (1, 60)


def _settings(row) -> dict:
    if row is None:
        return dict(DEFAULTS)
    return {"dry_run": bool(row["dry_run"]), "quiet_gap_s": row["quiet_gap_s"]}


def settings(store: Store) -> dict:
    return _settings(store.one("SELECT dry_run, quiet_gap_s FROM dock_settings WHERE id = 1"))


def settings_in(c) -> dict:
    """The settings, read on an open transaction."""
    return _settings(c.execute(
        "SELECT dry_run, quiet_gap_s FROM dock_settings WHERE id = 1").fetchone())


def dry_run_on(store: Store) -> bool:
    return settings(store)["dry_run"]


def save_settings(store: Store, *, dry_run: bool | None = None,
                  quiet_gap_s: int | None = None) -> dict:
    """Change the given settings, keeping the others; the settings as saved.
    Raises ValueError naming the bad field (nothing is saved)."""
    if dry_run is not None and not isinstance(dry_run, bool):
        raise ValueError("dry_run")
    if quiet_gap_s is not None and (
            not isinstance(quiet_gap_s, int) or isinstance(quiet_gap_s, bool)
            or not GAP_RANGE[0] <= quiet_gap_s <= GAP_RANGE[1]):
        raise ValueError("quiet_gap_s")
    with store.tx() as c:
        saved = settings_in(c)
        if dry_run is not None:
            saved["dry_run"] = dry_run
        if quiet_gap_s is not None:
            saved["quiet_gap_s"] = quiet_gap_s
        c.execute("INSERT INTO dock_settings (id, dry_run, quiet_gap_s) VALUES (1, ?, ?) "
                  "ON CONFLICT (id) DO UPDATE SET dry_run = excluded.dry_run, "
                  "quiet_gap_s = excluded.quiet_gap_s",
                  (int(saved["dry_run"]), saved["quiet_gap_s"]))
    return saved


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
    """Clear Setup: the passes and the settings (back to DEFAULTS)."""
    clear_passes(c)
    c.execute("DELETE FROM dock_settings")
