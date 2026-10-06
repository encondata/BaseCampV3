# Dialog scrollbars inside rounded corners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a dialog (or a rounded scroll box inside one) scrolls, its scrollbar stays inside the rounded corners, in the portal, kiosk and wiki; a guardrail test keeps it that way.

**Why:** Chromium does not clip an element's scrollbar to its `border-radius`, so `.modal-card` (`border-radius: 16px; overflow-y: auto`) shows a square scrollbar running through its rounded top-right and bottom-right corners (Jimmy's screenshot of the model edit dialog, 2026-10-06). Verified in the browser pane: a transparent `::-webkit-scrollbar-track` with `margin-block: 18px` and a padded, rounded thumb keeps the bar clear of both corners.

**Tech Stack:** CSS, vitest.

## Global Constraints

- One grouped rule set in `portal/src/styles/chrome.css`, right after the `.modal-card` rule (wiki and kiosk load this file through `@portal/styles/chrome.css`). Selector list, exactly these (the rounded scroll boxes that live in dialogs): `.modal-card`, `.otp-card`, `.ini-picker-list`, `.zp-log pre`, `.wiki-template-preview`, `.wiki-picker-box`, `.wiki-import-list`.
- CSS (verbatim, selector list written once as `:is(...)` in each rule):

```css
/* Dialog scrollbars stay inside the rounded corners. Chromium doesn't clip a
   scrollbar to border-radius, so a scrolling dialog showed a square bar
   through its rounded corners. A transparent track that stops 18px short of
   each end (past every radius here) and a slim, padded thumb fix it. One
   list for every rounded scroll box that lives in a dialog, in the portal,
   kiosk and wiki (both load this file); styles/roundedScrollbars.test.ts
   makes every new rounded scroll box join this list or say why not. */
:is(.modal-card, .otp-card, .ini-picker-list, .zp-log pre,
    .wiki-template-preview, .wiki-picker-box, .wiki-import-list)::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}
:is(.modal-card, .otp-card, .ini-picker-list, .zp-log pre,
    .wiki-template-preview, .wiki-picker-box, .wiki-import-list)::-webkit-scrollbar-track {
  background: transparent;
  margin-block: 18px;
  margin-inline: 18px;
}
:is(.modal-card, .otp-card, .ini-picker-list, .zp-log pre,
    .wiki-template-preview, .wiki-picker-box, .wiki-import-list)::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--muted, #51606f) 45%, transparent);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 999px;
}
:is(.modal-card, .otp-card, .ini-picker-list, .zp-log pre,
    .wiki-template-preview, .wiki-picker-box, .wiki-import-list)::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--muted, #51606f) 65%, transparent);
}
:is(.modal-card, .otp-card, .ini-picker-list, .zp-log pre,
    .wiki-template-preview, .wiki-picker-box, .wiki-import-list)::-webkit-scrollbar-corner {
  background: transparent;
}
/* Firefox has no ::-webkit-scrollbar; give it the slim, trackless bar. Only
   there: in Chromium, scrollbar-width/color would override the rules above. */
@supports not selector(::-webkit-scrollbar) {
  :is(.modal-card, .otp-card, .ini-picker-list, .zp-log pre,
      .wiki-template-preview, .wiki-picker-box, .wiki-import-list) {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--muted, #51606f) 45%, transparent) transparent;
  }
}
```

- Guardrail `portal/src/styles/roundedScrollbars.test.ts`, styled like `portal/src/styles/naturalSort.test.ts`: scan every `.css` under `portal/src`, `kiosk/src` and `wiki/web/src` (skip `node_modules`); strip comments; for each rule whose declarations include `overflow`, `overflow-x` or `overflow-y` set to `auto` or `scroll` AND a `border-radius` that isn't `0`/`0px`, every selector in its (comma-split, whitespace-normalized) selector list must be either in the chrome.css `:is(...)` list (parse it from the `::-webkit-scrollbar-track` rule in chrome.css) or in an explicit `NOT_IN_A_DIALOG` map `{ selector: reason }`. Initial map (verbatim reasons):
  - `.combo-menu`: `dropdown list, not a dialog surface (its menu floats over the page)`
  - `.tb-results`: `top bar search results dropdown`
  - `.itl-scroll`: `initiatives timeline page`
  - `.lbl-code`: `label builder code panel on a page`
  - `.sys-log-body`: `process logs page`
  - `.wiki-search-menu`: `wiki search dropdown`
  Also fail when: a `NOT_IN_A_DIALOG` key or a chrome.css list entry no longer matches any rounded scroll rule (stale), or the chrome.css track rule lacks `margin-block`. Violation text: `<file>: <selector> scrolls inside rounded corners — add it to the dialog scrollbar list in styles/chrome.css, or to NOT_IN_A_DIALOG with a reason`. Include fixture tests of the parser on strings (a rounded `overflow-y: auto` rule is found; `border-radius: 0` is ignored; comma selectors split; comments ignored).
- Don't touch `ComboBox.tsx`, `TagInput.tsx` or `portal/src/styles/modalDropdowns.test.ts` (another session owns them). Don't change any other CSS.
- American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`.
- Checks from `portal/`, foreground: `npx vitest run src/styles`, full `npx vitest run`, `npx tsc -b`, `npm run build`; also `cd ../kiosk && npx tsc -b` and the wiki build if they import chrome.css (they do: `wiki/web/src/main.tsx`, `kiosk/src/main.tsx`) — run `npm run build` in `kiosk/` and `wiki/` only if their node_modules exist (symlink the main checkout's if needed, as portal's is).

---

### Task 1: the CSS and the guardrail

**Files:**
- Modify: `portal/src/styles/chrome.css`
- Create: `portal/src/styles/roundedScrollbars.test.ts`

- [ ] Step 1: write the guardrail (fixture tests + repo scan). Run `npx vitest run src/styles/roundedScrollbars.test.ts` → the repo scan FAILS (the chrome.css list doesn't exist yet).
- [ ] Step 2: add the CSS verbatim after the `.modal-card` rule in chrome.css. Re-run → PASS. Temporarily remove one selector from the list to prove the guardrail fails with the expected message, then restore it (say so in the report).
- [ ] Step 3: full portal `npx vitest run` (the list-typography guardrail must still pass), `npx tsc -b`, `npm run build`; kiosk/wiki builds as available.
- [ ] Step 4: commit `fix(ui): dialog scrollbars stay inside rounded corners; guardrail for rounded scroll boxes`.
