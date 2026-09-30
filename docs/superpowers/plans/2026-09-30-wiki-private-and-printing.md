# Wiki Private Items and Allow Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Private" (only the author and developers can see an item) and "Allow printing" (when off, nobody can print, export, download or publicly share an item) to the wiki.

**Architecture:** One migration adds `wiki_nodes.is_private` and `wiki_nodes.allow_printing`, plus a library setting `allow_printing`. The private rule and `can_print` live in the single access choke point `AccessIndex` (api/src/serversherpa/wiki/permissions.py), so every endpoint that already filters through it inherits them. New endpoints set the two values, and the refusals are added at the share-link, help-link, template, export and download endpoints. The SPA adds the controls, markers, a print guard, and a pdf.js canvas viewer used when printing is off.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (api/), React + Vite + Tiptap 2.27 (wiki/web), Vitest, pytest, pdfjs-dist (new, wiki package only).

**Spec:** `docs/superpowers/specs/2026-09-30-wiki-private-and-printing-design.md` — read it first; it is the source of truth for behavior.

## Global Constraints

- **Migration:** number **0084**, `down_revision = "0079"`. Columns: `wiki_nodes.is_private boolean NOT NULL DEFAULT false`; `wiki_nodes.allow_printing boolean NULL` (null = inherit).
- **Library setting:** `allow_printing` (bool, default `true`), added only in `api/src/serversherpa/wiki/space_settings.py` (`ALLOWED` and `DEFAULTS`) and mirrored in the SPA's `SPACE_SETTING_DEFAULTS`.
- **Developer:** a person whose `Principal.roles` contains `"developer"`.
- **Author:** `WikiNode.created_by` of the private node.
- **Private visibility:**
  - For every node on the chain (ancestors root-first, then the node) with `is_private`, the viewer must be that node's `created_by`, or a developer. Otherwise the level is `None`, even for wiki administrators (`is_admin`), space managers and any grant.
  - A viewer who passes the private check on a chain that contains at least one private node gets level `manage`.
- **Setting privacy:** only the node's `created_by` or a developer can set or clear `is_private`. The library home page is refused with 422 `home_page`.
- **Effective printing:** the nearest non-null `allow_printing` walking from the node up through its ancestors; if there is none, the library setting (default true). **No exemptions** when printing is off: this applies to everyone, including developers, wiki admins and managers.
- **Changing printing:** needs `manage` on the node.
- **Error codes:**
  - 422 `private`: share link, help link or template for a private node.
  - 422 `printing_disabled`: share link creation.
  - 403 `printing_disabled`: export or download refused.
  - 422 `home_page`: privacy on a library home page.
- **Hidden means missing:** anything a viewer can't see behaves as missing, i.e. 404 from the API and "Nothing here" in the SPA.
- **Copy (American English):**
  - "Private — only you and developers can see this"
  - "Printing" with the options "Inherit (Allowed, from …)" / "Inherit (Not allowed, from …)" / "Allowed" / "Not allowed"
  - "Allow printing"
  - "Printing is turned off for this page."
  - The chips "Private" and "Printing off"
  - The Printing help text must state: "This stops printing, exporting, downloading and public links. It can't stop screenshots."
- **UI copy guard:** the wiki's `uiCopy.test.ts` forbids the word "space" in UI strings; use "library".
- **Test databases:** API tests use the per-branch test DB (`serversherpa_test_wiki`). Subagents must never write to the dev DB (localhost:5433/serversherpa) and must never sign in anywhere.
- **Suites that must stay green:**
  - `cd api && PYTHONPATH=src .venv/bin/pytest tests/test_wiki_*.py -q` (the wiki suites; run the full API suite only in the last task)
  - `cd wiki && npx vitest run`
  - `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.test.json` in `wiki/`
- **Style:** match the surrounding code's comment density and naming.

---

### Task 1: Schema and the access rule

**Files:**
- Create: `api/migrations/versions/0084_wiki_private_printing.py`
- Modify: `api/src/serversherpa/db/models.py` (class `WikiNode`: add `is_private`, `allow_printing`)
- Modify: `api/src/serversherpa/wiki/space_settings.py` (`allow_printing`: bool, default True)
- Modify: `api/src/serversherpa/wiki/permissions.py` (`_SpaceData`, `_load_spaces`, `_level`, new `can_print`, new helpers)
- Test: `api/tests/test_wiki_private_printing_access.py` (new)

**Interfaces:**
- Produces:
  - `AccessIndex.level_for_node(node)` now applies the private rule. Its signature is unchanged.
  - `async AccessIndex.can_print(node: WikiNode) -> bool` returns the effective printing value.
  - `async AccessIndex.printing_source(node: WikiNode) -> tuple[bool, uuid.UUID | None]` returns (effective value, id of the node that set it, or `None` when it came from the library setting). Task 2 uses it for the "Inherit (…, from …)" label.
  - `is_developer(p: Principal) -> bool` (module-level, in permissions.py).
  - `can_set_private(p: Principal, node: WikiNode) -> bool` returns `node.created_by == p.person_id or is_developer(p)`.

- [ ] **Step 1: Write failing tests.** In `test_wiki_private_printing_access.py`, use the existing wiki test fixtures. Look at `api/tests/test_wiki_permissions.py` for how spaces, nodes, grants and principals are built, and reuse those helpers or fixtures instead of duplicating them. Cover:
  - **Private page:**
    - Its author gets `manage`, even when the library grants them only `view`.
    - A developer (roles include `"developer"`, no wiki grants beyond view) gets `manage`.
    - A wiki administrator (`is_admin`) gets `None`.
    - A library manager (space grant `manage`) gets `None`.
    - A reader gets `None`.
  - **Private folder:** a child page created by someone else is `None` for that someone else, and `manage` for the folder's author.
  - **Nested private:** a private page with author B inside a private folder with author A is visible only to developers, or to someone who is both A and B.
  - **Printing inheritance:**
    - The library default is True.
    - A library setting of `allow_printing: False` makes `can_print` False for all nodes.
    - A folder with `allow_printing=False` gives a child page `can_print == False`, and `printing_source` returns the folder's id.
    - A page with `allow_printing=True` under that folder gives True.
  - **`space_settings.validate("allow_printing", True)`** is True, and `validate("allow_printing", "yes")` is False.
- [ ] **Step 2: Run to confirm they fail.**
  - Command: `cd api && PYTHONPATH=src .venv/bin/pytest tests/test_wiki_private_printing_access.py -q`
  - Expected: failures (missing columns or attributes).
- [ ] **Step 3: Migration 0084.**
  - Add the two columns: `op.add_column("wiki_nodes", sa.Column("is_private", sa.Boolean(), nullable=False, server_default=sa.text("false")))` and `op.add_column("wiki_nodes", sa.Column("allow_printing", sa.Boolean(), nullable=True))`.
  - `downgrade` drops both.
  - Docstring header in the style of 0079.
- [ ] **Step 4: Model.** On `WikiNode`, add `is_private: Mapped[bool] = mapped_column(server_default=text("false"))` and `allow_printing: Mapped[bool | None]`.
- [ ] **Step 5: Space setting.** Add `"allow_printing": bool` to `ALLOWED` and `"allow_printing": True` to `DEFAULTS`. Update the module comment that lists the knobs.
- [ ] **Step 6: AccessIndex changes.**
  - In `_load_spaces`, also load, per space:
    - `private: dict[node_id, created_by]` for live nodes with `is_private`;
    - `printing: dict[node_id, bool]` for live nodes with non-null `allow_printing`;
    - the space's effective `allow_printing` setting (`settings.get("allow_printing", True)`).
  - Store these on `_SpaceData`, using the same batched-query pattern as grants: one query per concern for all requested spaces.
  - **Load order:** private data must be loaded even for `is_admin` callers, because `_level` currently returns early for admins. Load private data before that early return, or load it in `levels_for_nodes` for everyone. Keep the "fixed number of queries per space" property.
  - **In `_level`:** after the `can_view_wiki` check and **before** the `is_admin` shortcut, look up the private nodes in `chain`.
    - If there are none, carry on as today.
    - If there are any, the viewer passes if `is_developer(p)` is true or `p.person_id` equals every private node's `created_by`. A viewer who passes gets `"manage"`; one who doesn't gets `None`.
    - Include this in the memo.
  - Add `is_developer`, `can_set_private`, `can_print` and `printing_source` as described in Interfaces.
- [ ] **Step 7: Run the new tests and the existing permission tests.**
  - Command: `cd api && PYTHONPATH=src .venv/bin/pytest tests/test_wiki_private_printing_access.py tests/test_wiki_permissions.py -q`
  - Expected: all pass.
- [ ] **Step 8: Commit** with the message `feat(wiki): private items and allow-printing inheritance in the access check (migration 0084)`.

### Task 2: API surface — payloads, privacy and printing endpoints

**Files:**
- Modify: `api/src/serversherpa/api/routes/wiki/schemas.py` (`NodeOut`: add fields; new request models)
- Modify: `api/src/serversherpa/api/routes/wiki/serialize.py` (`node_out` fills the new fields)
- Modify: `api/src/serversherpa/api/routes/wiki/nodes.py` (new endpoints)
- Modify: `api/src/serversherpa/api/routes/wiki/spaces.py` if settings updates are validated there (they should flow through `space_settings.validate`)
- Test: `api/tests/test_wiki_private_printing_api.py` (new)

**Interfaces:**
- Consumes (Task 1): `AccessIndex.can_print`, `AccessIndex.printing_source`, `can_set_private`, `is_developer`.
- Produces:
  - `NodeOut` gains:
    - `is_private: bool`
    - `allow_printing: bool | None` (the node's own explicit value)
    - `can_print: bool` (effective for the caller)
    - `printing_from: PrintingSourceOut | None`, where `PrintingSourceOut = {node_id: uuid|None, title: str}`. This is the node that set the effective value; `node_id` is None and `title` is "Library" when it came from the library setting. It is filled only when `allow_printing` is null.
    - `can_set_private: bool`
  - `PATCH /wiki/nodes/{id}/privacy` with body `{is_private: bool}` returns `NodeOut`.
  - `PATCH /wiki/nodes/{id}/printing` with body `{allow_printing: bool | null}` returns `NodeOut`.

- [ ] **Step 1: Write failing tests:**
  - **Privacy endpoint:**
    - The author can set and clear `is_private` (200, and the payload reflects it).
    - A developer can set it.
    - An editor who isn't the author gets 403 `forbidden`.
    - A wiki admin who isn't the author or a developer gets 403.
    - A home page gets 422 `home_page`.
    - A node the caller can't see gets 404.
  - **Printing endpoint:**
    - A manager can set true, false or null.
    - An editor gets 403.
    - The payload's `can_print` and `printing_from` reflect inheritance: a child of a printing-off folder shows `can_print: false` and `printing_from.node_id` equal to the folder.
  - **Library setting:** `allow_printing` can be updated through the existing library settings endpoint and is validated (a bad type gets 422).
  - **Audit:** both endpoints write audit rows (`entity_type="wiki_node"`, actions `privacy` / `printing`).
  - **Payload fields:** `GET /wiki/nodes/{id}` includes the new fields for pages, files and folders.
- [ ] **Step 2: Run to confirm they fail.** Command: `cd api && PYTHONPATH=src .venv/bin/pytest tests/test_wiki_private_printing_api.py -q`
- [ ] **Step 3: Implement.**
  - **Schemas:** add the new `NodeOut` fields, `PrivacyIn` and `PrintingIn`.
  - **`node_out`:** computes the fields through the context's `AccessIndex`. Keep the listing endpoints' query count bounded, reusing the index's per-space cache.
  - **Endpoints in `nodes.py`:** they follow the existing patterns there: `require_node_level` for the view check, then the specific permission rule, then the update, audit, and `await ctx.db.commit()`.
  - **Privacy changes and live editing:** after a privacy change, the collab server's periodic re-authorization will disconnect anyone who lost access. Check how `internal.py` authorizes, and don't add new plumbing if re-authorization already calls `level_for_node`.
- [ ] **Step 4: Run.** Command: `cd api && PYTHONPATH=src .venv/bin/pytest tests/test_wiki_private_printing_api.py tests/test_wiki_nodes*.py -q`. Expected: pass.
- [ ] **Step 5: Commit** with the message `feat(wiki): privacy and printing endpoints and node payload fields`.

### Task 3: API enforcement — sharing, help links, templates, export, download, listings

**Files:**
- Modify: `api/src/serversherpa/api/routes/wiki/share_links.py`, `public.py`, `help_links.py`, `templates.py`, `exports.py`, `files.py`
- Modify: `api/src/serversherpa/wiki/export.py` (zip builder skips items that can't be printed and lists them in `_skipped.txt`)
- Modify, only if a listing filters in SQL rather than through `AccessIndex`: `search.py`, `analytics.py`, `trash.py`, `watches.py`, the mention-candidate endpoint, and the notification recipient filter in `api/src/serversherpa/wiki/notify.py`
- Test: `api/tests/test_wiki_private_printing_enforcement.py` (new)

**Interfaces:**
- Consumes: Task 1's `AccessIndex.level_for_node` (the private rule) and `AccessIndex.can_print`.

- [ ] **Step 1: Write failing tests:**
  - **Share links:**
    - Creating a link for a private node gets 422 `private`; for a printing-off node, 422 `printing_disabled`.
    - An existing link returns 404 from `GET /wiki/public/{token}` after its node (or an ancestor folder) is made private or printing is turned off, and works again after it's restored.
  - **Help links:** creating one for a private target gets 422 `private`. `GET /wiki/help?context=…` returns 404 for a viewer who can't see the (now private) target.
  - **Templates:** "save as template" from a private page gets 422 `private`.
  - **Exports:**
    - `POST /wiki/exports` for a printing-off page gets 403 `printing_disabled`.
    - A folder export (run the worker's builder directly, following the pattern in the existing export tests) leaves out printing-off items and lists them in `_skipped.txt`.
    - A private item is simply absent from someone else's export.
  - **Downloads:** requesting a download URL (`disposition=attachment`, and any per-version download) for a printing-off file gets 403 `printing_disabled`. An `inline` preview URL still works.
  - **Listings exclude private items for a non-author:** search (quick and full), recently updated, drafts, favorites, watching list, analytics (top pages, stale, overdue), library trash, due-for-review, @mention candidates for a private page (only the author and developers), and notification recipients (publishing a private page notifies no watchers but the author). Write one test per listing; each must fail before your change **or** already pass because the listing goes through `AccessIndex`. Keep the passing ones as regression guards.
- [ ] **Step 2: Run to see which fail.** Command: `cd api && PYTHONPATH=src .venv/bin/pytest tests/test_wiki_private_printing_enforcement.py -q`
- [ ] **Step 3: Implement** each refusal with the exact codes from the Global Constraints. For any listing that filters in SQL, add the private rule (exclude nodes whose chain contains a private node the caller didn't create, unless they're a developer). Route it through a shared helper in `permissions.py` rather than copying the rule.
- [ ] **Step 4: Run** the new tests plus the existing wiki suites they touch. Command: `cd api && PYTHONPATH=src .venv/bin/pytest tests/test_wiki_*.py -q`. Expected: pass.
- [ ] **Step 5: Commit** with the message `feat(wiki): enforce private and printing-off across sharing, help links, templates, export, download and listings`.

### Task 4: SPA — controls and markers

**Files:**
- Modify: `wiki/web/src/lib/types.ts` (NodeOut fields), `wiki/web/src/lib/wikiApi.ts` (`setNodePrivacy`, `setNodePrinting`), the SPA's `SPACE_SETTING_DEFAULTS` (search for it)
- Modify: `wiki/web/src/components/PermissionsDialog.tsx` (Private switch, Printing select)
- Modify: `wiki/web/src/pages/SpaceSettings.tsx` (Sharing › Allow printing switch)
- Modify: the tree row component in `wiki/web/src/layout/` (lock icon), the folder and library-home lists (lock icon), and the page, file and folder headers (`PageView.tsx`, `FileView.tsx`, `FolderView.tsx`: "Private" and "Printing off" chips)
- Test: the colocated `*.test.tsx` files for each component touched

**Interfaces:**
- Consumes: Task 2's payload fields and endpoints.
- Produces:
  - `setNodePrivacy(nodeId: string, isPrivate: boolean): Promise<NodeDetail>`
  - `setNodePrinting(nodeId: string, allow: boolean | null): Promise<NodeDetail>`

- [ ] **Step 1: Write failing tests:**
  - **PermissionsDialog, Private switch:**
    - It shows only when `can_set_private` is true.
    - Toggling calls `setNodePrivacy`.
    - The label is "Private — only you and developers can see this".
  - **PermissionsDialog, Printing select:**
    - It shows for managers, with the options "Inherit (Allowed, from Library)" (or the source node's title), "Allowed" and "Not allowed".
    - Choosing an option calls `setNodePrinting` with `null`, `true` or `false`.
    - The help text is present.
  - **SpaceSettings:** the Allow printing switch saves `allow_printing`.
  - **Markers:** a lock icon (accessible name "Private") on tree rows and list rows for private nodes; "Private" and "Printing off" chips in the headers.
  - **Copy:** the `uiCopy` guard passes.
- [ ] **Step 2: Run to confirm they fail.** Command: `cd wiki && npx vitest run web/src/components/PermissionsDialog.test.tsx web/src/pages/SpaceSettings.test.tsx`
- [ ] **Step 3: Implement.**
  - Follow the existing dialog, switch and chip idioms, the portal UI consistency rules (segmented, switch and chip classes already used in the wiki), and the modal header pattern.
  - After a successful privacy or printing change, refresh the node and the tree (reuse the tree store's refresh used by rename and move).
  - The lock icon: reuse the icon set in `wiki/web/src/editor/icons.tsx`, adding a `lock` icon there if none exists.
- [ ] **Step 4: Run** the wiki suite and type checks. Command: `cd wiki && npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json`. Expected: pass.
- [ ] **Step 5: Commit** with the message `feat(wiki): Private switch, Printing setting, Allow printing library switch, and markers`.

### Task 5: SPA — print blocking, hidden actions, and the canvas PDF viewer

**Files:**
- Create: `wiki/web/src/components/PrintGuard.tsx` (+ test)
- Create: `wiki/web/src/components/PdfCanvasViewer.tsx` (+ test)
- Modify: `wiki/package.json` (add `pdfjs-dist`, pinned to a current 4.x release), `wiki/vite.config.ts` if the pdf.js worker needs a URL import
- Modify: `wiki/web/src/pages/PageView.tsx`, `FileView.tsx`, `FolderView.tsx`, `SpaceHome.tsx`, the row/⋯ menu (`components/RowMenu.tsx`), and `components/ExportDialog.tsx` callers (hide Export, Download, Share and Upload-new-version download buttons when `can_print` is false)
- Modify: `wiki/web/src/editor/nodeViews.tsx` (file embeds: when the embedded file can't be printed, the inline preview uses `PdfCanvasViewer` and there's no download link; images: no context menu when the page can't be printed)
- Modify: `wiki/web/src/styles/wiki.css` (print CSS)

**Interfaces:**
- Consumes: `NodeOut.can_print`.
- Produces:
  - `<PrintGuard active={boolean} />`. While active, it installs a capture-phase `keydown` listener on `window` that `preventDefault()`s ⌘P/Ctrl+P (`e.key` is `p`/`P` with `metaKey || ctrlKey`) and shows the toast "Printing is turned off for this page." through the wiki's toast helper. It also sets `document.body.dataset.noPrint = "1"`, removing it on unmount or when it becomes inactive, and renders a `div.wiki-print-blocked` containing "Printing is turned off for this page." (hidden on screen).
  - `<PdfCanvasViewer url={string} />` renders each page of the PDF to a `<canvas>` with pdfjs-dist, with no toolbar, links or download, and `onContextMenu` prevented.

- [ ] **Step 1: Write failing tests:**
  - **PrintGuard:**
    - A keydown of Ctrl+P and of ⌘P is default-prevented and shows the toast while active.
    - Nothing happens when it's inactive.
    - `body[data-no-print]` is set only while it's active.
  - **Print CSS:** assert that the stylesheet has `@media print { body[data-no-print] … { display: none } … .wiki-print-blocked { display: block } }`, following the existing CSS-guard test style if one exists. Otherwise test the class toggling only.
  - **PageView and FileView with `can_print: false`:**
    - There's no Export in the ⋯ menu, no Download button and no Share….
    - PrintGuard is active.
    - For a PDF file the preview renders `PdfCanvasViewer` (mock pdfjs-dist) instead of an `<iframe>`/`<object>`.
    - `<video>`/`<audio>` get `controlsList="nodownload noplaybackrate"` and `disablePictureInPicture`.
  - **Printing allowed (`can_print: true`):** everything is unchanged (the existing tests keep passing).
  - **FolderView and SpaceHome:** Export… is hidden when the folder's `can_print` is false.
- [ ] **Step 2: Run to confirm they fail.** Command: `cd wiki && npx vitest run web/src/components/PrintGuard.test.tsx web/src/pages/FileView.test.tsx web/src/pages/PageView.test.tsx`
- [ ] **Step 3: Implement.**
  - **Install pdfjs-dist:** `cd wiki && npm install pdfjs-dist@^4`. This is a dependency change: run it only inside the wiki worktree, never the main checkout.
  - **Worker setup:** configure the pdf.js worker with Vite's `?url` import, e.g. `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` and `GlobalWorkerOptions.workerSrc = workerUrl`.
  - **Print CSS:** add it to `wiki.css`:
    ```css
    .wiki-print-blocked { display: none; }
    @media print {
      body[data-no-print] > * { display: none !important; }
      body[data-no-print] .wiki-print-blocked { display: block !important; }
    }
    ```
    Render the notice through a portal to `document.body` so it's a direct child of `body` and survives the rule above.
- [ ] **Step 4: Run** the wiki suite and type checks. Command: `cd wiki && npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json`. Expected: pass.
- [ ] **Step 5: Commit** with the message `feat(wiki): block printing, export, download and sharing when printing is off; canvas PDF viewer`.

### Task 6: Wrap-up

**Files:**
- Modify: `wiki/README.md` (a "Private items and printing" section: the rules, what "printing off" blocks, and the honest limit)
- Test: full suites

- [ ] **Step 1: README section.** Write the rules from the spec in plain English, with no code identifiers except endpoints.
- [ ] **Step 2: Full runs:**
  - The API wiki suites (`tests/test_wiki_*.py`), then the full API suite. Command: `cd api && PYTHONPATH=src .venv/bin/pytest -q -p no:cacheprovider`. The full suite takes about 40 minutes; run it in the foreground and report the counts.
  - The wiki SPA: `cd wiki && npx vitest run`.
  - The portal: `npm --prefix portal test`. It should be untouched, but prove it.
  - The kiosk: `npm --prefix kiosk test`.
- [ ] **Step 3: Commit** with the message `docs(wiki): private items and printing in the README`.
