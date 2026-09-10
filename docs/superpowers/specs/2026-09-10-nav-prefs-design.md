# Nav preferences — collapsible sidebar, background color, text size

**Date:** 2026-09-10 · **Status:** approved in conversation · **Branch:** `nav-prefs`

## Purpose

The left nav is a fixed 248px column with one look. Jimmy wants to (1)
minimize or hide it to get the width back, and (2) pick its background
color and text size from Settings. All three are per-user preferences that
follow the account, like accent and list text size already do.

## Preferences (server)

`UiPreferences` (api/src/serversherpa/api/schemas.py, stored in
`user_accounts.ui_prefs` JSONB, `extra="ignore"`) gains:

| key | type | default |
|---|---|---|
| `nav_mode` | `Literal["expanded", "rail", "hidden"]` | `"expanded"` |
| `nav_bg` | `str` — `"default"` or `#rrggbb` (validated like `accent`) | `"default"` |
| `nav_size` | `Literal["small", "default", "large", "xlarge"]` | `"default"` |

No migration: unknown keys were always ignored, missing keys take defaults.
The login/`/me/preferences` round-trip tests pin the new defaults. Invalid
values → 422 exactly like an invalid accent.

## Portal

### Applying (`lib/settings.ts`)

`DEFAULT_PREFERENCES` gains the three keys. `applyPreferences` stamps on
`.portal-shell`:

- `data-nav-mode` = `nav_mode`.
- `data-nav-size` = `nav_size` and `--nav-scale` = 0.9 / 1 / 1.12 / 1.25.
- `nav_bg`: when `default`, remove `--nav-bg`, `--nav-fg`, `--nav-fg-mute`,
  `--nav-line`, `--nav-hover` and set `data-nav-bg="default"`; when a hex,
  set `data-nav-bg="custom"` and the five variables: `--nav-bg` = the hex,
  `--nav-fg` = `readableTextColor(hex)` (`#111827` or `#ffffff`),
  `--nav-fg-mute` = fg at 62% alpha, `--nav-line` = fg at 14% alpha,
  `--nav-hover` = fg at 7% alpha (as `rgba()` strings).

`NAV_BACKGROUNDS` swatches (label → hex): Slate `#1f2937`, Navy `#0f2a4a`,
Forest `#0f2e25`, Plum `#2b1a3d`, Charcoal `#18181b`, Paper `#f3f4f6`
(a light option proves the contrast derivation). "Default" is the current
ink gradient.

### CSS

- `portal-theme.css`: nav rules reference the variables with the current
  values as fallbacks — background `var(--nav-bg, <current gradient>)`,
  label colors `var(--nav-fg-mute, #aeb9c9)` / `var(--nav-fg, var(--snow))`,
  border `var(--nav-line, var(--ink-line))`, hover
  `var(--nav-hover, rgba(232,237,244,0.05))`. Every nav font-size and the
  item icon size become `calc(<px> * var(--nav-scale, 1))`; item padding
  scales too so row height follows. The logo block does not scale.
- Shell grid: `--nav-width` becomes 248px / 64px / 0 for
  `data-nav-mode` expanded / rail / hidden, with a 0.22s width transition
  (none under `data-motion='off'`).
- Rail (`data-nav-mode='rail'`): logo shows the mark only; section
  headers render as 40px icon buttons (section icons, new) centred in the
  rail; the open section's items appear in a **flyout** panel positioned
  to the right of its icon (`position: fixed`, computed from the button's
  rect, same styling as `.pop-menu` but on the nav palette); the user chip
  collapses to the avatar; the collapse toggle shows only its icon.
- Hidden (`data-nav-mode='hidden'`): the nav column is 0 wide and
  `visibility: hidden`; the top bar gains a hamburger `icon-btn` at its
  left; clicking it (or Ctrl/⌘+B) renders the full nav as an **overlay**
  (`.nav-overlay` scrim + the same `<nav>` markup, `position: fixed`,
  width 248px, slides in from the left) that closes on navigation,
  outside click, or Escape.
- Below 900px viewport width the shell behaves as `hidden` regardless of
  preference (`@media (max-width: 900px)` sets the same column width and
  the hamburger shows); the stored preference is untouched.
- Typography guardrail: the nav selectors that already carry font-size are
  allowlisted; changing their declarations to `calc()` is fine. New
  rail/overlay selectors must not declare font-size/family/weight/
  line-height/min-height (they only change layout), so no new allowlist
  entries.

### AppShell (`layout/AppShell.tsx`)

- Reads `preferences.nav_mode`; a `navMode` derived value also honours the
  viewport (`useMediaQuery('(max-width: 900px)')` → `hidden`).
- **Collapse toggle** at the bottom of the nav (above the user chip): a
  button "Collapse" / "Hide" / "Expand" cycling expanded → rail → hidden →
  expanded, saving via the same `updatePreferences` path Settings uses
  (`useAuth().updatePreferences` — see how Settings' `update` is wired).
  Keyboard shortcut Ctrl/⌘+B does the same cycle (ignored when focus is in
  an input/textarea/contenteditable, and when the command palette is open).
- **Section icons**: `NavSection` gains `icon: ReactNode`; `navSections.tsx`
  gives each of the 13 sections a 24px stroke icon consistent with the item
  icons. Existing nav tests keep passing (they check items, not sections).
- **Rail flyout**: in rail mode, clicking a section icon sets `openSection`
  and renders that section's items in the flyout; clicking a link or
  outside closes it; hovering another icon switches sections. `aria-label`
  on the icon buttons = section label; `title` for the tooltip.
- **Hidden overlay**: `navOverlayOpen` state; hamburger rendered by
  `Topbar` via a new `TopbarProvider` slot (`leading: ReactNode`) so the
  shell owns the state and Topbar only renders what it's given.
- The nav markup is extracted into a `NavPanel` component
  (`layout/NavPanel.tsx`) used by both the docked column and the overlay so
  the two never drift; AppShell keeps the account menu, shortcut, and mode
  plumbing.

### Settings (`pages/Settings.tsx`)

Inside Appearance, after "List text size", a **Navigation** sub-group of
three `set-row`s:

- **Sidebar** — `seg-mini` pills Expanded / Rail / Hidden (also reachable
  from the nav's own toggle and Ctrl/⌘+B).
- **Sidebar background** — the accent-swatch control reused: Default +
  the six `NAV_BACKGROUNDS` + the custom `<input type="color">` swatch;
  `aria-label="Sidebar background: <name>"`.
- **Sidebar text size** — `seg-mini` Small / Default / Large / Extra large.

## Testing

- API: `test_preferences.py` defaults include the three keys; PUT with
  `nav_mode: "rail"`, `nav_bg: "#0f2a4a"`, `nav_size: "large"` persists
  across logins; `nav_bg: "red"` and `nav_mode: "tiny"` → 422.
- Portal: `settings.test.ts` (stamps `data-nav-mode`/`data-nav-size`/
  `--nav-scale`; custom bg sets the five vars with a light-text fg for a
  dark hex and dark-text fg for Paper; default removes them);
  `AppShell.test.tsx` (expanded renders labels; rail renders section icon
  buttons and no item labels until a flyout opens, flyout lists the items,
  clicking one navigates and closes; hidden renders the hamburger, clicking
  opens the overlay, Escape closes; the toggle cycles and calls
  `updatePreferences` with the next mode; Ctrl+B cycles; Ctrl+B in an input
  is ignored); `Settings.test.tsx` (three new rows, each control calls
  `update` with the right key/value; custom color input updates `nav_bg`);
  `navSections.test` (every section has an icon). Typography guardrail
  green with no new allowlist entries.
- Live: all three modes, flyout, overlay, shortcut, a dark and a light
  custom background, each text size, and the < 900px behaviour via
  `resize_window`.

## Out of scope

Per-section pinning, reordering nav items, remembering which flyout was
open, per-device (non-account) overrides, a nav font-family choice.
