"""Size caps shared by the pure plan layers and the API schemas, kept here
so the calendar does not import the pydantic layer for one number."""

MAX_RESTORE_ROWS = 20_000   # rows in each list of one restore op; exceptions in a calendar
