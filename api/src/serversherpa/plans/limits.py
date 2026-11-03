"""Size caps shared by the pure plan layers and the API schemas, kept here
so the calendar does not import the pydantic layer for one number."""

MAX_RESTORE_ROWS = 20_000   # rows in each list of one restore op; exceptions in a calendar

# The deepest outline level a task may sit at (1 is the top). Microsoft
# documents 10 hierarchy levels for Project for the web and Project
# Operations; desktop Project documents 65,535. Ten keeps every outline
# walk, WBS number and indent shallow, and is what the ops (add, indent,
# move), templates and imports hold to.
MAX_OUTLINE_LEVEL = 10
