# Person Photo Hover Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Hovering any person's photo in the portal shows the whole photo at 240 px beside it.

**Architecture:** One shared `PhotoPreview` wrapper component (portaled popover, hover delay, viewport placement) applied at every call site that renders a person's `avatar_url`.

**Tech Stack:** React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-avatar-hover-preview-design.md` — binding.

## Global Constraints

- 240 × 240 px max image, `object-fit: contain`, no circle/crop mask, name under it, card styling matching the portal's popovers.
- Opens after 300 ms hover; closes on mouse leave, scroll, Escape, unmount. Only when a photo exists.
- Beside the avatar, flips left near the right edge, clamped in the viewport; `pointer-events: none`.
- Portaled into `trigger.closest('.portal-shell') ?? document.body`.
- No change to click behavior anywhere.
- Every portal call site that renders a person's photo, incl. the AppShell user chip and AvatarUpload.
- Portal guardrails in `portal/src/styles/*.test.ts` pass; no inline font styles; American English.
- Never git stash. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/avatar-preview`)

`cd portal && npx vitest run <files>`; before committing: full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: PhotoPreview component

**Files:** create `portal/src/components/PhotoPreview.tsx` + test; CSS in an existing or new stylesheet under `portal/src/styles/` (follow the guardrails).

**Produces:** `PhotoPreview({ src: string | null | undefined, name: string, children })` — renders children unchanged when `src` is empty.

- [ ] Step 1: failing tests (no preview without src; opens after 300 ms not before; closes on leave, scroll, Escape; portaled into `.portal-shell`; contain + 240 px; name shown; flips near the right edge).
- [ ] Step 2–4: implement; run tests, full vitest, tsc, build. Step 5: commit `feat(portal): PhotoPreview — larger uncropped photo on hover`.

### Task 2: Apply everywhere

**Files:** every portal file rendering a person's `avatar_url` (see the spec's list; grep `avatar_url` to confirm none are missed) + a guardrail test that every `<img src={…avatar_url…}>` in portal/src is wrapped by `PhotoPreview` (or listed with a reason).

- [ ] Step 1: failing guardrail test. Step 2: wrap each call site. Step 3: full vitest, tsc, build. Step 4: commit `feat(portal): photo hover preview on every person avatar`.
