# Matching rules: phase 1 (portal management and editor) — design

Date: 2026-11-10. Branch `matching-rules`.

## Why

Today a scanned or typed value is matched to an asset in five separately
written places: the web kiosk and laptop (`kiosk/src/lib/scanMatch.ts`), the
laptop stations (`kiosk_laptop/edge/src/edge/rfid/processing.py`), the server
(`api/src/serversherpa/scans/matching.py`), Android (`core/scan/ScanMatch.kt`)
and iOS (`Core/Scan/ScanMatch.swift`). They have drifted apart: RFID leading
zeros, the order of the steps, "007" against "7" (Harbor Master SS-522).

Jimmy wants matching to be data, kept centrally like status rules and shared
by the portal and every kiosk, and wants to see each rule as a flowchart he can
edit and test.

## What Jimmy decided

- **One central set of matching rules** that the portal and every kiosk will
  follow, not separate code per app.
- **A flow editor in the style of Node-RED:** nodes with inputs and outputs,
  joined by wires, where you set the logic, the tables, any filtering and
  clean-up such as stripping leading zeros.
- **A test mode:** enter a value and watch how it flows and what it matches.
- **Who:** developers and above ("this is an engineering activity").
- **Deploy or standby:** after a change, deploy it (live) or save it as
  standby (ready, not live). Deployed rules are sent out to each kiosk.
- **Versioning and rollback.**
- **A built-in test that proves a flow is valid:** no missed steps, and the
  flow is complete.
- **A test set of 5 to 10 assets** with asset IDs, names, RFIDs and serials of
  varying complexity, which every flow must match correctly.
- **Places first:** Printing and Scanning. Fixed RFID readers wait: a tag can
  only match one value there.
- **Phase 1 is the portal only:** "build the management and rule edit side
  first as a separate page on the portal, then work on the kiosks when we get
  that ironed out."
- He approved both mockups (the flow editor, and the management page) and the
  playback below.
- **Version 1 copies today exactly**, quirks included, so switching the apps
  over in phase 2 changes nothing. Fixes come afterwards as normal new
  versions (deployed, and rolled back if needed).
- **When two or more assets match, a Match step takes the first** (today's
  kiosk behavior).
- **Access: the developer role only**, the same as Database and System
  config. Founders and super admins don't get it.

## Goals (phase 1)

1. A **Matching rules** page in the portal, for developers and above.
2. **One flow per place.** Phase 1 has Printing and Scanning.
3. **A visual flow editor:** drag nodes from a palette, wire outputs to inputs,
   select a node to edit its settings in a side panel.
4. **A test run:** type a value, pick what to test against, press Run. The
   path the value took lights up, with a step-by-step trace and the result.
5. **Versions:** Draft → Standby or Deploy (Live) → Retired, with Rollback
   (make an earlier version live again). Every version is kept.
6. **A built-in check** before any version can be standby or live:
   - **Structure:** every output is wired; every path ends in found or not
     found; no loops; every node's required settings are filled in; exactly
     one Scan input.
   - **The test set:** every test asset gives the expected result for this
     place.
7. **The test set:** 5 to 10 test assets kept on the page, each with an asset
   tag, name, RFID and serial, and for each place the expected result for a
   given value.

## Non-goals (phase 1)

- No kiosk, laptop, Android, iOS or server matching changes. Every app keeps
  matching exactly as it does now. Deploy marks the live version, but nothing
  reads it yet.
- No flows for Containers, Trucks, RFID Enroll, Asset Lookup, the RFID and
  Dock stations, the time clock, or the server's final match.
- No containers or people as match targets: assets only.
- **The SS-522 mismatches are not fixed here.** v1 reproduces them on
  purpose. They get fixed as new versions once the apps follow the live flows
  (phase 2).
- No Scan type branching in phase 1: the web and laptop kiosks can't tell an
  RFID read from typed text before matching. It comes back with the stations
  and the server's final match.

## Anti-goals

- **No change to how anything matches today.** If phase 1 alters a real
  scan's outcome, it has failed.
- **No ambiguity about what's live:** at most one live version per place, ever.
- **Not a toy:** a flow that passes the check must be something the apps could
  follow exactly in phase 2. Avoid node types that only make sense in the
  editor.

## The page

### Where

- **Address (my call):** Developer › **Matching rules**, at
  `/dev/matching-rules`, with a card on the Developer landing page (`/dev`).
- **Who (Jimmy):** the developer role only. It's guarded like the other
  Developer pages: `ProtectedRoute resource="devtools"`, and the API with
  `devtools`, which only the developer role holds.

### Management view (the second mockup)

- **Place switch:** Printing | Scanning.
- **Versions table:** version number, state (Draft, Standby, Live, Retired),
  who saved it and when, the test result ("8 of 8"), and actions (Open, Deploy,
  Roll back to).
- **Check panel:** the structure checks for the selected version, each ✓ or ✗
  with what's wrong.
- **Test assets panel:** each test asset, the value tried, what this place
  should find, and the result.
- **Buttons:** Edit flow, Run tests, Save as standby, Deploy.

### Flow editor (the first mockup)

- **Palette (left):** the node kinds below.
- **Canvas (middle):** nodes with input and output ports, wires between them,
  pan and zoom, and drag to place.
- **Settings (right):** the selected node's settings.
- **Test bar (bottom):** a value; what to test against (the test set, or a
  move's assets); Run; the trace, with the path lit up on the canvas.
- **Top bar:** place, version and state, Discard, Save.

## Node kinds (phase 1)

| Kind | Settings | Outputs |
|---|---|---|
| **Scan input** | none (one per flow) | out |
| **Clean up** | one of: trim, upper-case, lower-case, strip leading zeros, pad to 24, read as a number | out, and "invalid" where it can fail (e.g. not a number, longer than 24) |
| **Match** | table (Assets); field (asset tag, serial, RFID, name); compare (see below); search in (this move, or this move plus the client's other devices); when two or more match: take the first, by asset tag order (Jimmy) | found, none |
| **Found** | what happens (print the label, record the scan) | — |
| **Not found** | the message shown | — |

### How values move (my call, from the review)

- A Clean up node passes its cleaned value on.
- A Match node compares the value it received, and passes that same value on
  through both outputs. So a later Match can try the same value against a
  different field.
- Each output wires to exactly one node.

### Match compare options (my call, from the review)

- **Exact.**
- **Ignore case:** both sides upper-cased.
- **Strip leading zeros on both sides:** used for RFID.
- **Contains.**

Today's kiosk upper-cases both sides for every field, and strips zeros on both
sides only for RFID. The compare options exist so v1 can say exactly that.
Comparing the stored side can't be done with a Clean up node, which only
changes the scanned value.

### Field vocabulary

The field list is fixed: asset tag, serial, RFID, name. In phase 2 each app
maps it to its own columns: asset tag is `legacy_id` on the server and
`asset_id` (the text of `legacy_id`) in the kiosk's downloaded move.

### Search in

- **This move:** what the kiosk downloads for the move. For a run against a
  real move, that means the move's `initiative_assets` rows, with the same
  filtering the kiosk sync uses.
- **This move plus the client's other devices:** adds the client's assets
  (`Asset.client_id` = the move's client), as the kiosk's client-assets
  download does.
- **Not offered for kiosk places:** "all assets" (kiosks never have them).

## Version 1 of each flow: today's web kiosk, exactly (Jimmy)

Each place starts with a built-in v1 that reproduces the web kiosk's matching
today (`kiosk/src/lib/scanMatch.ts`), quirks included:

- **Printing** (`matchAssetOrSerial`):
  1. Trim and upper-case.
  2. Match asset tag, as text, ignoring case (so "007" doesn't find asset 7).
  3. Match serial, ignoring case.
  4. Not found: "This asset isn't on this move."

  RFID is never tried. Search in: this move. Two hits: take the first.
- **Scanning** (`matchScan`):
  1. Trim and upper-case.
  2. Match RFID, stripping leading zeros on both sides.
  3. Match asset tag, as text, ignoring case.
  4. Match serial, ignoring case.
  5. Not found.

  Search in: this move. Two hits: take the first.

v1 is Live from the start. Its test-set rows describe today's behavior, so v1
passes them. A later "corrected" version changes those expected rows along
with the flow.

## Testing

### Running a flow

- **One engine:** a flow is run by one engine on the server (the reference
  engine). Phase 2 ports it to each app. The portal's test bar calls the
  server.
- **What it returns:** every node visited, with the value it received and gave
  out, which output it took, the hits for each Match, and the final result.
- **What it can run against:** the test set, or a move the developer picks.
  Read-only: running a test never writes a scan, never changes an asset, and
  never touches the live version.

### Test assets (my call on storage)

- **Storage:** a small table of their own, not real assets, so they never
  appear on a move, in a report or in a sync. 5 to 10 rows, edited on the
  page. Each row has:
  - **asset tag:** a whole number, like the real legacy ID
  - **name, RFID and serial**
  - **where it sits:** on the move, or one of the client's other devices, so
    "search in" can be tested
- **Expected results:** each test asset has rows (place, value to try, expected
  result: found by asset tag / serial / RFID / name, or not found).
- **The starting set covers the tricky cases:**
  - an RFID stored padded and scanned without zeros
  - an asset tag that is also another asset's RFID
  - a mixed-case serial
  - an asset tag typed with a leading zero ("007" for asset 7)
  - a name that is part of another name
  - a value that matches two assets (take the first)

## Versions and states

- **States:** Draft (being edited), Standby (checked, ready, not live), Live
  (exactly one per place), Retired (was live).
- **Save:** saves the draft. Drafts may fail the check.
- **Standby and Deploy:** both need the check and the test set to pass.
- **Deploy:** the version becomes Live, and the old Live one becomes Retired.
- **Roll back to:** an earlier version becomes Live again, and the current one
  becomes Retired. It must still pass the check against today's test set.
- **Edit:** a Live, Standby or Retired version can't be edited. Editing makes
  a new draft from it.
- **Audit:** every save, standby, deploy and rollback is written to the audit
  log (`services/audit.audit`), with who and when.
- **Model:** versions follow the label templates' pattern
  (`label_template_versions`). Status rules are edited in place without
  versions, so they're the precedent only for "central rules as data".
- **When the test set changes (my call):**
  - Editing the test set is never blocked.
  - Each version keeps the result it got when it was checked.
  - The page re-runs every version against today's test set. A Live version
    that now fails is flagged on the page, but stays live until someone
    deploys or rolls back.
- **Phase 1 delivery:** Deploy only marks Live. Phase 2 sends the Live version
  of each place with the kiosk's move download and check-in.

## Constraints

- **Copy:** American English. Times on a 24-hour clock.
- **Look:** follows the portal's light and dark themes with tokens. No default
  scrollbars. Modals use the report-generate header with rounded corners.
- **No invented sample content:** placeholder names like "Test asset 1".
- **Database:** migration at the next free number (0126 when written; renumbered to 0130 at merge, after main took 0126-0129).

## Left to the builder

- **Flow editor library:** recommendation `@xyflow/react` (React Flow). The
  builder confirms its license and bundle size, and pins an exact version.
- **How flows are stored:** for example a version row holding the flow as JSON
  (nodes, edges, settings), and a server-side validator that the editor also
  uses for its live warnings.
- **Exact API routes and page breakdown.**
