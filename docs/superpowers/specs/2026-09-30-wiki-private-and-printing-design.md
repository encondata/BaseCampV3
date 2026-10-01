# Wiki: Private items and "Allow printing" — design

Status: approved by Jimmy 2026-09-30. Branch `wiki` (worktree `.claude/worktrees/wiki`).

## Goal

Two new permission options in the wiki:

1. **Private** — an item (page, file or folder) that only its author and developers can see.
2. **Allow printing** — when off, nobody can print, export, download or publicly share the item.

## 1. Private

### Who can see a private item

- A node is **private** when `is_private` is true on the node itself or on any ancestor
  (a private folder makes everything inside it private).
- For every private node on a node's path (ancestors and itself), the viewer must be **that
  private node's author** (`created_by`) — or have the **`developer`** role. Otherwise the
  viewer has **no access** at all, regardless of grants, library membership or the wiki
  administrator permission (`wiki:delete`).
- The author of the (outermost) private node gets **manage** on it and everything inside it.
  Developers get **manage** as well.
- No access looks exactly like a missing item everywhere: 404 from the API, "Nothing here" in
  the SPA, "…" in breadcrumbs.

### Who can mark an item private

- Only the node's author (`created_by`) or a developer can set or clear `is_private`.
- The library's home page can't be made private (422 `home_page`).
- Moving a private node keeps it private; moving a node into a private folder is only
  possible for someone who can see that folder (the author or a developer).

### Where private items are hidden from everyone else

Every listing already filters through the access check, so hiding follows from the access
rule, but these are explicitly tested: sidebar tree, folder lists, breadcrumbs, search
(quick and full), Recently updated, My drafts, Favorites, Watching, analytics (top pages,
stale pages, overdue reviews), library trash, due-for-review lists, @mention candidates,
notification recipients, and folder/library exports requested by someone else.

### Knock-on rules

- **Public share links:** can't be created for a private node (422 `private`); existing links
  to a private node (or a node inside a private folder) return 404 from `/wiki/public/*`.
- **Help links:** a private node can't be the target (422 `private`); an existing help link
  whose target becomes private resolves to "no guide" for anyone who can't see it.
- **Templates:** "Save as template…" is refused for a private page (422 `private`).

### Markers

- A lock icon on private items in the sidebar tree, folder lists and library home list.
- A "Private" chip in the page, file and folder header.

## 2. Allow printing

### Setting and inheritance

- Library setting `allow_printing` (bool, default `true`) in `wiki/space_settings.py`, shown as
  an **Allow printing** switch in Library settings › Sharing.
- Node column `allow_printing` (nullable bool): `null` = inherit, `true` = allowed,
  `false` = not allowed.
- Effective value for a node = the nearest non-null `allow_printing` on the node or its
  ancestors (node first, walking up); if none, the library setting.
- Only people who can **manage** the node change it (Permissions… dialog › **Printing**:
  *Inherit (Allowed/Not allowed, from …)*, *Allowed*, *Not allowed*).

### When printing is not allowed (effective `false`) — no exemptions

Applies to everyone, including managers, wiki administrators and developers; someone who can
manage the item has to allow printing again first.

- **Print shortcut:** ⌘P / Ctrl+P is intercepted (capture-phase keydown, `preventDefault`)
  on page and file views and shows a toast "Printing is turned off for this page."
- **Browser print menu:** `@media print` hides all content and prints only the notice
  "Printing is turned off for this page."
- **Export:** "Export…" is hidden for the node. `POST /wiki/exports` for a node that can't be
  printed is refused (403 `printing_disabled`); folder/library exports leave such items out
  and list them in `_skipped.txt`.
- **Downloads:** download buttons are hidden, and the API refuses to hand out a download
  (attachment) URL for any version of the file (403 `printing_disabled`).
- **Previews:** inline previews stay available, with no way to save or print them from the UI:
  - PDFs and converted Office previews are rendered with pdf.js into canvases (no native
    viewer toolbar);
  - video and audio: `controlsList="nodownload noplaybackrate"`,
    `disablePictureInPicture`, context menu disabled;
  - images: context menu disabled, `draggable=false`.
- **Public share links:** can't be created (422 `printing_disabled`); existing links return
  404 while printing is off.
- **Marker:** a "Printing off" chip in the page/file header.

### Honest limit

This is a deterrent, not DRM: screenshots, and a determined user with browser developer tools,
can still copy content. The help text on the Printing control says so.

## 3. Architecture

- **Migration 0084** (`down_revision = "0079"`): `wiki_nodes.is_private boolean not null
  default false`, `wiki_nodes.allow_printing boolean null`. Library `allow_printing` lives in
  the existing space settings JSON (no column).
- **Single choke point:** `AccessIndex` (wiki/permissions.py) gains the private rule inside
  level computation, and `can_print(node)`. Every endpoint already goes through
  `AccessIndex`, so tree, search, notifications, analytics and exports inherit the rule.
- **API surface:**
  - Node payloads gain `is_private`, `allow_printing` (explicit value), `can_print`
    (effective for the caller) and `can_set_private`.
  - `PATCH /wiki/nodes/{id}/privacy {is_private}` — author or developer.
  - `PATCH /wiki/nodes/{id}/printing {allow_printing: true|false|null}` — manage.
  - Space settings validation accepts `allow_printing`.
  - Audit entries for both changes.
- **Collab server / live editing:** re-authorization already goes through the API's access
  check, so a page that becomes private disconnects other editors.
- **SPA:**
  - Permissions dialog gains a Private switch (only for the author/developers) and a
    Printing select with the inherited source shown.
  - Library settings › Sharing gains Allow printing.
  - Lock icon and chips.
  - A `PrintGuard` on page/file views.
  - A `PdfCanvasViewer` (pdfjs-dist) used when `can_print` is false.
  - Export/Download/Share hidden by `can_print`.

## 4. Testing

- **Server:**
  - Private matrix (author, developer, wiki admin, library manager, reader, client user)
    across the node, a child in a private folder, and a nested private node.
  - Set or clear privacy permissions, including the home page refusal.
  - Printing inheritance (node, ancestor, library default).
  - Export refusal and skipping, download refusal, share link create/serve refusal for
    private and printing-off nodes, help link and template refusals.
  - Search, tree, analytics, trash and notification exclusion.
- **SPA:**
  - The ⌘P/Ctrl+P block and toast, and print CSS present only when `can_print` is false.
  - Hidden Export/Download/Share.
  - Permissions dialog controls (visibility rules, inherit labels).
  - Library settings switch, lock icon and chips, and the PDF canvas viewer used instead of
    the native viewer.
