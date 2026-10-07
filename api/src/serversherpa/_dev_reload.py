"""Dev restart sentinel. POST /system/env/restart rewrites this file so
every --reload process (uvicorn, watchfiles workers) restarts and
re-reads .env. The content is meaningless; the mtime/content change is
the signal."""

_TOUCHED = "2026-10-07T09:47:32.754702+00:00"
