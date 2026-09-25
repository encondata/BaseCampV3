# Wiki — design

Date: 2026-09-25. Branch: `wiki` (worktree `.claude/worktrees/wiki`, off main 39e73527).

Jimmy asked for a wiki portal "using the same sort of separate docker as the status" page: the same
login page and flow as the portal, and behind it a full-featured wiki of documents and self-help
guides — file uploading, online editing, permissions and folders, "just like a real top tier wiki".
He answered the scoping questions and then asked to be hands-off: "use your recommendations if needed
and let me know once you are finished". Everything below marked *(rec)* is a recommendation taken on
his behalf under that instruction.

## Decisions Jimmy made

| Question | Answer |
|---|---|
| Who reads it | Everyone who can sign in to the portal (staff, clients, partners, workers); permissions decide what each sees. |
| Permission model | **Spaces** with their own members and levels, plus **inherited folder/page overrides** inside a space. |
| Editing | Rich-text block editor (Tiptap/ProseMirror), Markdown shortcuts while typing, stored as structured JSON. |
| Uploaded documents | Files are first-class items in folders (own permissions, versions, previews, search) **and** `.docx`/`.md` can be imported as editable pages. |
| Concurrent editing | **Live co-editing** (Yjs over WebSocket, cursors), with a Draft/Published split and full version history. |
| Extra features | **All**: file-content search, comments + @mentions, templates, watching/notifications, reviews/approvals, public share links, portal/kiosk help links, analytics, export. |
| Architecture | **A** — wiki data + REST in the main API; wiki front end, live-editing server and conversion worker in their own Docker images. |

## Phasing *(rec)*

One branch, three phases, each planned, built, reviewed and tested before the next starts.

- **Phase 1 — core:** spaces, folders, pages, files; live editor with Draft/Published; uploads with
  previews and versions; `.docx`/`.md` import; permissions; version history with diffs and restore;
  search including text inside files; trash; favorites and recently updated; Docker + deploy.
- **Phase 2 — collaboration:** comments (inline + page threads) and @mentions, templates,
  watching and notifications, reviews/approvals and periodic review reminders.
- **Phase 3 — reach:** public share links, help links from the portal and kiosk, analytics
  (views, "was this helpful?", failed searches, stale pages), export (PDF, `.docx`, Markdown, folder zip).

## 1. Architecture and deployment

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

- **`wiki/web/`** — the wiki SPA: React 18, Vite 5, TypeScript, vitest 3 (the kiosk's pins: vitest 4
  needs vite 6+). A `@portal` alias reaches `portal/src` like the kiosk and status page. Unlike the
  kiosk, the wiki may import an **allowlisted** set of portal React modules so the sign-in is literally
  the portal's: `auth/AuthContext`, `pages/Login`, `components/totp/*`, `components/SystemBanners`,
  `components/ComboBox`, `components/ToastHost`, plus any React-free `lib/*` and all `styles/*`.
  `wiki/web/src/portalImports.test.ts` enforces the allowlist (kiosk precedent). `resolve.dedupe` keeps
  one React/router/gsap. Dev port **5176** (strictPort, `host: true`, `allowedHosts` like the kiosk,
  `SS_PUBLIC_HTTPS` wss HMR block).
- **`wiki/server/`** — Node 20 + TypeScript: Express serves the built SPA (history fallback to
  `index.html`), `/collab` is a Hocuspocus WebSocket endpoint, `/internal/render` converts page JSON to
  sanitized HTML for exports (service token), `/healthz`. It holds **no database connection and makes
  no permission decisions**: every connection is authorized by the API and every load/store goes
  through `/wiki/internal/*`. Dev port **5177** (the Vite dev server proxies `/collab` to it).
- **Conversion worker** — `serversherpa wiki-worker` in the API package (`serversherpa/wiki/worker.py`),
  same claim/poll pattern as the import worker (`FOR UPDATE SKIP LOCKED` on its own `wiki_jobs` table,
  `requeue_stale`, read-only-mode pause, `--reload`). Procfile.dev gets `wikisvc:`.
- **Docker** — `wiki/Dockerfile` (build context = repo root, like status/kiosk: node:20-alpine builds
  `wiki/web` then runs `wiki/server`), `wiki/Dockerfile.worker` (python:3.13-slim + the `api/` package +
  `libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils fonts-dejavu` — the ~500 MB
  image, kept separate so the web image stays small), `wiki/docker-compose.yml` (services `wiki` on
  `${WIKI_PORT:-8096}:8080` and `wiki-worker`), `wiki/install.sh` (sparse checkout of `wiki/`, `api/`,
  `portal/src` into `/opt/serversherpa-wiki`, first run writes `wiki/.env` and exits, reruns
  update+rebuild; `WIKI_BRANCH` defaults to `main`), `wiki/README.md`.
- **Sign-in** — the portal's `Login` page and `AuthContext`, unchanged. The refresh cookie `ss_refresh`
  is host-only on `api.*` and `wiki.*` is same-site, so a portal session is a wiki session and signing
  out of either signs out of both. `SS_COOKIE_DOMAIN` stays empty. `siblingOrigin('api', …)` already
  finds the API from `wiki.<domain>`.
- **API settings (new, `SS_` prefix):** `wiki_origin` (default `http://localhost:5176`, used for links
  in notifications, help links and share links), `wiki_service_token` (SecretStr shared with the wiki
  server; empty disables `/wiki/internal/*`), `wiki_max_upload_bytes` (default 1 GiB),
  `wiki_trash_days` (30). The wiki origin must be in `SS_ALLOWED_ORIGINS` in production.
- **Wiki server env:** `PORT`, `WIKI_API_URL`, `WIKI_SERVICE_TOKEN`, `WIKI_STATIC_DIR`.
- **Portal:** a "Wiki" item in the sidebar (resource `wiki`) that opens the wiki origin in a new tab
  (`siblingOrigin('wiki', location)` → fallback `http://<host>:5176`). The wiki header has "Back to
  portal" (the same trick with `portal`).
- **Dev:** `.claude/launch.json` gets `wiki` (5176) and `wiki-server` (5177) entries. Nginx Proxy
  Manager needs a `wiki.dev.serversherpa.com` host → 5176 with Websockets on (Jimmy's step; noted in
  the README and the final report).

## 2. Data model

All tables in the main Postgres via Alembic, starting at **0074** (verify the head across worktrees
and the dev DB before numbering). Extensions: `pg_trgm` (new) for fuzzy title search.

**`wiki_spaces`** — `id uuid pk`, `key citext unique` (slug, `^[a-z0-9][a-z0-9-]{1,39}$`), `name`,
`description`, `icon` (text, emoji or icon name), `color`, `home_node_id uuid null` (fk nodes, set
after creation), `settings jsonb not null default '{}'` (phase 2/3 knobs: `readers_can_comment` true,
`require_approval` false, `review_interval_months` null, `allow_public_links` false),
`created_by`, `created_at`, `updated_at`, `archived_at`.

**`wiki_nodes`** — the tree. `id uuid pk`, `space_id fk`, `parent_id uuid null fk self` (null = space
root), `path uuid[] not null` (ancestor ids, root first, excluding self — maintained on create/move;
GIN index; subtree = `path @> ARRAY[:id]`), `kind text check in ('folder','page','file')`, `title text`
(1–200 chars), `position double precision` (sibling order; insert between neighbors, renumber a
sibling set when gaps get too small), `inherit_permissions bool default true`, `owner_id uuid fk
people` (creator; reassignable; phase 2 review reminders go here), `created_by`, `updated_by`,
`created_at`, `updated_at`, `deleted_at`, `deleted_by`, `deleted_batch uuid` (a subtree deleted
together shares one batch id so it restores together), `search_tsv tsvector` (GIN), index
`(space_id, parent_id, position) where deleted_at is null`, trigram index on `title`.
Pages may have child pages and folders (Confluence-style); files are leaves. Title uniqueness is not
enforced (people legitimately repeat "Overview").

**`wiki_pages`** — 1:1 with page nodes. `node_id pk fk`, `ydoc bytea` (live shared draft, Yjs
update), `draft_json jsonb` (ProseMirror JSON of the draft, written by the collab server on every
store), `draft_text text`, `draft_updated_at`, `draft_updated_by`, `published_version_id uuid null`,
`has_unpublished_changes bool` (draft_json ≠ published content, maintained by the API on store and
publish), `last_autosave_version_at`.

**`wiki_page_versions`** — `id`, `node_id`, `version_no int` (per page, 1..n, unique with node_id),
`title`, `content_json jsonb`, `content_text text`, `kind check in ('autosave','published','restored',
'imported')`, `note text` (publish change note), `created_by`, `created_at`. The published content a
reader sees is `wiki_pages.published_version_id`'s row. Autosave versions are snapshotted by the API
on a store when the last autosave version is older than **10 minutes** *(rec)* and the draft changed.

**`wiki_file_versions`** — `id`, `node_id`, `version_no`, `storage_key`, `filename`, `content_type`,
`size_bytes bigint`, `sha256 text null`, `preview_kind check in ('native','pdf','none')`,
`preview_key text null` (converted PDF), `preview_status check in ('pending','ready','failed',
'skipped')`, `text_extract text null`, `extract_status` (same vocabulary), `note`, `uploaded_by`,
`created_at`. `wiki_files(node_id pk, current_version_id, description text)` holds the per-file row.

**`wiki_page_assets`** — images and attachments embedded in a page's body (not tree items):
`id`, `node_id` (the page), `storage_key`, `filename`, `content_type`, `size_bytes`, `uploaded_by`,
`created_at`, `deleted_at`. Readable by anyone who can view the page.

**`wiki_grants`** — one table for space membership and node overrides *(rec)*: `id`, `space_id`,
`node_id uuid null` (null = a space-level grant), `principal_type check in ('everyone','internal',
'role','access_group','person','client','partner')`, `principal_id text null` (role name, or uuid as
text; null for `everyone`/`internal`), `level check in ('view','edit','manage')`, `created_by`,
`created_at`; unique `(space_id, node_id, principal_type, principal_id)` (nulls-not-distinct).

**`wiki_favorites`** — `(person_id, node_id)` pk, `created_at`.

**`wiki_jobs`** — `id`, `kind check in ('file_preview','file_extract','export','purge','reminders')`
(phase 1 uses the first three it needs; later phases add kinds), `node_id null`, `file_version_id
null`, `payload jsonb`, `status check in ('queued','running','done','failed')`, `attempts int`,
`error`, `result jsonb`, `created_by null`, `created_at`, `started_at`, `progress_at`, `finished_at`.

Every create/update/delete/restore/permission change writes `audit(...)` with `entity_type`
`wiki_space` / `wiki_node` / `wiki_grant`.

## 3. Permissions

**Resource `wiki`** in `access/resources.py` (no routes — the wiki is another origin):
- `wiki:view` — can open the wiki at all. Granted to **every role** (developer, founder, super_admin,
  admin, staff, client_*, vendor_*, worker, external) by migration.
- `wiki:add` — can create spaces. Granted to staff and above.
- `wiki:delete` — **wiki administrator**: sees and manages every space and node regardless of grants,
  purges trash, manages global templates and help links. Granted to admin and above.

**Levels** `view < edit < manage`:
- *view* — read published pages, preview/download files, search, favorite (phase 2: comment, watch).
- *edit* — plus create/rename/move within what they can edit, edit drafts live, publish (or submit for
  review in phase 2), upload files and new versions, restore versions, delete to trash.
- *manage* — plus change grants on that subtree, break/restore inheritance, restore from and purge
  the space's trash (space-level manage only), space settings (space-level manage only).

**Principals:** `everyone` (any signed-in user with `wiki:view`), `internal` (users whose
`AccessInfo.is_global` is true), `role` (by name), `access_group`, `person`, `client` (users anchored
to that client via `AccessInfo.client_ids`), `partner` (via `partner_ids`).

**Effective level** of user U on node N (`serversherpa/wiki/permissions.py`):
1. `wiki:delete` holder → `manage` everywhere. No `wiki:view` → nothing.
2. Walk from N up its `path` to the space. Starting set = the space-level grants. For each ancestor
   (root first) then N: if the node has `inherit_permissions = false` the set is **replaced** by that
   node's grants; otherwise the node's grants are **added** to the set.
3. The level is the highest level among grants in the final set that match U. Space-level `manage`
   holders are always added back after a replace (a space manager can never lock themselves out).
4. Archived spaces are read-only (manage → view) for everyone except wiki admins.

Listing/search filters use a per-request **`AccessIndex`**: load the user's matching principals once,
load the (small) grant table rows for the spaces in question plus `(id, parent_id, path,
inherit_permissions)` for nodes that carry grants or break inheritance, and compute levels in Python
with memoization. Every endpoint that returns nodes filters through it; tree listings never reveal a
node the user can't view, and a viewable node under an unviewable parent shows under the nearest
viewable ancestor's breadcrumb as "…". Every write endpoint re-checks the level on the target (and on
the destination for move/copy). A 404 (not 403) is returned for nodes the user can't view, so
existence doesn't leak.

A new space gets: creator → `manage`, and `internal` → `view` by default *(rec)* (the create form
lets the creator change the default to "Only people I add" or "Everyone who can sign in").

## 4. Pages, editor, live editing, versions

**Editor** — Tiptap 2 (ProseMirror) *(rec: Tiptap 2.x, the version Hocuspocus 2 targets)*. Extensions:
StarterKit (history off — Yjs undo instead), Collaboration, CollaborationCursor, Placeholder, Link
(http/https/mailto/tel + internal `wiki:` links only), Underline, Highlight, TextAlign, Subscript,
Superscript, TaskList/TaskItem, Table (+row/header/cell, resizable), CodeBlockLowlight, Typography,
Details (collapsible), **Callout** (custom: info/tip/warning/danger), **WikiImage** (custom: stores
`assetId`, resolves a presigned URL at render; resize handles; alt text; caption), **FileEmbed**
(custom: a card for a wiki file node or page asset with inline preview for PDF/image/video),
**PageLink** (custom inline node: `[[` opens a page/file picker; renders the target's current title,
or "Missing page" if gone or not viewable), **Mention** (phase 2), heading ids for the table of contents.
UI: sticky toolbar, "/" slash menu (all block types), bubble menu on selection, drag handle on
blocks, paste/drop of images and files uploads them as page assets, Markdown input rules and paste.

**Content schema is shared** — `wiki/web/src/editor/schema.ts` defines the extension list used by
the editor, the read-only renderer and the server's `/internal/render` (the server imports the same
file through a relative path compiled by its own tsconfig; a test asserts both produce identical HTML
for a fixture doc). Server-side Python never renders HTML; it only extracts text from JSON
(`serversherpa/wiki/content.py::doc_text(json) -> str`, walks nodes, joins block text with newlines,
includes table cells, callouts, code, image alt/caption, PageLink titles).

**Live editing flow**
1. The editor opens `HocuspocusProvider({ url: <origin>/collab, name: 'page:<nodeId>', token: () =>
   currentAccessToken() })` — the token callback always hands over a fresh portal access token.
2. The wiki server's `onAuthenticate` calls `GET /wiki/internal/collab/authorize?node=<id>` with the
   **user's** bearer token plus the service token header; the API answers `{level, person:{id,name},
   color}` or 401/404. `view` → `connection.readOnly = true`; `edit`/`manage` → read-write; anything
   else rejects the connection. Awareness carries name + color for cursors and the presence stack.
3. `onLoadDocument` → `GET /wiki/internal/pages/<id>/ydoc` (service token) → the stored Yjs update, or
   an empty body for a new page (the server then seeds from `draft_json` if present, e.g. an import).
4. `onStoreDocument` (Hocuspocus debounce 2 s, maxDebounce 10 s) → `PUT /wiki/internal/pages/<id>/ydoc`
   with the Yjs update (binary), the ProseMirror JSON (`TiptapTransformer.fromYdoc`), the title, and
   the ids of the people who edited since the last store. The API stores `ydoc`, `draft_json`,
   `draft_text`, updates `has_unpublished_changes`, `updated_by/at`, and snapshots an autosave version
   when due.
5. Permission changes take effect on the next connection. The server also re-authorizes every open
   connection every **5 minutes** *(rec)* (polling; no push channel from the API) and closes or
   downgrades to read-only the ones that lost access.

**Title** is a separate field above the editor (edited via `PATCH /wiki/nodes/{id}`), not part of the
Y.Doc, so tree/search stay consistent. Rename by anyone with edit.

**Draft / Published** — readers (view level) always see the published version; a page never published
shows "This page hasn't been published yet" to view-only users (and is hidden from their tree and
search). Editors land in the editor view (the live draft), with a banner when the draft differs from
the published version. **Publish** (edit) takes a change note (optional) and snapshots the current
`draft_json` as a `published` version (`POST /wiki/pages/{id}/publish`). Phase 2 inserts review.

**History** — a panel lists versions (published ones emphasized; autosaves collapsible by day) with
author, time and note. Selecting one shows it read-only; **Compare** shows a block-level diff between
any two versions (client-side: flatten each doc to blocks with a stable text key, LCS on blocks, then
a word diff inside changed text blocks via the `diff` package; additions green, removals red strike).
**Restore** (edit) loads that version's JSON into the live editor (`editor.commands.setContent`), which
syncs to everyone, and records a `restored` version with note "Restored from version N".

**Import** (`.docx`, `.md`, `.markdown`, `.txt`) — client-side *(rec: no server conversion needed)*:
`.docx` via `mammoth` (browser build) → HTML (embedded images are uploaded as page assets and their
`src` swapped for `assetId`s), `.md` via `marked` → HTML, `.txt` → paragraphs. The HTML is parsed with
the shared schema (`generateJSON`) into ProseMirror JSON, the page node is created with that
`draft_json` (`POST /wiki/nodes` with `initial_content`), and the collab server seeds the Y.Doc from it
on first load. An `imported` version is recorded. Unsupported constructs degrade to paragraphs.

**Page JSON validation** — the API caps `draft_json` at 5 MB and rejects non-object JSON; it never
trusts client HTML. `javascript:` and other non-allowlisted link schemes are stripped by the shared
schema's Link config and again by the renderer.

## 5. Files, uploads, previews, search

**Uploads — presigned PUT** *(rec; the existing multipart path reads whole files into API memory and
caps at 25 MB)*. New `storage.presign_put(key, content_type, size) -> url` and `storage.head_object(key)`.
1. `POST /wiki/uploads` `{parent_id | page_id, filename, content_type, size}` → checks level (edit on
   the parent, or edit on the page for page assets) and `size <= wiki_max_upload_bytes` → returns
   `{upload_id, url, key}`; the key is `wiki/<space_id>/<uuid>/<sanitized filename>`; an
   `upload_id` is a signed (JWT, 1 h) claim of `{key, parent/page, filename, size, content_type,
   person}` — no table.
2. The browser PUTs the bytes straight to Spaces/MinIO with progress (XHR). Many files upload in
   parallel (3 at a time) from a queue with a progress tray; folders dropped from the OS are recreated
   as wiki folders (DataTransferItem `webkitGetAsEntry`).
3. `POST /wiki/uploads/complete` `{upload_id, node_id?}` → `head_object` confirms the object exists
   and its size matches → creates the file node + version 1 (or a new version on `node_id`, or a page
   asset) → enqueues `file_extract` and, for Office types, `file_preview`.
Bucket CORS must allow PUT from the wiki origin (MinIO dev allows all by default; DigitalOcean Spaces
needs a CORS rule — README).

**Previews** (`GET /wiki/files/{id}/url?version=&disposition=inline|attachment` → presigned URL):
- *native*: images, PDF (the browser's own viewer in an iframe), video (`<video>`), audio, text/CSV/
  JSON/Markdown (fetched and shown as text/table/rendered Markdown, capped at 2 MB).
- *pdf*: `.doc/.docx/.odt/.rtf/.xls/.xlsx/.ods/.csv(large)/.ppt/.pptx/.odp` → the worker runs
  `soffice --headless --convert-to pdf` (timeout 120 s, isolated `-env:UserInstallation` per job) and
  stores `preview_key`; the viewer shows the PDF. Status `pending` shows "Preparing preview…" (the
  viewer polls every 3 s), `failed` shows "No preview — download to open".
- *none*: anything else shows an icon, metadata and Download.

**Text extraction** (for search; worker job `file_extract`): PDF via `pdftotext -layout`; Office via
LibreOffice → PDF (reusing the preview if present) → `pdftotext`; text-like types read directly;
capped at 1 MB of text; images/video get none. The node's `search_tsv` is refreshed after extraction.

**Search** (`GET /wiki/search?q=&space=&kind=&limit=`) — Postgres FTS *(rec)*:
`search_tsv = setweight(to_tsvector('english', title),'A') || setweight(to_tsvector('english',
coalesce(published text | current file text + description,'')),'B')`, recomputed in Python-issued SQL
on publish, rename, upload, extraction. Query: `websearch_to_tsquery('english', q)` ranked by
`ts_rank_cd`, **OR** trigram `similarity(title, q) > 0.3` for typo tolerance, merged and ranked
(title matches first), filtered through the AccessIndex, with `ts_headline` snippets (`<mark>` only;
the snippet is HTML-escaped before marks are applied). A never-published page is found by its
**title only**, and only by users with edit on it *(rec)*; body search always uses published text. The wiki header search box shows instant results
(debounced 200 ms, top 8) and Enter opens a full results page with filters (space, type, updated).

## 6. Wiki UI (phase 1)

Routes (wiki SPA): `/login`, `/` (home), `/s/:spaceKey` (space home), `/n/:nodeId` (any node — page,
folder or file; canonical links use this), `/n/:nodeId/history`, `/search`, `/trash/:spaceKey`,
`/spaces/new`, `/s/:spaceKey/settings`, `/admin` (wiki admins: all spaces, archived spaces).

- **Shell** — top bar: wiki mark, space switcher, search box (⌘K focuses), "New" menu, user avatar
  menu (Back to portal, Sign out). Left sidebar: the current space's tree (lazy-loaded children,
  expand state remembered per space in localStorage, drag-and-drop reorder/move with a drop indicator,
  right-click/⋯ row menu: New page/folder here, Upload, Rename, Move, Copy link, Permissions, Delete),
  then "Favorites" and "Recently updated". Collapsible like the portal nav.
- **Home** — spaces grid (icon, name, description, page count), favorites, recently updated across
  viewable spaces, "My drafts" (pages I edited with unpublished changes).
- **Space home** — the space's home page (a normal page flagged by `home_node_id`, created with the
  space) plus a "What's in this space" listing.
- **Folder view** — breadcrumb, title (inline rename), a list (name, type, updated, by, size) with the
  portal's list styling, buttons New page / New folder / Upload / Import, and a whole-view drop zone.
- **Page view** — breadcrumb, title, meta line (published by X, time; "Draft has unpublished changes"
  chip for editors), actions (Edit ↔ View toggle for editors, Publish, History, Favorite, ⋯ menu:
  Move, Copy, Permissions, Delete), right rail table of contents from headings. Edit mode: toolbar,
  presence avatars, "Saving…/Saved" indicator, connection-lost banner (Hocuspocus reconnects).
- **File view** — preview pane, description (editable), versions table (upload a new version, download
  any, restore as current), details (type, size, uploaded by).
- **Permissions dialog** — for space (members) and node (overrides): current effective access list
  with where each grant comes from ("Inherited from <folder>"), add principal (a type picker + a
  ComboBox of people / roles / groups / clients / partners), level segmented control, "Inherit from
  parent" switch with a confirmation that copies the inherited set when breaking inheritance *(rec,
  SharePoint behavior)*.
- **Trash** — per space (manage): deleted batches with what, who, when, days left; Restore (to the
  original parent, or the space root if that's gone) and Delete forever (wiki admin or space manager).
  The worker purges batches older than `wiki_trash_days` and removes their objects.
- **Move / Copy** — a destination tree picker (only nodes where the user has edit); copy of a page
  copies its current draft and assets (not history) as a new unpublished page; copy of a folder is
  recursive (worker job when > 50 nodes? *(rec: synchronous, capped at 500 nodes, 422 above)*).

Follows house UI rules: portal CSS tokens and list typography, modal header pattern (eyebrow/title/
description) sized to content, ComboBox not native selects, American English, list column floors.

## 7. Phase 2 — collaboration

- **Comments** — `wiki_comments(id, node_id, thread_id, parent_id null, anchor text null, body jsonb
  (text + mention ids), author_id, created_at, edited_at, deleted_at, resolved_at, resolved_by)`.
  Inline threads: a `commentThread` mark with `threadId` in the Y.Doc (so anchors move with edits);
  page-level threads have no anchor. Right-rail comment panel; resolve/reopen; edit/delete own; view
  level can comment when the space's `readers_can_comment` is true (else edit). Deleted text keeps
  its thread as "orphaned" in the panel.
- **@mentions** — in comments and in page content (a Mention node). Mentioned people must be able to
  view the page; the picker only offers such people. Notify via `notifications.inbox.notify(kind=
  'wiki_mention', link=<wiki_origin>/n/<id>)` on comment post, and on publish for mentions added
  since the previous published version.
- **Templates** — `wiki_templates(id, space_id null (global), name, description, icon, content_json,
  created_by, …)`. "New page" offers Blank + templates (space ones, then global). Seeded global
  templates: **SOP**, **How-to guide**, **Troubleshooting**, **Meeting notes**. "Save as template"
  from a page (space manage for a space template, wiki admin for global). Template management page.
- **Watching** — `wiki_watches(person_id, space_id null, node_id null)`. Watch a page, folder
  (subtree) or space. Events: page published, new node created in a watched folder/space, comment on a
  watched page, review decided. Inbox `notify(kind='wiki_update')`, skipped for the actor and for
  watchers who can no longer view. Auto-watch pages you create or publish *(rec)*; "Watching" list on
  the home page; unwatch from the notification's page.
- **Reviews/approvals** — space setting `require_approval` (+ node-level override in the same
  inherit/replace style is **not** built *(rec: space-level only, keeps it understandable)*);
  approvers = manage-level holders of the page. Publish becomes **Submit for review** (with note) →
  `wiki_reviews(id, node_id, version_id (snapshot), requested_by, status pending|approved|rejected|
  withdrawn, decided_by, decided_at, decision_note)`; approvers get an inbox item and a "Reviews"
  queue page showing the diff against the published version; Approve publishes that snapshot; Request
  changes notifies the author. One pending review per page (a new submit replaces it).
- **Periodic review** — `wiki_nodes.review_interval_months null`, `next_review_at null`,
  `last_reviewed_at`, `last_reviewed_by` (page-level, defaulted from the space's
  `review_interval_months` at publish). The worker's daily `reminders` job notifies the page owner when
  due (once per due date) and pages show "Review due" / "Overdue" chips; **Mark as reviewed** resets
  it. A "Due for review" list in the space.

## 8. Phase 3 — reach

- **Public share links** — `wiki_share_links(id, node_id (page or file), token_hash, created_by,
  created_at, expires_at null, revoked_at, view_count, last_viewed_at)`. Needs manage level and the
  space's `allow_public_links`. Expiry options 1/7/30/90 days or never (default 30). Public API
  `GET /wiki/public/{token}` (no auth, IP rate-limited via the existing `rate_limit_ip`) returns the
  **published** page JSON (+ presigned asset URLs, 10 min) or file metadata + presigned URL; the wiki
  SPA route `/p/:token` renders it read-only with no chrome beyond a slim header. PageLinks inside a
  shared page render as plain text. Revoke from the page's Share dialog; wiki admins see all links.
- **Help links** — `wiki_help_links(id, context text unique, node_id, created_by, created_at)`;
  contexts look like `portal:/bulk/time` or `kiosk:/enroll` (route pattern, the longest matching
  prefix wins). `GET /wiki/help?context=` returns `{node_id, title, url}` if the user can view it,
  else 404. Portal: a "?" help button in the page top bar opens the linked guide in a new tab, or a
  small popover "No guide for this page yet" (+ "Link a guide" for wiki admins which opens the wiki's
  help-link admin with the context prefilled). Kiosk: the same button in the kiosk shell top bar
  (online only). Wiki admin page "Help links": list/add/edit/remove; page ⋯ menu "Use as help for…".
- **Analytics** — `wiki_page_views(node_id, person_id, viewed_on date, count)` (upsert per person per
  day; retention 365 days via the worker), `wiki_feedback(node_id, person_id, helpful bool, comment
  null, updated_at)` (one row per person per page; "Was this page helpful? Yes/No" footer + optional
  comment on No), `wiki_search_log(id, person_id, query, result_count, at)` (retention 90 days).
  Analytics page (wiki admins: all; space managers: their spaces): top viewed pages, views trend,
  helpfulness (% yes, recent "No" comments), searches with no results, stale pages (not updated in
  12 months), review-overdue pages.
- **Export** — page → PDF (worker: `/internal/render` HTML + print stylesheet → WeasyPrint), `.docx`
  (worker: render HTML → `soffice --convert-to docx`), Markdown (client-side serializer from JSON,
  immediate download). Folder/space → `.zip` of pages (chosen format) + files, preserving the tree, via
  a worker job; completion posts an inbox item with a download link (presigned, 24 h) and the SPA shows
  progress while it waits. Export respects the requester's view level node by node.

## 9. Error handling

- API errors use the house `{"detail": {"code": ..., "message": ...}}` shape: `not_found` (also for
  no-view), `forbidden` (can view but lacks the level), `bad_parent` (file as parent, move into own
  subtree, cross-space move without manage on both), `too_large`, `upload_mismatch` (size/object
  missing at complete), `stale_upload` (expired upload_id), `conflict` (concurrent position/move
  edits — client refetches), `read_only` (archived space or system read-only mode — the existing
  admin read-only choke point applies to all wiki writes and the collab server gets 503 from store,
  keeps the doc in memory and retries).
- The editor shows a connection banner while Hocuspocus is disconnected; edits made offline stay in
  the local Y.Doc and sync on reconnect. If a store fails the server retries with backoff and never
  drops the in-memory doc while clients are connected.
- Worker jobs: 3 attempts with backoff, then `failed` with the error; preview/extract failures mark
  the file version (`preview_status/extract_status = failed`) and never block the upload.
- Uploads: per-file errors in the tray with Retry; a completed PUT whose `complete` call fails is
  retried; orphan objects (PUT without complete) are cleaned by the purge job after 24 h by listing the
  `wiki/` prefix against known keys *(rec: phase 1 does a best-effort sweep)*.

## 10. Testing

- **API (pytest, real Postgres, `SS_TEST_DB=serversherpa_test_wiki`):** the permission resolver
  exhaustively (inherit/replace, each principal type, archived, wiki admin, manager-never-locked-out,
  404-not-403), tree ops (create/move/reorder/cycle prevention/cross-space/copy/trash/restore/purge),
  internal collab routes (service token required, user token required for authorize, readOnly level),
  publish/versions/autosave cadence, uploads (presign, complete, mismatch, too large; storage mocked at
  the service boundary like existing attachment tests), search ranking + permission filtering +
  snippet escaping, worker jobs with LibreOffice/pdftotext subprocesses faked, audit rows.
- **Wiki web (vitest + testing-library, jsdom pragma per DOM test):** tree, permissions dialog,
  upload queue, import conversion (docx fixture via mammoth, md via marked), diff algorithm, schema
  round-trips, search box, history panel, portal-import guardrail.
- **Wiki server (vitest, node):** authorize/readOnly mapping, load/store calls with the service token,
  re-authorization downgrade, render endpoint token check and HTML parity with the web renderer.
- **Portal:** the Wiki nav item and (phase 3) the help button.
- **Live verification** per phase: two browser tabs co-editing a page (cursors, publish, history,
  restore), a PDF + a `.docx` upload through the worker preview, search finding text inside the PDF,
  a view-only user's tree, and the Docker images building and serving.
