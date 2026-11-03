# Learn Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in learn pages sit in the portal's shell (left nav + top bar), with a new Home dashboard as the landing page.

**Architecture:** A `LearnShell` layout route reuses the portal's presentational `NavPanel` and the portal's `chrome.css`/`dashboard.css` markup and classes; a slim learn top bar (hamburger, crumbs, language menu). A `Home` page composes `getTraining` + `getHistory` into KPI tiles and panels. No API changes.

**Tech Stack:** React 18 + react-router 6 + Vite + vitest/jsdom (`learn/web`), portal sources via the `@portal` alias.

**Spec:** `docs/superpowers/specs/2026-10-29-learn-shell-design.md`

## Global Constraints

- American English in all copy, comments and docs.
- Every new learn-site string goes in `learn/web/src/i18n/en.ts` AND gets a convenience translation in `ja.ts`, `ko.ts`, `he.ts` (`Dictionary` type requires every key). Strings are read with `t()` from `lib/i18n`, and components call `useLang()` so a language switch re-renders them.
- Reuse portal markup/classes (`portal-shell`, `portal-nav` via `NavPanel`, `portal-main-col`, `topbar`, `crumbs`, `tb-actions`, `icon-btn`, `pop-wrap`, `pop-menu`, `pop-item`, `pop-title`, `pop-sep`, `user-wrap`, `user-menu`, `um-*`, `user-chip`, `user-avatar`, `nav-overlay-scrim`, `nav-hamburger`, `portal-page`, `eyebrow`, `page-title`, `page-hint`, `dash-*`). Learn-only CSS goes in `learn/web/src/styles/learn.css`. Any new scroll container gets a slim themed scrollbar, never the browser default.
- Hebrew (RTL) must not break the layout: use logical properties (`inline-size`, `margin-inline-*`) in new learn CSS.
- `learn/web/src/portalImports.test.ts` must stay green: add `layout/NavPanel` to `REACT_ALLOWLIST` (its imports of `../lib/settings` and `./navSections` are `import type`); anything else from `@portal` must already be allowed (stylesheets under `styles/`, React-free `lib/*.ts`).
- Run every test suite FOREGROUND in one continuous run with a long timeout (600000 ms); never background a suite. Tests: `cd learn && npx vitest run`; build: `cd learn && npm run build`.
- Never commit `.env`, `api/.venv`, `learn/node_modules` or `portal/node_modules` (untracked symlinks in this worktree).

## Review Focus

- Signed in with a learning code (no portal account, `useAuth().person` is null): the shell renders, the chip shows the code session's first name (`getFirstName()`), role line "Learning code", no "Back to portal", Sign out clears the token and lands on `/`.
- Nothing due AND nothing signed: Home shows the full dashboard (head, three tiles, both panels with their empty states), never a lone line.
- Phone width (≤ 900px): nav hidden, hamburger opens the overlay; choosing a link or Escape closes it.
- The history request fails while training loads: Home still renders, Completed tile shows "—", Recently completed shows its empty state.
- Time clock code nav item and panel appear only when `training.complete && training.badge_uid`.

---

### Task 1: The shell (nav, top bar, account menu, routing)

**Files:**
- Create: `learn/web/src/layout/LearnShell.tsx`, `learn/web/src/layout/LearnTopbar.tsx`, `learn/web/src/layout/learnNav.tsx`, `learn/web/src/layout/LearnShell.test.tsx`
- Create: `learn/web/src/lib/learner.ts` (shared training/history load for the shell + pages; see Interfaces)
- Modify: `learn/web/src/App.tsx` (signed-in routes become children of a `RequireLearner` + `LearnShell` layout route with `<Outlet/>`; add `/home` with a placeholder element that Task 2 replaces — render `<Navigate to="/training" replace />` until then is NOT acceptable; instead create `learn/web/src/pages/Home.tsx` exporting a minimal page head only, Task 2 fills it)
- Modify: `learn/web/src/main.tsx` (import `@portal/styles/chrome.css` and `@portal/styles/dashboard.css`)
- Modify: `learn/web/src/portalImports.test.ts` (allowlist `layout/NavPanel`)
- Modify: `learn/web/src/lib/session.ts` only if a helper is needed for sign-out (e.g. export `signOutLearner`)
- Modify: `learn/web/src/i18n/{en,ja,ko,he}.ts`
- Modify: `learn/web/src/styles/learn.css`

**Interfaces:**
- Produces: `export default function LearnShell()` — layout element rendering `<Outlet />` inside `<main className="portal-main">`.
- Produces: `export function learnNavSections(opts: { showTimeClock: boolean }): NavSection[]` in `layout/learnNav.tsx` — one section, label `t('nav.section')`, items in order Home `/home`, My training `/training`, Completed training `/history`, Time clock code `/done` (only when `showTimeClock`). `resource: 'learn'` on every item.
- Produces: `export function useLearnerData(): { training: UseLoad<Training>; history: UseLoad<HistoryItem[]> }` in `lib/learner.ts`, backed by a React context the shell provides (`LearnerDataProvider` exported from the same file) so the shell (Time clock item) and pages share one load; pages outside a provider (tests) fall back to their own `useLoad`. `UseLoad<T>` is whatever `lib/useLoad.ts` returns (`{ data, error, loading, reload }`); export a type for it if it isn't exported.
- Produces: `export function learnerName(person: Person | null): { first: string; full: string }` — account person's names, else `getFirstName()` for both.
- Produces: `/` while signed in → `/home`; `SignIn` and `Start` navigate to `/home` after sign-in.

English strings (exact):
- `'nav.tag': 'Learning'`
- `'nav.section': 'Learning'`
- `'nav.home': 'Home'`
- `'nav.training': 'My training'`
- `'nav.history': 'Completed training'`
- `'nav.timeClock': 'Time clock code'`
- `'nav.open': 'Open navigation'`
- `'shell.account': 'Account'`
- `'shell.codeSession': 'Learning code'`
- `'shell.backToPortal': 'Back to portal'`
- `'shell.signOut': 'Sign out'`
- `'shell.language': 'Language'`

- [ ] **Step 1: Write the failing tests** in `LearnShell.test.tsx` (`@vitest-environment jsdom`; mock `fetch` per URL as existing page tests do; stub `window.matchMedia`):
  - renders the nav with tag "Learning" and links Home `/home`, My training `/training`, Completed training `/history`; no "Time clock code" link when training is not complete; with `complete: true, badge_uid: 'B1'` the link to `/done` appears.
  - top bar crumbs read "Learning" then the current page's nav label (e.g. at `/history`: "Completed training").
  - code session (token in sessionStorage with `n: 'Wanda'`, no account): chip shows "Wanda" and "Learning code"; opening the chip menu shows "Sign out" and no "Back to portal"; clicking Sign out removes `ss.learn.token` and routes to `/`.
  - account session (mock `useAuth` or the AuthProvider's `/auth/me` per the existing account tests' approach): chip shows the display name and "Account"; menu shows "Back to portal" and "Sign out"; Sign out calls `logout` and routes to `/`.
  - with `matchMedia('(max-width: 900px)')` matching: no docked nav links visible; a button "Open navigation" opens the overlay (`.portal-nav.overlay`), clicking a nav link closes it, Escape closes it.
  - language button appears only when two or more languages are offered; its menu lists them and clicking one calls `setLang`.
  - `/` with a learn token redirects to `/home`.
- [ ] **Step 2: Run** `npx vitest run` in `learn/` → the new tests FAIL.
- [ ] **Step 3: Implement.** Model mode handling on `portal/src/layout/AppShell.tsx` (mobile query, overlay + scrim, Escape) without nav-mode preferences: docked `expanded` on desktop, `hidden` + hamburger at ≤ 900px. Render `NavPanel` with `tag={t('nav.tag')}`, `openSection` = the one section (toggling it is allowed), and a footer with the user chip + menu copied from AppShell's markup (no Preferences/profile items, no nav-toggle, no god mode). Top bar: `<header className="topbar">` with the hamburger (when hidden), `.crumbs` (`t('nav.section')` / current item label, matched by `pathname.startsWith(item.to)`; the reader/quiz under `/training/…` show My training), and `.tb-actions` holding the language `pop-wrap` (globe icon, `pop-menu` of offered languages, the current one marked). "Back to portal" is an `<a>` to `siblingOrigin('portal', location)` from `@portal/lib/siblingOrigin` (fall back to `${location.protocol}//${location.hostname}:5173`, as `wiki/web/src/lib/origins.ts` does). Code sign-out: `clearToken()` then navigate `/`; account: `await logout()` then navigate `/`. Every icon follows the portal's inline 24×24 stroke SVG style.
- [ ] **Step 4: Run** `npx vitest run` → all pass (update existing tests whose routes/landing changed: SignIn/Start now land on `/home`); `npm run build` → succeeds.
- [ ] **Step 5: Commit** — `feat(learn): portal shell with left nav and top bar on signed-in pages`.

---

### Task 2: Home dashboard

**Files:**
- Modify: `learn/web/src/pages/Home.tsx` (from Task 1's stub)
- Create: `learn/web/src/pages/Home.test.tsx`
- Modify: `learn/web/src/i18n/{en,ja,ko,he}.ts`, `learn/web/src/styles/learn.css`

**Interfaces:**
- Consumes: `useLearnerData()`, `learnerName()` (Task 1); `HistoryList` (`components/HistoryList.tsx`, prop `items`, optional `from`); `TaskRow`; `dueDay`/`signedDay` from `lib/format`; `LoadState`.

English strings (exact):
- `'home.title': 'Welcome back, {name}'`
- `'home.titleNoName': 'Welcome back'`
- `'home.toSignHint': '{n} to sign'`
- `'home.caughtUp': "You're all caught up."`
- `'home.kpiToSign': 'To sign'`
- `'home.kpiCompleted': 'Completed'`
- `'home.kpiMoves': 'Moves'`
- `'home.nextDue': 'Next due {date}'`
- `'home.nothingDue': 'Nothing due'`
- `'home.lastSigned': 'Last signed {date}'`
- `'home.noneYet': 'None yet'`
- `'home.generalOnly': 'General training only'`
- `'home.noneAssigned': 'None assigned'`
- `'home.upNext': 'Up next'`
- `'home.allTraining': 'My training'`
- `'home.upNextEmpty': 'Nothing to sign right now.'`
- `'home.upNextEmptyHint': 'New training shows up here as soon as it is assigned to you.'`
- `'home.recent': 'Recently completed'`
- `'home.viewAll': 'View all ({n})'`
- `'home.recentEmpty': 'Your signed training will appear here.'`
- `'home.recentEmptyHint': 'Every document you sign stays here so you can reopen it any time.'`
- `'home.timeClock': 'Your training is complete. Show your time clock code at the station.'`
- `'home.showCode': 'Show my code'`
- Reuse the existing `'training.continue'` ("Continue: {title}") for the primary button.

- [ ] **Step 1: Write the failing tests** (`Home.test.tsx`, jsdom, fetch mocked per URL, rendered inside the router at `/home`; a provider-less render must work):
  - nothing due + empty history: heading "Welcome back, Wanda" (code session first name) or "Welcome back"; hint "You're all caught up."; tiles To sign `0` / "Nothing due", Completed `0` / "None yet", Moves `0` / "None assigned"; Up next empty texts; Recently completed empty texts; no "Continue" button; no time clock panel.
  - two open items (one in a move group with `due_on`, one general) + 7 history rows: hint "2 to sign"; To sign `2` with "Next due {formatted date}"; Completed `7` with "Last signed {date of newest}"; Moves `1`; Up next lists both titles as links to `/training/<id>` and a "Continue: <first title>" link; Recently completed lists exactly 5 rows and a "View all (7)" link to `/history`; "My training" link to `/training`.
  - general items only: Moves `0` / "General training only".
  - locked items are not in Up next and don't count toward To sign? — they DO count toward To sign (they are open), but are not listed or offered as Continue.
  - history request 500s: page renders; Completed tile value "—"; Recently completed shows its empty texts.
  - `complete: true, badge_uid: 'B1'`: the time clock panel shows `home.timeClock` text and a "Show my code" link to `/done`.
- [ ] **Step 2: Run** `npx vitest run` → new tests FAIL.
- [ ] **Step 3: Implement** with the portal dashboard markup: `<div className="portal-page learn-home">`, a head (`eyebrow` `t('nav.section')`, `h1.page-title`, `p.page-hint`), `.dash-kpis` of three `.dash-kpi` (`.dash-kpi-label`, `.dash-kpi-value`, `.dash-kpi-sub`), `.dash-grid` with `.dash-panel`s (`.dash-panel-head`, `.dash-panel-title`, `.dash-panel-link`), empty states as an icon + `.dash-panel-empty` title + hint. Up next rows reuse `TaskRow`; Recently completed reuses `HistoryList`. Panels stack to one column at ≤ 900px. "To sign" counts items with status ≠ `signed`; "Next due" is the earliest `due_on` among groups with an open item.
- [ ] **Step 4: Run** `npx vitest run` → all pass; `npm run build` → succeeds.
- [ ] **Step 5: Commit** — `feat(learn): Home dashboard with to-sign, completed and up-next panels`.

---

### Task 3: Existing pages inside the shell

**Files:**
- Modify: `learn/web/src/pages/Training.tsx`, `History.tsx`, `Reader.tsx`, `Quiz.tsx`, `Done.tsx` (+ their tests where assertions change)
- Modify: `learn/web/src/styles/learn.css`, `learn/web/src/i18n/{en,ja,ko,he}.ts` (only if a hint string is added)

**Interfaces:**
- Consumes: `useLearnerData()` (Task 1) — Training and History read from it instead of their own loads when inside the provider.

- [ ] **Step 1: Write/adjust tests:** Training renders an eyebrow "Learning" and an `h1` "My training" (key `nav.training`) with the greeting moved into the hint (`training.hi`/`training.hiNoName`) and no `.learn-top` mark; it no longer renders `LanguageLinks` (the top bar owns language). History renders the same page head with title "Completed training" and keeps its empty text and list. Reader/Quiz/Done tests keep passing unchanged in behavior.
- [ ] **Step 2: Run** → the changed assertions FAIL.
- [ ] **Step 3: Implement:** wrap Training/History content in `portal-page` with the portal head; keep their bodies. Reader/Quiz/Done keep their own headers; give their containers a readable max inline size (about 760px) centered in the main column, with comfortable padding on phones. Remove the standalone `.learn-page` background/full-height rules that fight the shell (keep the classes the bodies use). Keep the `learn-langs` styles used by the sign-in pages.
- [ ] **Step 4: Run** `npx vitest run` → all pass; `npm run build` → succeeds.
- [ ] **Step 5: Commit** — `feat(learn): training, history, reader, quiz and done pages in the shell`.
