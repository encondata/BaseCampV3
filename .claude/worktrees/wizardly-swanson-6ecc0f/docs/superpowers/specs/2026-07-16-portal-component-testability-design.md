# Portal component testability — design

## Problem

`portal/src/lib/api.ts:22` computes the API base URL at module scope:

```ts
const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  `http://${window.location.hostname}:8000`;
```

`vite.config.ts` declares no `test` block, so vitest runs in its default `node`
environment, where `window` is undefined. Any test that transitively imports
`lib/api.ts` dies at import with `ReferenceError: window is not defined` before a
single assertion runs.

The blast radius is the whole component tree: `AppShell` imports `AuthContext`,
`CommandPalette`, and `Topbar`, and all three import `lib/api`. This is why all
five existing test files (`lib/access.test.ts`, `lib/godmode.test.ts`,
`lib/sites.test.ts`, `lib/external.test.ts`, `lib/variables.test.ts`) test only
leaf modules with no React imports.

Verified during design: `api.ts:22` is the *only* module-scope browser-global
access in `portal/src`. Every other `window`/`document`/`navigator` reference
(`Topbar`, `ComboBox`, `settings.ts:62`, `Login.tsx`, `listTools.tsx`) sits
inside a function body or effect, so none of them run at import.

Pre-existing on `main`. Found during code review on the `status-values` branch.

## Two problems, not one

Fixing the module-scope read and enabling component *behaviour* tests are
separate concerns. Confirmed empirically with a scratch patch:

- With the read deferred, `AppShell` imports cleanly, and renders via
  `renderToString` with a mocked `useAuth` in **pure node, no DOM** — nav
  filtering is testable this way.
- `SiteEditModal`'s create-mode retry lives in an async `submit` handler gated by
  `createdId` state. Proving "retry never re-creates the site" requires firing
  submit events and awaiting state transitions. `renderToString` cannot do this;
  it needs a real DOM.

So deferring the read is necessary but not sufficient. Both changes are in scope.

## 1. Defer the API URL read

`API_URL` becomes an exported function. The LAN-fallback comment and its
behaviour are preserved verbatim.

```ts
// Default: same host the portal was loaded from, port 8000 — so LAN devices
// (phone/laptop hitting the dev box's IP) reach the API without extra config.
export function apiUrl(): string {
  return (
    (import.meta.env.VITE_API_URL as string | undefined) ??
    `http://${window.location.hostname}:8000`
  );
}
```

Four call sites substitute `${API_URL}` → `${apiUrl()}`: the refresh
(`api.ts:175`), `apiFetch` (`api.ts:215`), `loginRequest` (`api.ts:239`), and
logout (`api.ts:391`).

**No caching.** A cache is state that tests must reset, and recomputing a
template string per request is free. Behaviour is unchanged either way:
`window.location.hostname` cannot change without a page navigation, so a
per-call read and a once-at-import read always agree.

**Why exported:** it earns a direct test of the LAN fallback the comment
describes. That behaviour is currently load-bearing and unguarded.

## 2. Regression guard

`src/lib/api.test.ts`, running in the default node environment — the environment
that currently crashes:

- Importing `lib/api` does not throw. This is the test that would have caught
  the bug.
- `apiUrl()` honours `VITE_API_URL` when set, and falls back to
  `http://<hostname>:8000` when unset. Pins the LAN behaviour against future
  "simplification".

## 3. DOM environment

Add devDependencies: `jsdom`, `@testing-library/react`, `@testing-library/user-event`.

**No `test` block in `vite.config.ts`.** The default environment stays `node`, so
the five existing pure-helper tests are untouched and stay fast. Component tests
opt in per-file with a docblock:

```ts
// @vitest-environment jsdom
```

Verified this mechanism works in the installed vitest (4.1.10) by probing with a
bogus environment name. Note `environmentMatchGlobs` was removed in vitest 4, so
the docblock — not config globs — is the supported per-file mechanism.

The resulting rule is self-explaining: `lib/*.test.ts` runs in node; component
tests carry the docblock.

Existing tests import `{ it, expect }` from `vitest` explicitly, so `globals`
stays off. Component tests therefore call Testing Library's `cleanup()` in an
explicit `afterEach` rather than relying on auto-cleanup.

## 4. Proof tests

- `src/layout/AppShell.test.tsx` — renders the shell with a mocked `useAuth`;
  asserts Variables appears in the nav for a god-mode user and is absent for a
  user without the permission.
- `src/components/sites/SiteEditModal.test.tsx` — the retry. Open in create
  mode with `lib/api` mocked so `createSite` succeeds and `setSiteClients`
  fails. Submit, assert the unlinked notice renders. Submit again, assert
  `createSite` was called exactly once and `updateSite` was called on the retry.

The `SiteEditModal` test is the one that earns the change. `needsSiteCreate` and
`afterSiteClientsFailure` are already unit-tested in `lib/sites.test.ts`; what is
untested is the *wiring* — that `createdId` survives a failed link step and
re-routes the second submit. That invariant is currently defended by nothing but
the comment at the top of the file.

## Out of scope

`layout/navSections.tsx` (the `NAV_SECTIONS` hoist from the `status-values`
branch) stays as-is. It is good structure on its own merits.

No other refactoring. This change fixes the import-time read, adds the DOM
environment, and proves both with tests.
