"""The whitelist of keys `PATCH /wiki/spaces/{key}` may write into a
space's `settings` JSONB. Keeping the validation table in one place
means Phase 2's knobs (readers_can_comment, require_approval,
review_interval_months, allow_public_links) get added here and nowhere
else. Phase 1 defines none — any key in a PATCH's `settings` is
rejected (422 `bad_setting`)."""

ALLOWED: dict[str, type] = {}
