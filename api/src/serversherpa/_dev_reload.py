"""Dev restart sentinel. POST /system/env/restart rewrites this file so
every --reload process (uvicorn, watchfiles workers) restarts and
re-reads .env. The content is meaningless; the mtime/content change is
the signal."""

_TOUCHED = "2026-08-26T22:14:31.440457+00:00"
