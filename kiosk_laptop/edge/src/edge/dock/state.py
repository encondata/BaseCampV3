"""The Dock Station's window and the clearing of its pass data.

`WINDOW_S` is the Window W, fixed at 5 seconds: an asset packs into a crate
when one of its reads is within W of the crate tag's first read, and crates
whose first reads are within 2W are flagged together (`edge.dock.grouper`).
The Dock has no settings: no dry run (every crate packs and the reads go up
as scans) and no configurable window. The `dock_settings` table and the
`dry_run` columns stay in the schema for laptops upgraded from a build that
had them: nothing reads that table any more, and a read stamped
`raw_tag_reads.dry_run = 1` back then still never uploads, so its pass still
reads "Would pack". Nothing new is ever stamped.

Pass data is cleared with the alarm tables: on a move change, a change to
another station type or a change to a Dock from another type
(`clear_passes`), and by Clear Setup (`reset`, which drops any legacy
settings row too). Wipe empties the same tables itself.

Imports nothing from `edge`, so `laptop_setup` can import it."""

WINDOW_S = 5


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
    """Clear Setup: the passes and any legacy settings row."""
    clear_passes(c)
    c.execute("DELETE FROM dock_settings")
