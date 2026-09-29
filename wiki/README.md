# ServerSherpa wiki

A wiki portal for everyone who can sign in to ServerSherpa (staff, clients,
partners, workers) — libraries with their own members and levels, folders
and pages with a live co-editing block editor, file uploads with previews and
versions, `.docx`/`.md` import, version history, and search across pages
and file contents. Sign-in is the portal's own login page and session, so
signing out of either signs out of both.

**Libraries vs. spaces.** People see "library" and "libraries" everywhere in
the UI (and at `/library/<key>`); the code, the API (`/wiki/spaces`,
`space_key`, `space_id`), the database and settings keys still say "space".
They're the same thing — only the word on screen changed. Old
`/s/<key>…`, `/trash/<key>` and `/spaces/new` links redirect.

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
  reminders. `wiki/docker-compose.yml` runs this image twice so a long
  export never holds up everyone else's previews and search text:
  `wiki-worker` (`--exclude-kinds export`) and `wiki-export-worker`
  (`--kinds export`). Without either option one worker handles every
  kind (development's `Procfile.dev` does), and it still claims any
  other due job before an export. The daily reminders/retention jobs are
  scheduled only by a worker that handles them, and the hourly trash
  sweep only by one that handles `purge`. Replicas of either are safe —
  jobs are claimed with `FOR UPDATE SKIP LOCKED`.

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
`wiki/.env.example` for the full list. **`SS_WIKI_ORIGIN` is required
there too**, set to exactly the API's value: the workers build the links
in export-ready/failed and review-reminder notifications from it, and
left at its default they all point at `http://localhost:5176`
(`wiki/docker-compose.yml` refuses to start without it).

**On the main API**, the wiki adds these `SS_`-prefixed settings
(`api/src/serversherpa/config.py`):

| Variable | Default | Meaning |
|---|---|---|
| `SS_WIKI_ORIGIN` | `http://localhost:5176` | Used in notification, help, and share links. |
| `SS_WIKI_SERVICE_TOKEN` | *(empty = `/wiki/internal/*` disabled)* | Shared with the wiki server. |
| `SS_WIKI_MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Cap on a single file upload. |
| `SS_WIKI_TRASH_DAYS` | `30` | Days a soft-deleted node stays restorable before the purge job drops it. |

**On the wiki worker** (`wiki/.env`), exports are also capped, and the
worker needs to reach the wiki service itself for `POST /internal/render`
(a page's JSON -> the HTML a PDF/Word export renders — see Exports below):

| Variable | Default | Meaning |
|---|---|---|
| `SS_WIKI_ORIGIN` | `http://localhost:5176` | **Required** — the wiki's public origin, equal to the API's. Links in the notifications the workers send (export ready/failed, review reminders). |
| `SS_WIKI_EXPORT_MAX_PAGES` | `1000` | Most pages one export may hold. |
| `SS_WIKI_EXPORT_MAX_BYTES` | `2147483648` (2 GiB) | Most bytes of files and page images one export may hold. |
| `SS_WIKI_RENDER_URL` | `http://localhost:5177` | The wiki service's own origin. `wiki/docker-compose.yml` sets this to `http://wiki:8080` (the compose network's service name) for you; only change it if you run the worker outside that compose file. Unreachable (or pointed nowhere real) and every PDF/Word export fails with a retried `RenderError`. |
| `SS_WIKI_SERVICE_TOKEN` | *(empty)* | The same secret the wiki service checks `/internal/render` requests against (its `WIKI_SERVICE_TOKEN`) — the worker presents this as `X-Wiki-Service-Token`. All three (the API's, the wiki service's `WIKI_SERVICE_TOKEN`, and this one) must be equal. `wiki/docker-compose.yml` sets it from `WIKI_SERVICE_TOKEN` in `wiki/.env` for you. |
| `WIKI_EXPORT_PDF_MAX_MEMORY_MB` | `2048` | **Not** `SS_`-prefixed — read straight from the environment by the WeasyPrint child process (`serversherpa.wiki.export_pdf`), not through `Settings`, since it's a standalone subprocess entry point. Caps that process's own memory (`RLIMIT_AS`) so one pathological page's conversion is killed rather than left to slowly exhaust the host. Best-effort: there's no `resource` module on Windows, and even on Linux/macOS the platform may not honor it (macOS in particular often doesn't). |

`SS_WIKI_TRASH_DAYS` and `SS_WIKI_MAX_UPLOAD_BYTES` must be the same on the
API and in `wiki/.env` (the worker): the API shows each trash batch's
purge date from its own value, but the worker's expiry sweep deletes on
the worker's.

## Collaboration features

Phase 2 added comments, templates, watching, and reviews on top of the
Phase 1 libraries/pages/files foundation. All of it is enforced by the main
API (`api/src/serversherpa/wiki/`); the `wiki` SPA is just the client.

- **Comments and @mentions.** Threaded, page-anchored comments
  (`readers_can_comment` in a library's settings controls whether a viewer,
  not just an editor, can post — see below). A comment body is plain
  text plus the ids of the people it @mentions; only people who can
  already view the page can be mentioned, so mentioning someone with no
  access to the library silently drops them rather than granting access.
  Mentions, comments, and everything else in this section land in the
  same portal inbox as the rest of ServerSherpa's notifications — there
  is no separate wiki inbox. Each notification's link is the absolute
  wiki URL of the node (and `#comment-<id>` for a comment), so opening
  it from the portal inbox lands on the wiki, not the portal.
- **Templates.** "New page" offers Blank plus a set of templates: four
  seeded builtins (SOP, How-to guide, Troubleshooting, Meeting notes),
  any other global templates, and the current library's own — in that
  order. A page can be saved as a new template from its current content.
  Builtins are read-only for everyone, including a wiki administrator.
  A library template can be added, changed, or removed by anyone with
  manage on that library; a non-builtin global template needs wiki
  administrator rights.
- **Watching.** Creating a page or folder, or publishing a page,
  auto-watches it for the actor (an existing watch is left alone).
  Watching a folder or a library also covers everything under it.
  Watchers get a `wiki_update` notification on publish and on new
  content appearing under something they watch — always narrowed to
  people who can currently view the node, and a reader never sees a
  page that's never been published.
- **Reviews and approvals.** Each library has three settings (`PATCH
  /wiki/spaces/{key}`, manage level): `readers_can_comment` (default on),
  `require_approval` (default off — when on, only a manager can publish
  a page directly; anyone else submits their draft for review), and
  `review_interval_months` (default off; a page can also set its own
  interval, overriding the library's). Submitting a page for review
  notifies its approvers (everyone holding manage on the page); an
  approval publishes the submitted snapshot and starts the next review
  period, a rejection sends the requester a note. Once a review interval
  applies, the **wiki-worker must be running** — it queues a daily
  `reminders` job that backfills `next_review_at` for pages affected by
  an interval change at the library level, and sends the page's owner (or
  its last publisher, if it has no owner) a `wiki_review_due`
  notification once per due date. Without the worker, reviews still get
  requested and decided, but nothing ever reminds an owner that a page's
  review has come due.

## Phase 3 features

Same rule as above: all of it is enforced by the main API
(`api/src/serversherpa/wiki/`), the `wiki` SPA and server are just the
client and renderer.

- **Public share links.** Manage on a page or file — and the library's
  `allow_public_links` setting (`PATCH /wiki/spaces/{key}`, manage level;
  off by default) — lets anyone create a link that needs no sign-in
  (`POST /wiki/nodes/{id}/share-links`). Its token (32 random bytes) is
  returned once, in the URL `{wiki_origin}/p/{token}`; only its sha256
  hash is ever stored, so it can't be shown again, only revoked. The
  unauthenticated read (`GET /wiki/public/{token}`,
  `serversherpa.wiki.share_links` + `api/routes/wiki/public.py`) serves a
  page's PUBLISHED content only — no comment anchors, no links into the
  rest of the wiki, no person ids — or a file's current version; it's
  rate-limited per client address and answers every failure the same way
  (unknown, revoked or expired token; the library's public links off; the
  node deleted; a page never published) with a 404 that never says which.
  Its presigned asset/download URLs live at most 10 minutes, and every
  answer (200, 404 or 429) is `Cache-Control: no-store`. The public page's
  images, video, PDF preview and Download are plain `<img>`/`<video>`/
  `<iframe>` loads and navigations, not CORS requests, so share links need
  no bucket CORS rule of their own.
  **Behavior to know:** a link isn't re-checked against its creator's
  current rights — it stays live until it expires or is revoked, even if
  the page's permissions are tightened later. Restoring a trashed page, or
  turning a library's public links back on, brings back every un-revoked
  link to it. An archived library keeps serving its links until a wiki
  administrator (or the link's creator) revokes them. Public pages keep
  @mention names (never person ids). View counts are approximate: the
  page's own URL refreshes (`?refresh=1`) aren't counted.
- **Help links.** The "?" button in the portal's top bar
  (`portal/src/components/HelpButton.tsx`, over the React-free
  `portal/src/lib/wikiHelp.ts`) asks `GET /wiki/help?context=` for a
  guide. **The kiosk has no help button yet**: a kiosk sign-in skips 2FA,
  so its session is route-scoped to `/kiosk/*` and the sign-in lifecycle
  and is refused (403 `kiosk_session`) on every `/wiki/*` route — it
  could neither look a guide up nor open one in the wiki. `kiosk:`
  contexts are still valid, so wiki administrators can link guides for
  kiosk screens ahead of a kiosk-safe way to show them. A
  context names a screen as `<app>:<path>` (`portal:/bulk/time`,
  `kiosk:/enroll`), normalized on both ends the same way
  (`serversherpa.wiki.help.normalize_context`): lowercased, query/hash
  dropped, repeated slashes collapsed, and every id-shaped path segment
  (a UUID or all digits) replaced with `:id` — so `portal:/sites/<uuid>/`
  and a stored `portal:/sites/:id` are the same context. A lookup matches
  the *longest* stored context that covers the requested one
  (`portal:/bulk` covers `portal:/bulk/time` but not `portal:/bulkx`),
  skipping any guide the caller can't currently view, and 404s when none
  qualifies. On a 404, the button instead opens
  `{wiki_origin}/admin/help-links?context=<context>` — the wiki's Help
  links page, wiki administrators only — with "Link a guide" pre-filled
  for exactly that context, so fixing a missing guide is one click from
  wherever it was missing. Links themselves are managed at
  `GET/POST/PATCH/DELETE /wiki/help-links` (wiki administrators).
- **Analytics.** `GET /wiki/analytics` (wiki administrators, and library
  managers scoped to their own libraries) shows total page/file views and a
  daily breakdown over a chosen window (7/30/90/365 days), the most-viewed
  pages, searches that found nothing, published pages untouched for 12
  months, and overdue periodic reviews. None of it is audited (it's telemetry,
  not a tracked change) and every aggregate only ever names nodes the
  caller can currently see. **Retention** (the worker's daily `retention`
  job): page views are kept 365 days, search log rows 90 days
  (`wiki.analytics.purge_old_views`/`purge_old_searches`) — see Exports
  below for what else that same daily sweep purges.

## Exports

`POST /wiki/exports` (spec §8) queues a page as PDF, Word (`.docx`) or
Markdown, or a folder or whole library as a `.zip`, run by the wiki worker
as the person who asked — only what they can currently view goes in; a
never-published page an editor can see is named in `_skipped.txt` inside
the zip rather than included. PDF and Word pages go through the wiki
service's `POST /internal/render` (the print template, `wiki/export_html.py`)
and then WeasyPrint, run in a child process of its own
(`python -m serversherpa.wiki.export_pdf`) so the worker can time one
pathological page out and kill it instead of hanging; Word (and a zip of
Word pages) goes through LibreOffice; a Markdown zip's images are written
into an `assets/` folder. `GET /wiki/exports/{job_id}` reports progress to
the requester (and only them) with a fresh 10-minute download URL once
it's done.

- **Limits.** An export over `SS_WIKI_EXPORT_MAX_PAGES` pages, or whose
  files and page images add up to more than `SS_WIKI_EXPORT_MAX_BYTES`,
  fails immediately with a message saying which limit and by how much. A
  person may have at most 3 exports queued or running at once. The
  WeasyPrint child's own memory is capped separately by
  `WIKI_EXPORT_PDF_MAX_MEMORY_MB` (see Environment variables above).
- **Requirements.** The `wiki-worker` image needs:
  - **WeasyPrint's native libraries** — `Dockerfile.worker` already
    installs `libpango-1.0-0` and `libpangoft2-1.0-0` (plus
    `fonts-dejavu`); this was verified by building the image and, inside
    it, both `python -c "import weasyprint"` and a real
    `HTML(string=...).write_pdf()` render of text plus an embedded image
    (WeasyPrint 70 draws its own PDFs and decodes raster images through
    Pillow, both already installed as Python dependencies — it no longer
    needs cairo or gdk-pixbuf the way older versions did).
  - **LibreOffice** (`libreoffice-writer`/`-calc`/`-impress`, already
    installed) for `.docx` conversion, and **poppler** (`poppler-utils`,
    already installed) for the file-preview/search-text side of the same
    image.
  - **`SS_WIKI_RENDER_URL`** pointing at the wiki service itself — see
    the environment variable table above; `wiki/docker-compose.yml` wires
    this (and the matching `SS_WIKI_SERVICE_TOKEN`) up for you.
  - Fonts: the print template's CSS asks for the portal's own typefaces
    (Geologica, Fragment Mono) with generic fallbacks (`Helvetica
    Neue`/Helvetica/Arial/sans-serif and Menlo/Consolas/`Courier
    New`/monospace). The image installs only `fonts-dejavu`, so an export
    actually renders in DejaVu Sans/DejaVu Sans Mono today, not the
    portal's fonts — install the real font files in the image if
    pixel-exact export typography ever matters.
- **Retention.** Export output lives at `wiki/exports/<job_id>/<name>` in
  Spaces. The worker's daily `retention` job deletes every object under a
  finished export's `wiki/exports/<job_id>/` prefix — not just the one
  file its result names, so an orphan upload a superseded attempt left
  behind under the same job id is swept up too — 7 days after the job
  finished, along with the job row itself.

## Production checklist

- Add `https://wiki.<domain>` to the main API's `SS_ALLOWED_ORIGINS`.
- Set `SS_WIKI_ORIGIN` to that same URL — on the API **and** in
  `wiki/.env` for the workers (their notification links use it).
- Set `SS_WIKI_SERVICE_TOKEN` on the API and the matching `WIKI_SERVICE_TOKEN`
  on the `wiki` container to the same secret.
- Add a Spaces bucket CORS rule from the wiki origin allowing `PUT` with
  the `Content-Type` header (uploads go straight from the browser to
  Spaces via a presigned URL) **and `GET`** (the file view `fetch()`es
  text and Markdown previews from their presigned URL; without it those
  previews fail. Images, PDF previews, downloads and public share-link
  pages are not CORS reads and work either way).
- Exports need the `wiki-worker` image's WeasyPrint/LibreOffice
  dependencies and `SS_WIKI_RENDER_URL` pointing at the `wiki` container —
  see Exports above; `wiki/docker-compose.yml` already wires this up, so
  there's nothing extra to do when deploying with it.
- Keep both workers running: `wiki-worker` (previews, search text,
  purges, reminders, retention) and `wiki-export-worker` (exports only).
  An export can take many minutes and GBs of memory transiently, so size
  the export worker's container for it; if you run a single worker
  instead, it handles everything but always takes other jobs first.
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
