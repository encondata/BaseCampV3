# My preferences on /me; /settings becomes System settings

**Date:** 2026-09-10 · **Status:** approved in conversation ("correct… get them
implemented") · **Branch:** `me-prefs`

## Purpose

`/settings` mixes scopes: three personal sections (Appearance, Notifications,
Account) sit next to the admin-only Administration card, under a "System"
eyebrow, and workers hold a `settings:view` grant only so they can reach
Appearance. Jimmy wants user preferences on a personal surface and
`/settings` reserved for system-level controls.

Decision: preferences move to **`/me` as a Preferences tab** (not a new
"My Settings" page) because `/me` is already the personal surface
(profile, active sessions, change password), it is ungated, and a second
personal page would split "things about me". The Account card on
`/settings` is a stale placeholder duplicated by `/me` and is deleted.

## Portal

### `/me` — tabs

- `Profile.tsx` keeps its hero (avatar, name, role line, Edit details) and
  gains a `.segmented` tab strip (`role="tablist"`, `aria-selected`)
  directly under the hero: **Profile** and **Preferences**.
- Routes: `/me` (Profile tab) and `/me/preferences` (Preferences tab); the
  strip navigates between them so links deep-link. Both render `Profile.tsx`;
  the tab is derived from the path.
- **Profile tab** = today's `profile-grid` content, unchanged.
- **Preferences tab** = new `pages/me/MePreferences.tsx` rendering the
  `set-stack` with: **Appearance** (accent, theme, density, list text size,
  the Navigation group [sidebar mode / background / text size], interface
  motion — moved verbatim from `Settings.tsx`) and **Notifications** (the
  four switches, moved verbatim). The save-state hint ("saved" / "could not
  save — changes are local only") moves with it and shows under the tab
  strip. `update()` merges into the full preferences object exactly as
  today.
- The user menu item "Settings" becomes **"Preferences"** and navigates to
  `/me/preferences`; "My profile & details" stays → `/me`.
- CommandPalette: `View my profile` stays; add `Navigate › My preferences`
  → `/me/preferences` (ungated, like the profile entry).

### `/settings` — System settings

- `Settings.tsx` becomes **System settings**: eyebrow "System", title
  "System settings", hint "Console-wide controls that affect every user."
  It renders the Administration content (`AdminControls`) for anyone with
  `settings:view`; controls are interactive only with `settings:change`
  (pass `canChange` into `AdminControls`; when false every Switch/input/
  button is disabled and a `page-hint` says "Read-only — you can see the
  current state but changing it needs the settings permission."). Read
  `AdminControls` first: if it already gates internally, reuse that.
- Nav (System section) label: **"System settings"**; palette entry label
  likewise. Resource key stays `settings` (no API change); the page is
  still gated on `settings:view`.
- Grants: unchanged. Only `staff` holds a view-only `settings` grant
  (workers have none), and a read-only view of the console-wide state is
  useful to staff, so no default or migration changes. No API work.

### Files

| File | Change |
|---|---|
| `portal/src/pages/Profile.tsx` | tab strip + route-derived tab; renders `MePreferences` on the Preferences tab |
| `portal/src/pages/me/MePreferences.tsx` (+ `.test.tsx`) | Appearance + Notifications sections moved from Settings |
| `portal/src/pages/Settings.tsx` (+ `.test.tsx`) | System settings only |
| `portal/src/components/settings/AdminControls.tsx` | `canChange` prop (or confirm internal gating) |
| `portal/src/App.tsx` | `/me/preferences` route |
| `portal/src/layout/AppShell.tsx`, `navSections.tsx`, `components/CommandPalette.tsx` | labels/links |

CSS: `settings.css` classes are reused inside the Preferences tab (import
it there); no new typography; no new allowlist entries.

## Testing

- `MePreferences.test.tsx`: the existing Settings preference tests move
  here (accent/theme/list size/navigation rows/notification switches call
  `updatePreferences` with the merged object; save-state copy).
- `Profile` tests (new `Profile.test.tsx`): tab strip renders; `/me` shows
  the profile panel; `/me/preferences` shows the Preferences sections;
  clicking a tab changes the URL.
- `Settings.test.tsx`: renders System settings with AdminControls; with
  view-only permission the controls are disabled and the read-only hint
  shows; no Appearance/Notifications/Account content remains.
- AppShell/palette tests: user menu "Preferences" → `/me/preferences`.
- Full suites + live check: `/me` tabs, `/me/preferences` saving a
  preference, `/settings` as admin and as a view-only role.

## Out of scope

Merging Developer › System Config into System settings; changing any
preference's behaviour; redesigning the profile hero.
