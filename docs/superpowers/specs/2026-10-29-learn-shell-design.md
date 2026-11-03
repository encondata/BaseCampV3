# Learn site: portal shell and Home

## Why

Signed in, the learn site is a single bare column: a small mark, a
greeting and either the training list or "You're all caught up." With
nothing due and nothing signed, the page is close to empty. Jimmy: that
"seems very cheap and not in line with the congruity of the rest of the
website". He asked for a learning portal built from the portal's own
design: **a navigation bar on the left side, a header across the top**,
where people check what is due and review what they have done.

## Goals

- Every signed-in learn page sits in the portal's shell: the portal's left
  nav (same markup and styles, tag "Learning") and the portal's top bar.
- A Home page that is the landing page after sign-in and always has
  substance, even with nothing due and nothing signed.
- Existing pages (My training, Completed training, the reader, the quiz,
  the time clock code) keep working inside the shell and adopt portal page
  headers.
- Works on a phone: below the portal's mobile breakpoint the nav is hidden
  behind a hamburger, as in the portal.

## Non-goals

- No new API: Home is built from `GET /learn/training` and
  `GET /learn/history`.
- No portal features in the top bar (search, AI, notifications, ⌘K).
- No change to the sign-in pages (code and account), signing, quizzes or
  what counts as due.
- No new prompts, votes or banners (Jimmy's no-unrequested-widgets rule).

## Behavior

**Shell** (`LearnShell`). Wraps every route inside `RequireLearner`.
- Left nav: the portal's `NavPanel` (added to the learn app's portal import
  allowlist), tag `Learning`, one section "Learning" open by default:
  Home `/home`, My training `/training`, Completed training `/history`, and
  Time clock code `/done` only when training is complete and a badge exists.
  Each item carries an icon in the portal's line-icon style.
- Nav footer: the user chip (avatar initials, name, and "Account" or
  "Learning code" as the role line) opening a menu: "Back to portal" (account
  sign-ins only, to the portal origin), then "Sign out". Sign out: an
  account calls the portal `logout()`; a code session clears the learn
  token; both land on `/`.
- Top bar: the portal `topbar` markup: a hamburger when the nav is hidden,
  crumbs `Learning / <page>`, and on the right a language button (globe)
  whose menu lists the offered languages, shown only when more than one is
  offered.
- Desktop: nav docked and expanded. At the portal's mobile breakpoint
  (`max-width: 900px`) the nav hides; the hamburger opens it as the portal's
  overlay (scrim, Escape and navigation close it).

**Home** `/home` (portal dashboard idiom: `dash-head`, `dash-kpis`,
`dash-grid`, `dash-panel`):
- Page head: eyebrow "Learning", title "Welcome back, {name}" (no name:
  "Welcome back"), hint line: "{n} to sign" when anything is open,
  otherwise "You're all caught up."
- Three KPI tiles: **To sign** (open documents, sub line: the nearest due
  date, or "Nothing due"), **Completed** (sign-offs in history, sub line:
  "Last signed {date}" or "None yet"), **Moves** (moves with training
  assigned to them, from the training groups; sub line "General training
  only" when there are none but general items exist, else "None
  assigned").
- Panel **Up next**: the open, unlocked documents (up to 5, list order)
  as rows linking to the reader, with "Continue: {title}" as the primary
  button for the first; header link "My training" → `/training`.
  Empty: a check icon, "Nothing to sign right now." and "New training shows
  up here as soon as it is assigned to you."
- Panel **Recently completed**: the 5 newest history rows (same row look as
  the history list), header link "View all ({n})" → `/history`. Empty: "Your
  signed training will appear here." and "Every document you sign stays
  here so you can reopen it any time."
- Panel **Time clock code** (only when complete with a badge): one line and
  a button to `/done`.
- Loading uses the existing `LoadState`; a failed history load only empties
  the Recently completed panel and the Completed tile shows "—".

**Landing.** Sign-in (code and account) and the invite link go to `/home`;
`/` while signed in redirects to `/home`. Pages that bounce away
(already signed, bad id, no badge) still go to `/training`.

**Existing pages in the shell.** My training and Completed training get a
portal page head (eyebrow "Learning", title, hint) in place of the old
mark-and-greeting header; their bodies stay as they are. The reader, quiz
and done screens keep their own headers and back links, inside the shell's
main column, constrained to a readable width.

## Constraints

- American English; every new string in `en.ts` with ja/ko/he convenience
  translations (the dictionaries are type-checked against English).
- Reuse portal stylesheets and markup (`chrome.css`, `dashboard.css`,
  `NavPanel`); learn-only CSS goes in `learn/web/src/styles/learn.css`.
  Any new scroll container gets the slim themed scrollbar, never the
  browser default (Jimmy's rule).
- Right-to-left (Hebrew) must not break the shell's layout.
- Portal import guardrail (`portalImports.test.ts`) stays green; anything
  NavPanel pulls in at runtime must be a learn dependency and deduped.

## Calls made without asking (Claude's)

- Home is the new landing page; My training stays one click away.
- No collapse-to-rail toggle: docked on desktop, hamburger on mobile.
  Code sign-ins have no saved preferences to remember a mode in.
- The three tiles are To sign / Completed / Moves, from data the site
  already loads.
- Language moves into the top bar (globe menu) on signed-in pages; the
  sign-in pages keep their links.
