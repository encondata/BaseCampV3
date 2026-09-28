"""Dev restart sentinel. POST /system/env/restart rewrites this file so
every --reload process (uvicorn, watchfiles workers) restarts and
re-reads .env. The content is meaningless; the mtime/content change is
the signal."""

_TOUCHED = "2026-09-28T21:36:18.985884+00:00"
