# ServerSherpa wiki

A wiki portal for everyone who can sign in to ServerSherpa (staff, clients,
partners, workers) — spaces with their own members and levels, folders and
pages with a live co-editing block editor, file uploads with previews and
versions, `.docx`/`.md` import, version history, and search across pages
and file contents. Sign-in is the portal's own login page and session, so
signing out of either signs out of both.

It ships as two Docker images, separate from the main API and portal:

- **`wiki`** (`wiki/Dockerfile`) — the SPA (`wiki/web`, React/Vite) served
  by an Express app (`wiki/server`) that also runs `/collab` (a Hocuspocus
  WebSocket for live editing) and `/internal/render` (page JSON -> HTML for
  exports). It holds no database connection and makes no permission
  decisions — every read and write goes through the main API's
  `/wiki/*` and `/wiki/internal/*` routes.
- **`wiki-worker`** (`wiki/Dockerfile.worker`) — `serversherpa wiki-worker`
  from the `api` package, with LibreOffice and poppler installed. It talks
  to Postgres and Spaces directly to build office-file PDF previews,
  extract search text, run exports, purge trash, and send review
  reminders.

```
                    wiki.serversherpa.com                        api.serversherpa.com
 browser ──HTTPS──▶ ┌───────────── wiki image (Node 20) ─────────────┐     ┌──── main API (FastAPI) ────┐
                    │ express: static SPA (wiki/web build)           │     │ /wiki/* REST               │
 browser ──WSS────▶ │ /collab  Hocuspocus (Yjs)  ──service token──▶  │────▶│ /wiki/internal/* (collab)  │
                    │ /internal/render (JSON→HTML, service token)    │◀────│ Postgres (wiki_* tables)   │
                    └─────────────────────────────────────────────────┘     │ Spaces/MinIO (objects)     │
                    ┌──── wiki-worker image (API package + LibreOffice + poppler) ──┐                      │
                    │ serversherpa wiki-worker: previews, text extraction, exports,  │─── DB + S3 ─────────┘
                    │ trash purge, review reminders                                  │
                    └────────────────────────────────────────────────────────────────┘
```

## Development

Three processes, no Docker needed:

```sh
npm --prefix wiki run dev         # wiki SPA — Vite dev server, port 5176 (strictPort)
npm --prefix wiki run dev:server  # collab/render server, port 5177
cd api && serversherpa wiki-worker --reload   # office previews, search text, exports
```

The Vite dev server proxies `/collab` (WebSocket) and `/internal` to port
5177, so the SPA only ever talks to its own origin. `wiki/web/` and
`wiki/server/` are one npm package (`wiki/package.json`) so the shared
editor schema keeps a single copy of `@tiptap/*` and `yjs`.

Run the wiki's own tests with `npm --prefix wiki test`; the worker's tests
are part of the API suite (`api/tests/test_wiki_*.py`).

## Environment variables

**`wiki` (the web/collab image)** — see `wiki/server/src/config.ts`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5177` (dev) / `8080` (image) | HTTP port the server listens on. |
| `WIKI_API_URL` | `http://localhost:8000` | The main API's origin, as the container sees it (not the browser). |
| `WIKI_SERVICE_TOKEN` | *(empty = live editing and `/internal/render` disabled)* | Shared secret for `/wiki/internal/*`; must equal the API's `SS_WIKI_SERVICE_TOKEN`. |
| `WIKI_STATIC_DIR` | `dist` | Where the built SPA lives (the image sets this to `/app/wiki/dist`). |
| `WIKI_REAUTH_MS` | `300000` | How often an open collab connection is re-authorized against the API. |

**`wiki-worker` (the LibreOffice/poppler image)** — reads the same `SS_`
settings as the main API (`api/src/serversherpa/config.py`), because it
talks to the same Postgres and Spaces directly. In practice that means
copying the database and object-storage values (and the auth/crypto ones
the shared settings model requires even though the worker doesn't use
them) from the main API's `.env` into `wiki/.env`. See the comments in
`wiki/.env.example` for the full list.

**On the main API**, the wiki adds these `SS_`-prefixed settings
(`api/src/serversherpa/config.py`):

| Variable | Default | Meaning |
|---|---|---|
| `SS_WIKI_ORIGIN` | `http://localhost:5176` | Used in notification, help, and share links. |
| `SS_WIKI_SERVICE_TOKEN` | *(empty = `/wiki/internal/*` disabled)* | Shared with the wiki server. |
| `SS_WIKI_MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Cap on a single file upload. |
| `SS_WIKI_TRASH_DAYS` | `30` | Days a soft-deleted node stays restorable before the purge job drops it. |

`SS_WIKI_TRASH_DAYS` and `SS_WIKI_MAX_UPLOAD_BYTES` must be the same on the
API and in `wiki/.env` (the worker): the API shows each trash batch's
purge date from its own value, but the worker's expiry sweep deletes on
the worker's.

## Production checklist

- Add `https://wiki.<domain>` to the main API's `SS_ALLOWED_ORIGINS`.
- Set `SS_WIKI_ORIGIN` to that same URL.
- Set `SS_WIKI_SERVICE_TOKEN` on the API and the matching `WIKI_SERVICE_TOKEN`
  on the `wiki` container to the same secret.
- Add a Spaces bucket CORS rule from the wiki origin allowing `PUT` with
  the `Content-Type` header (uploads go straight from the browser to
  Spaces via a presigned URL) **and `GET`** (the file view fetches text
  and Markdown previews from their presigned URL; without it those
  previews fail in production).
- Run exactly **one** `wiki` container. The collab server holds each
  open page in memory and stores it by overwriting the saved document,
  so two replicas (or two overlapping during a rolling deploy) would
  overwrite each other's edits. Stop the old container before starting
  the new one.
- Point the reverse proxy's `wiki.<domain>` host at the `wiki` container
  with WebSockets on (`/collab` needs it).
- Review `SS_WIKI_MAX_UPLOAD_BYTES` for the largest file the wiki should
  accept.

## Ports

| | Dev | Container | Host (compose) |
|---|---|---|---|
| wiki SPA (Vite) | `5176` | — | — |
| wiki server (collab/render) | `5177` | `8080` | `${WIKI_PORT:-8096}` |

## Deploying

```sh
cp wiki/.env.example wiki/.env   # then edit it — see the comments there
docker compose -f wiki/docker-compose.yml --env-file wiki/.env up -d --build
```

Or, on a fresh Docker host, `wiki/install.sh` sparse-checks out `wiki/`,
`api/`, `portal/src`, and `portal/public` into `/opt/serversherpa-wiki`,
writes `wiki/.env` from the example on its first run (and stops there for
you to fill it in), and on every later run pulls the latest code and runs
the `docker compose up -d --build` above. Set `WIKI_BRANCH` to deploy a
different branch than `main`.
