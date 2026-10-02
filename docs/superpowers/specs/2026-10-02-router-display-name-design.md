# Router display names — design

Date: 2026-10-02. Branch `router-display-name`. Approved by Jimmy in chat.

## Goal

A router registers with its hostname as its name (e.g. `csg_router_kit_19`).
On `/hardware/routers`, show it human-readable: **CSG Router Kit 19**.

## Decisions

| Question | Decision |
|---|---|
| How acronyms are capitalized | A fixed list of known acronyms, written in capitals. Every other word: first letter capital, rest lower. |
| Stored or displayed | Display only. The stored name stays the real hostname; nothing in the API or database changes. |
| Scope | The `/hardware/routers` page only (list, its search/sort/filter/export, its confirm dialogs). Inbox notifications (server-written) and other pages are unchanged. |

## Helper — `routerDisplayName(name: string): string` in `portal/src/lib/devices.ts`

- Split on runs of `_`, `-`, `.` and whitespace; drop empty pieces.
- A word whose lowercase form is in `ROUTER_ACRONYMS` → uppercase.
  `ROUTER_ACRONYMS = ['csg', 'gl', 'vpn', 'lte', 'nap', 'dc', 'ups', 'lan', 'wan', 'ap']`.
- A word containing any digit (all digits, or letters mixed with digits like `MT3000`) → unchanged, as typed.
- Any other word → first character uppercase, the rest lowercase.
- Join with single spaces. If the result is empty (blank / separators only), return the input unchanged.
- Examples: `csg_router_kit_19` → `CSG Router Kit 19`; `GL-MT3000` → `GL MT3000`;
  `dock__router--2` → `Dock Router 2`; `CSG_ROUTER_KIT` → `CSG Router Kit`; `''` → `''`.

## Routers page (`portal/src/pages/Routers.tsx`)

- Name cell: the readable name; `title` (hover) = the raw stored name.
- Sorting by Name: by the readable name (natural order via the page's existing compareValues).
- Column filter on Name: matches the readable name (the page's cell-text function for `name` returns the readable name).
- Search: matches the readable name and the raw name (both added to the search text).
- Confirm dialogs (Approve, Revoke, Delete, dismiss "Secret changed") name the router by its readable name.
- CSV export: `Name` = readable name; new `Hostname` column right after it = raw name.
- Kiosk Devices, Fixed Readers and the shared `deviceCellText` are untouched.

## Tests

- `portal/src/lib/devices.test.ts`: the examples above, acronym case-insensitivity, words with digits kept as typed, blank input.
- `portal/src/pages/Routers.test.tsx`: a router named `csg_router_kit_19` shows `CSG Router Kit 19` with the raw name as the cell title; search by `csg_router` and by `Router Kit 19` both find it; the Delete confirm names `CSG Router Kit 19`.
