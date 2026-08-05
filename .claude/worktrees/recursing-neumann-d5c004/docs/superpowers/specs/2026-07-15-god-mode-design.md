# God Mode — Design Spec

**Date:** 2026-07-15 · **Status:** Approved
**Scope:** A hidden developer surface: secret words typed into the ⌘K palette reveal a Developer nav section and tint the nav. Mechanism only — one placeholder dev page so the path is verifiable; real dev tooling arrives later as separate features.

## 1. What god mode is — and is not

**It is a visibility toggle, not a permission.** The server enforces the `devtools` permission on every request regardless of god-mode state. God mode only changes what the UI *offers*.

The consequence is the design's load-bearing property: **guessing a word buys an attacker nothing.** A non-developer who types the correct word receives the identical response as one typing gibberish. There is nothing behind the door to force — so no rate limiting, lockout, or brute-force defence is needed, and none is specified.

The secrecy exists for discretion (clean nav, nothing to notice in a screenshot or over a shoulder), not for defence. Anyone reasoning about this later should not mistake it for a security control.

**Why the words must live server-side.** Vite inlines `VITE_*` vars into the JS bundle; words placed there would be greppable from devtools in seconds. They live in the root `.env` under the existing `SS_` prefix and never reach the browser. The portal submits the typed text; the server decides.

## 2. Backing permission — already exists

`access/resources.py` already declares:
```python
Resource("devtools", "Developer tools", developer_only=True)
```
`developer_only` is a **hard gate** in `access/resolver.py`: it is evaluated before overrides, group gates, and the `always_viewable` floor, and keys on the literal `developer` role. Therefore:
- No permission override can grant `devtools` to anyone.
- `founder` (rank 100) cannot hold it.
- Only an actual `developer` passes.

No migration, no matrix change, no new resource. God mode rides this.

## 3. Server

### Config (`config.py` → `Settings`)
```
SS_GOD_MODE_WORDS=abracadabra,ikdfa      # comma-separated, matches SS_ALLOWED_ORIGINS convention
SS_GOD_MODE_NAV_COLOR=#00c853
```
- `god_mode_words: str = ""` → parsed to a list on use. **Empty = feature disabled entirely**; the endpoint can never succeed. This is the safe default when unconfigured.
- `god_mode_nav_color: str = "#00c853"`.
- Both go in `.env.example` with a comment stating the words must never move to a `VITE_*` var.

### Endpoint — new `api/src/serversherpa/api/routes/devtools.py`

`POST /devtools/unlock`, declared `include_in_schema=False` so it appears in neither `/docs` nor `/openapi.json` (mirrors the existing `/healthz` treatment). Requires an authenticated session (`CurrentUser`).

Body: `{"word": str}`.

Succeeds **only** when both hold:
1. a configured word matches the input, compared with `secrets.compare_digest`, and
2. `actor.access.can("devtools", "view")` is true.

- Success → `200 {"nav_color": "<SS_GOD_MODE_NAV_COLOR>"}` **and** one audit row: `entity_type="auth"`, `entity_id=str(person.id)`, `action="godmode.enable"`, no word material stored.
- Every other case — wrong word, correct word from a non-developer, no words configured — → **`404 {"code": "not_found"}`**, byte-identical. The response must not vary by reason.

Exit is client-side only (no server state exists to clear), so it is not audited. Activation is the security-relevant event.

## 4. Portal

### State — `auth/AuthContext.tsx`
Gains `godMode: boolean`, `godNavColor: string | null`, `enableGodMode(color: string)`, `exitGodMode()`. **In-memory only** — never localStorage/sessionStorage. A reload re-initialises the context and god mode is gone; session-only behaviour is a property of where the state lives, not a rule someone must remember to enforce.

### Activation — `components/CommandPalette.tsx`
Today `Enter` is handled only when `results[active]` exists, so Enter with no matches is a no-op. That becomes the hook:
- `Enter` + non-empty query + **zero results** → `POST /devtools/unlock {word: query}`. **On Enter only — never per keystroke**, so ordinary typing never reaches the server and the traffic is one request per deliberate attempt. The word travels in the request body, never a query string (a secret in a URL lands in access logs).
- `200` → `enableGodMode(nav_color)`, close the palette.
- `404` → **do nothing.** No error, no message, no state change. The palette continues to show its normal "no results".

The palette must never list, autocomplete, describe, or hint at god mode or its words.

### Nav — `layout/AppShell.tsx`
- `NavItem` gains `godOnly?: boolean`.
- The existing visibility filter becomes: `can(i.resource, 'view') && (!i.godOnly || godMode)`; sections left with no items still drop out, as today.
- **The same predicate must be applied to the CommandPalette's command list.** The palette builds commands from nav items gated on permission alone — without this, a developer with god mode off would see "Developer tools" in ⌘K, breaking the core requirement.
- When `godMode` is true: the nav element takes a `god` class with `godNavColor` supplied as a CSS custom property (background tint), and renders an **Exit** control that calls `exitGodMode()`. The control is only ever visible while active — the green nav has already announced the mode, so it leaks nothing new.

### Placeholder page
`portal/src/pages/Dev.tsx` at route `/dev`, resource `devtools`, nav section **Developer**, item flagged `godOnly: true`. `ROUTE_RESOURCE` gains `/dev → devtools`. Content: a short placeholder stating dev tooling lands here.

**Deliberate decision:** the *route* is gated by permission (`ProtectedRoute resource="devtools"`), **not** by god mode. A developer who bookmarks `/dev` reaches it with god mode off. This is correct — gating a route on client-side state would be security theatre, and god mode is an affordance, not a boundary. The nav and palette hide it; the permission protects it.

## 5. Testing

**API** (`api/tests/test_devtools.py`):
- correct word + `developer` → 200, body carries the configured colour, one `godmode.enable` audit row written, no word material in `changes`.
- **correct word + `founder` → 404** — the sharpest case: rank 100 and still refused, proving the hard gate rather than a rank check.
- correct word + `admin` → 404.
- wrong word + `developer` → 404.
- no words configured (`SS_GOD_MODE_WORDS=""`) + correct-looking input + `developer` → 404.
- all four 404 bodies byte-identical to each other.
- unauthenticated → 401 (session required before any word check).

**Portal:** vitest over the nav-filter predicate as a pure helper — `godOnly` item hidden when god mode is off, shown when on, and still hidden regardless when the actor lacks `devtools`. No dev-DB seeding.

## 6. Out of scope

Real developer tooling (the section is scaffolding); auditing exit; persisting god mode across reloads; any god-mode-driven change to server authorisation.
