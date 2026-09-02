# Labels Printers Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Printers placeholder page as the LAST item of the Labels nav section.

**Architecture:** Pure registration-point change mirroring the section's existing items; no new components, no schema.

**Tech Stack:** React/TS/vitest (portal), one-line server registry edit.

**Spec:** `docs/superpowers/specs/2026-09-02-labels-printers-placeholder-design.md`

## Global Constraints

- Suites FOREGROUND, one continuous call, timeout 600000ms — never background/Monitor/end-turn-waiting. Portal: `cd portal && npm test` (747) + `npm run build`. API: only if `access/resources.py` edits trigger test changes — run `cd api && .venv/bin/pytest tests/test_access_registry.py -v` focused; full API suite NOT required for a routes-tuple addition unless that focused run fails.
- Item order after the change: `/labels/print`, `/labels/templates`, `/labels/generate`, `/labels/printers`.
- Resource stays `labels` everywhere; no grants/migration changes.

---

### Task 1: Printers placeholder + registrations

**Files:**
- Modify: `portal/src/layout/navSections.tsx` (fourth Labels item, distinct device-style icon)
- Modify: `portal/src/App.tsx` (route with `<Placeholder eyebrow="Labels" title="Printers" hint="Registered Zebra and Brother label printers — configuration and status." />` inside `<ProtectedRoute resource="labels">`)
- Modify: `portal/src/components/Topbar.tsx` (CRUMBS `'/labels/printers': ['Labels', 'Printers']` + PAGES entry matching neighbors' shape)
- Modify: `portal/src/components/CommandPalette.tsx` (`...navGated('Printers', '/labels/printers', 'labels'),`)
- Modify: `portal/src/lib/access.ts` (`'/labels/printers': 'labels',`)
- Modify: `api/src/serversherpa/access/resources.py` (append `"/labels/printers"` to the `labels` Resource routes tuple)
- Test: `portal/src/layout/labelsNav.test.tsx` (extend the items assertion)

**Interfaces:** consumes existing patterns only; produces nothing downstream.

- [ ] **Step 1: Extend the nav test (red)** — in `labelsNav.test.tsx`, change the expected items array to

```ts
  expect(section.items.map((i) => i.to)).toEqual([
    '/labels/print', '/labels/templates', '/labels/generate',
    '/labels/printers',
  ]);
```

- [ ] **Step 2: Run → FAIL** (`cd portal && npx vitest run src/layout/labelsNav.test.tsx`)
- [ ] **Step 3: Implement all six file edits.** Nav item (icon deliberately distinct from Print Labels' printer glyph):

```tsx
      {
        to: '/labels/printers',
        label: 'Printers',
        resource: 'labels',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="10" rx="2" />
            <path d="M7 7V4h10v3M8 17v3h8v-3" />
            <path d="M17 11h.01" />
          </svg>
        ),
      },
```

Other edits mirror each file's existing `/labels/*` entries exactly. Before editing `api/src/serversherpa/access/resources.py`, grep api/tests for any assertion pinning the labels routes tuple (`grep -rn "labels/printers\|/labels/generate" api/tests`) and update it too if one exists.

- [ ] **Step 4: Run focused (`npx vitest run src/layout/labelsNav.test.tsx src/lib/access.test.ts`) → PASS; `cd api && .venv/bin/pytest tests/test_access_registry.py -v` → PASS; FULL portal suite + `npm run build` → green.**
- [ ] **Step 5: Commit** — `feat(portal): Printers placeholder closes the Labels section`
