# Label builder — polish backlog

Date: 2026-10-20. Source: the whole-branch review of `label-builder` (nine
reviewers, two-lens verification) and the deferred minors from its thirteen
task reviews. Jimmy chose to merge after the Important fixes and work these
later. None blocks designing or printing a label. Items reference the
spec (`docs/superpowers/specs/2026-10-19-label-builder-design.md`) and the
review ids as recorded in the SDD ledger at the time; file paths are as of
the merge.

Done before the merge (not here): the API fix wave (input caps, rank-80
samples, tree save races, samples-only saves, size changes flowing to
`design.size`, typed preview values, seed hardening, Code 128 `>` and
static-text newlines) and the four Important builder defects (count caps
mirrored in the portal, the stale drag base after a focus-blur commit,
height-driven resize scaling the font proportionally, W/H boxes shrinking a
QR).

## Portal (`portal/`)

1. **Bold with no Bold file is silent.** `useBuilderFonts.ts`, `fonts.ts`,
   `zplPreview.ts`, `CanvasElement.tsx`: the canvas and preview draw Regular
   when the library lacks a family's Bold file while the ZPL references
   `_B.TTF`. Ruling: make it a visible builder error (banner naming family
   and weight, element in the error style); `fauxBold()` keeps the static
   `FONT_FAMILIES` rule. The API side (unused `font_objects` plumbing)
   was already removed.
2. **`/` and `⌘/` on shifted layouts.** `shortcuts.ts`: for punctuation
   bindings the typed character should win regardless of Shift (AZERTY,
   German/Swiss ⇧7); add an AZERTY `/` case to `shortcuts.test.ts`.
3. **`deleteLabelTemplate()` deactivates.** `lib/api.ts`: rename to
   `deactivateLabelTemplate` (one caller in `LabelTemplates.tsx`), use
   `templatePath(id)`; `deleteLabelTemplateForGood` stays the only delete.
4. **History: undo inside an open gesture; no-op steps.** `history.ts`:
   undo/redo during a gesture should reopen it at the new present; a
   gesture ending where it started should record nothing; `canRedo()` false
   while a gesture is open.
5. **Static-text newlines on the canvas.** `CanvasElement` `wrap()` should
   split on `\n` as well as spaces when `lines > 1` (the compiler now emits
   `\&`).
6. **Field drag onto the canvas does nothing.** `FieldPanel.tsx` sets a
   `FIELD_DRAG_TYPE` payload nobody reads: add `onDragOver`/`onDrop` on the
   stage placing the field at the drop point with snap, or remove
   `draggable`.
7. **Tab is captured from `document.body`.** `useBuilderShortcuts.ts` /
   `Canvas.tsx`: own Tab only when focus is inside the stage or the
   placed-fields table so a keyboard user can reach the page chrome.
8. **`aria-selected` on plain `<tr>` rows.** `PlacedFieldsTable.tsx`,
   `DataTable.tsx`: use `data-selected`/`aria-current` (or `role="grid"`)
   and update the scroll-into-view query.
9. **Typography patches reach barcode/QR placements.** `builderEdits.ts`:
   `TYPESET_PARTS = isTypeset` so Inverted/font on a mixed selection never
   lands on a barcode placement (an inverted-flagged blank barcode hides).
10. **A failed face fetch drops the family's metrics and never retries.**
    `metrics.ts` / `useBuilderFonts.ts`: fetch metrics and face separately,
    keep metrics when only the face fails, retry a `failed` entry.
11. **Templates list haystacks rebuilt every render.** `LabelTemplates.tsx`:
    `useCallback` the `ownText` lambdas.
12. **List Versions… restore ignores `out_of_date`.** `LabelTemplates.tsx`
    `onRestored`: open the OutOfDateModal like the builder's restore does.
13. **Update from parent… folds 409 `not_customized` / 404 into one
    message.** `TemplateRowDialogs.tsx`: map both to specific copy.
14. **Print Labels with a printer DPI outside 203/300/600.** `PrintLabels.tsx`:
    route to the DPI picker branch; the hint names the three resolutions.
15. **Deactivate and Edit-as-raw-ZPL still use `window.confirm`.**
    `LabelTemplates.tsx`: a ConfirmDialog in `TemplateRowDialogs` with the
    report-generate header naming the children that go off.
16. **"Mixed" uses strict float inequality.** `PropertiesPanel.tsx`: compare
    numbers within 1e-6.
17. **Lost pointer release; frozen drag collapses a multi-selection.**
    `Canvas.tsx`: finish the press on `lostpointercapture` and window
    `blur`; a read-only drag keeps the selection.
18. **Leave guard misses in-app navigation.** `useLeaveGuard.ts`: `useBlocker`
    if the router is a data router.
19. **Print Labels DPI picker flashes one frame on connect.** `PrintLabels.tsx`:
    start in the reading state.
20. **Generate Labels runs list has no DPI column.** `GenerateLabels.tsx`.
21. **Dead code.** `lib/generateLabels.ts` rule-row helpers;
    `.lbp-load-card` in `labelBuilder.css`.
22. **Builder Save / Versions not gated on `labels:change`.** `LabelBuilder.tsx`,
    `VersionsModal`: disable without the permission; `saveError` for 403
    should name the missing permission.

## Kiosk and laptop edge (`kiosk/`, `kiosk_laptop/`)

23. **Test-label fallback is silent.** `TestLabelModal.tsx`: say "The
    station's template isn't downloaded yet; printing <fallback> instead."
24. **Parity goldens only at 300 DPI.** Pin `vegas_v2_203.zpl` and
    `vegas_v2_600.zpl` and assert the edge's bytes against them.
25. **Two pollers for `/edge/labels/status`.** `PrintingStation.tsx` runs a
    30 s poll while `LabelRegenScreen` polls every second: share one.
26. **Setup step 5 stays green on an unsupported schema.** `PrinterStep.tsx`
    + `GET /edge/labels/plan` (`schema_supported`): amber "<template> needs a
    laptop update to print" on the DPI and Fonts rows.
27. **`sorted(names)` in `edge/labels/generate.py`** → natural order.
28. **Spec §4.8: the kiosk's portal page shows "N templates need a laptop
    update" with the laptop's version.** Carry `labels.unsupported` and the
    edge's `SUPPORTED_SCHEMA` on the config/heartbeat the edge already sends
    on check-in; store it in the existing kiosk settings document; render an
    amber note on `/hardware/kiosks/:id`.
29. **Parity test values with `_`, `^`, `~` and non-ASCII.**
    `kiosk_laptop/edge/tests/test_vegas_parity.py`.

## Recorded, not planned

- Clone keeps `customized=True` with `child_edits=0` (label v1.0) — cosmetic.
- A run's `template_overrides` may name a deleted template; a rerun reports it.
- No DB CHECK on `initiatives.code` length (needs a migration).
- `^FB`+`^FT` last-line-baseline semantics and Zebra's QR ECI segment for
  non-ASCII data: unverifiable offline; check on a physical print.
- The active Generic 203/3400 code rows print `{'rack'}` etc. literally
  today (pre-existing); Replace… with the rebuilt parent fixes it.

## Hardware checks for Jimmy (ZD421)

- Does `E:TT0003M_.TTF` answer on E:, or only Z:? (The kiosk lists E: only.)
- The Generic banner overprints the RU on a long location string (as the
  stored template did).
- The Front Asset Tag barcode at 203 DPI prints `^BY1` (4.9 mil): check it
  scans.
- Confirm the `>0` Code 128 literal escape prints a `>`.
