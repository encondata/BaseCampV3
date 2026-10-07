# Help button shows when a guide exists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The top bar's ? (Help for this page) turns the user's accent color when the current screen has a linked wiki guide, so people notice it.

**Why:** Jimmy didn't know the ? existed. Design agreed in chat 2026-10-06.

**Tech Stack:** React + TypeScript, vitest.

## Global Constraints

- File: `portal/src/components/HelpButton.tsx` (+ `HelpButton.test.tsx`), CSS in `portal/src/styles/chrome.css` next to `.icon-btn.ai-glow`.
- On mount and on every pathname change, when the user has `wiki:view`, look the screen up with the existing `lookupHelp(apiFetch, helpContext('portal', pathname))`. Cache results per context string in a module-level `Map` for the session (found or not-found); a lookup error is not cached and leaves the button in its normal state. Stale lookups (pathname changed) are ignored — reuse/extend the existing `seq` guard.
- Found → the button gets class `has-guide`; `data-tip` and `aria-label` become `Guide for this page: “{title}”` (curly quotes as written). Not found / unknown → unchanged (`Help for this page`).
- CSS: `.icon-btn.has-guide, .icon-btn.has-guide:hover { color: var(--accent); }` with a one-line comment. No other style change.
- Click when the guide is known: open it immediately with `openInNewTab(url)` (no lookup, so the browser won't block it); if blocked, the existing popover link. Click when not found or unknown: today's behavior (fresh lookup → open, or "No guide for this page yet" + Link a guide for wiki admins, or the error line); a fresh lookup that now finds a guide updates the cache and the accent.
- Export a `clearHelpCache()` (for tests). Existing tests keep passing (adjust only for the extra mount-time lookup).
- American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`.
- From `portal/`, foreground: `npx vitest run src/components/HelpButton.test.tsx src/layout`, full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: accent ? when a guide exists

- [ ] Tests first: guide found on load → `has-guide` class and the tooltip/aria-label with the title; not found → normal; lookup error → normal and no popover; a click with a known guide opens it without a second lookup (assert the fetch count) ; navigating to another path re-looks-up and drops the class when that path has none; navigating back uses the cache (no new fetch); a not-found click that now finds a guide turns the accent on; hidden without wiki:view (existing). Run → FAIL. Implement → PASS. Full suite, tsc, build. Commit `feat(portal): the ? turns your accent color when this screen has a guide`.
