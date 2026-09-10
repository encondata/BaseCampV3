# My Preferences / System Settings Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move user preferences (Appearance incl. Navigation, Notifications) from `/settings` to a Preferences tab on `/me`; delete the stale Account card; make `/settings` a System settings page (Administration only, read-only for view-only roles).

**Architecture:** Pure portal refactor — no API or preference-storage changes. `Profile.tsx` gains a route-derived `.segmented` tab strip and renders the new `pages/me/MePreferences.tsx` on the Preferences tab. `Settings.tsx` shrinks to the Administration card and passes `canChange` into `AdminControls`. Labels/links in the user menu, nav, and palette follow.

**Tech Stack:** React 18 + TS + Vitest, react-router.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-10-me-preferences-design.md`.
- Routes: `/me` (Profile tab), `/me/preferences` (Preferences tab); `/settings` stays gated on `settings:view`. No API changes; no grant changes.
- Idioms: `.segmented` with `role="tablist"` / `aria-selected` for the tab strip (see `Initiatives.tsx`); keep `set-stack` / `set-section` / `set-row` markup for the moved sections (import `styles/settings.css` where used); no raw native controls; typography guardrail (`portal/src/styles/listTypography.test.ts`) green with no new allowlist entries.
- Portal tests FOREGROUND from the worktree's `portal/`, one call, timeout 600000ms: `npx vitest run <files> && npx tsc --noEmit -p .`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` by explicit path.

---

### Task 1: `MePreferences` component + `/me` tabs + routes/links

**Files:** Create `portal/src/pages/me/MePreferences.tsx`, `portal/src/pages/me/MePreferences.test.tsx`, `portal/src/pages/Profile.test.tsx`; Modify `portal/src/pages/Profile.tsx`, `portal/src/App.tsx` (add `/me/preferences` → `<Profile />` next to the existing `/me` route, same gating), `portal/src/layout/AppShell.tsx` (user-menu item "Settings" → "Preferences", `go('/me/preferences')`), `portal/src/components/CommandPalette.tsx` (add `{ group: 'Navigate', label: 'My preferences', icon: NAV_ICON, run: () => navigate('/me/preferences') }` after "View my profile"), `portal/src/layout/AppShell.test.tsx` (if it asserts the menu item label), `portal/src/pages/Settings.test.tsx` (the preference tests move out in Task 2 — leave for now).

**Produces:** `export default function MePreferences()` — self-contained: reads `useAuth().preferences/updatePreferences`, owns the `saveState` hint, renders the Appearance section (accent swatches, theme, density, list text size, Navigation group [sidebar mode / background / text size], interface motion) and the Notifications section — all markup moved VERBATIM from `Settings.tsx` lines ~56–213 (including the `update()` merge helper, `isCustomNavBg`, and `notifRow`).

- [ ] Write `MePreferences.test.tsx` by moving the preference tests from `Settings.test.tsx` (same mock shape; render `<MePreferences />`): accent/list size/navigation rows/notification switches call `updatePreferences` with the merged object; save-state "saved" appears after a successful update.
- [ ] Write `Profile.test.tsx`: mock `../auth/AuthContext` (person, roles, preferences, updatePreferences, applyProfile) and `../lib/api` (`getMyProfileRequest`/whatever `Profile.tsx` calls to load the profile + sessions — read the imports at lines 13–22 and mock every function it uses to resolve immediately); render inside `MemoryRouter initialEntries={['/me']}` with `<Routes><Route path="/me" element={<Profile/>}/><Route path="/me/preferences" element={<Profile/>}/></Routes>`; assert: tab strip has two tabs with `role="tab"`, `/me` shows the "Profile" panel heading and not "Appearance"; `/me/preferences` shows "Appearance" and "Notifications" and not the Profile panel; clicking the Preferences tab changes the location to `/me/preferences`.
- [ ] Implement `MePreferences.tsx` (move code; `import '../../styles/settings.css'`), then `Profile.tsx`: `const onPrefs = useLocation().pathname.startsWith('/me/preferences')`; under the hero render
  ```tsx
  <div className="segmented me-tabs" role="tablist">
    <button role="tab" aria-selected={!onPrefs} className={!onPrefs ? 'on' : ''} onClick={() => navigate('/me')}>Profile</button>
    <button role="tab" aria-selected={onPrefs} className={onPrefs ? 'on' : ''} onClick={() => navigate('/me/preferences')}>Preferences</button>
  </div>
  ```
  then `{onPrefs ? <MePreferences /> : <div className="profile-grid">…existing…</div>}`. The hero and its Edit button stay on both tabs (Edit details only makes sense on Profile — hide the hero's Edit button on the Preferences tab). Add a small layout rule in `profile.css` for `.me-tabs { margin: 14px 0 18px }` (layout only).
- [ ] App/AppShell/CommandPalette edits as listed; update any AppShell test asserting the "Settings" menu label.
- [ ] Run `npx vitest run src/pages/me src/pages/Profile.test.tsx src/layout src/components/CommandPalette.test.tsx src/styles/listTypography.test.ts && npx tsc --noEmit -p .` (drop missing paths). Commit `feat(portal): Preferences tab on /me — appearance + notifications move off /settings`.

---

### Task 2: `/settings` → System settings

**Files:** Modify `portal/src/pages/Settings.tsx`, `portal/src/pages/Settings.test.tsx`, `portal/src/components/settings/AdminControls.tsx` (+ its test if one exists), `portal/src/layout/navSections.tsx` (System › "Settings" → "System settings"), `portal/src/components/CommandPalette.tsx` (`navGated('System settings', '/settings', 'settings')`).

**Consumes:** Task 1 (the preference sections are gone from Settings only after this task; both tasks are independent in files except CommandPalette.tsx — Task 2 edits a different line).

- [ ] `AdminControls` gains `canChange: boolean` (default true for safety in other callers — there are none besides Settings): when false, every `Switch`/`input`/`button` is `disabled` and the drafts are read-only; render the current state as today.
- [ ] `Settings.tsx` becomes:
  ```tsx
  const { can } = useAuth();
  const canChange = can('settings', 'change');
  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <h1 className="page-title">System settings</h1>
      <p className="page-hint">Console-wide controls that affect every user.
        {!canChange && ' Read-only — you can see the current state but changing it needs the settings permission.'}</p>
      <div className="set-stack">
        <section className="set-section">
          <div className="set-head"><h3>Administration</h3><p>Read-only maintenance mode, background services, and the broadcast banner.</p></div>
          <AdminControls canChange={canChange} />
        </section>
      </div>
    </div>
  );
  ```
  Remove every preference import (`ACCENTS`, `NAV_*`, `Switch` if unused, `UiPreferences`).
- [ ] `Settings.test.tsx`: replace the moved preference tests with: renders "System settings" + Administration; with `can('settings','change') === false` the read-only hint shows and the Switches are disabled; no "Appearance"/"Notifications"/"Account" text.
- [ ] Nav + palette label edits; update any test pinning the "Settings" nav label (grep `'Settings'` in `portal/src/layout/*.test.tsx`, `CommandPalette.test.tsx`).
- [ ] Run `npx vitest run src/pages/Settings.test.tsx src/components/settings src/layout src/styles/listTypography.test.ts && npx tsc --noEmit -p .`. Commit `feat(portal): /settings is System settings — administration only, read-only for view-only roles`.

---

### Task 3: Verification (controller-led)

- [ ] Full portal suite + tsc + build; API suite unaffected (no api/ changes) — run `tests/test_access_registry.py` only as a sanity check.
- [ ] Live on worktree servers: `/me` tabs; `/me/preferences` changes a preference and it persists; user menu → Preferences; palette entries; `/settings` as the dev admin (controls live) and via a view-only session if one is handy (else assert via the unit test); nav label.
- [ ] Fast-forward `main`/`reports`, push.
