# Android kiosk: Zebra sled review and fix — design

Date: 2026-11-10. Branch `android-rfid-sled` (not merged, not pushed; Jimmy tests on hardware first).
Status: revised after four critiques. The draft was commit `ea1235c69`. Built 2026-11-11: the closing "Implementation notes" record what the build changed, and win over the body where they differ.

Conventions in this document:

- **(hardware)** marks a statement that depends on how sled firmware behaves. Each one has a line in the hardware script.
- **(platform)** marks Android behavior stated from the platform's documented rules, not checked on a device.
- **‡** marks a number chosen in this design (by the controller's rulings, or adopted by them from a critic). It is not from the SDK, the app or a measurement. The hardware log corrects it.
- Paths: `APP/` = `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`, `TEST/` = `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/`.
- "New" means a name this design introduces. Every other app name below was checked in the code on this branch.

## What Jimmy asked for

"we have a real problem with our zebra rfid readers not running well on an android that doesn't have datawedge. Can you work through the android code and make sure that all available options are implemented and match with the sdk and expected operation. One thing missing is the switch from rf to barcode doesn't work right now. no questions just a review and fix. do not merge when complete, let me know so i can connect my phone and we can start debugging on real hardware"

So: no questions (every open decision below is a ruling, listed in "Rulings"), fix what the review finds, leave the branch unmerged, and make the build ready for a hardware session.

## How the review was done

The vendor SDK (`RFIDAPI3Library/API3_LIB-release.aar`, Zebra RFID API3 2.0.5.292, which bundles the scanner SDK 2.6.9.4) was decompiled and used as ground truth. Six reviewers read the app code against it, a seventh built an options matrix, Zebra's own guides and samples were fetched, then six verifiers tried to refute every finding, two fact-checkers answered from the SDK alone, and a critic listed what was still missing. None of the main findings was refuted.

The draft of this design was then read by four critics, each with one lens: SDK truth (every name and call against the bytecode), concurrency and architecture, the operator and the owner, and regressions (which tests break and what changes by accident). The controller ruled on their disagreements. This revision is the result.

The full record (not in git) is in the main checkout at `.superpowers/zebra-sled-review/`: `connect.md`, `inventory.md`, `trigger.md`, `controller.md`, `ui.md`, `platform.md`, `options-matrix.md`, `vendor-reference.md`, `vendor-reference-extra.md`, `verify-*.md`, `blind-*.md`, `critic.md`, `design-critique-*.md`, `design-revision-rulings.md`. The decompiled SDK is at `.superpowers/zebra-sdk-src/src` (reference only; never copied into the repository).

Nothing here has been seen on a sled.

What the four critiques changed in the draft, in one line each:

- Swallowing the sled's keystrokes while the scanner "is ready" could lose every scan: the SDK reports a session as up when only the socket opened. Nothing swallows keys now; a guard drops the second copy instead.
- The written lock order was the reverse of the code's for `stopGate`.
- A battery request leaves an unread status line, which makes the next command fail. Each request is now followed by a read that consumes it.
- Interrupting an SDK wait does not abort it; it falsifies its result. Vendor calls now run on one worker thread that is never interrupted.
- `getKeylayoutType()` can return the previous attribute's value. The read-back now checks the attribute number.
- The reader interface was not enough for two build tracks. It now has a written contract per member and a finished fake.
- `<queries>` for DataWedge would change how every scan arrives on the MC2200. It is not in this branch.
- The reconnect ladder was a second, invented list; the app's own outbox list is used. The display rule switched the reconnect off. Both fixed.
- The operator words were named, not written. They are all written below.

## What was wrong (confirmed in code)

1. **The RFID / Barcode switch did nothing.** `Config.setTriggerMode` sends a command only to an RFD8500; on an RFD40 it returns success and sends nothing. Its "scanner plugin" flag is a DataWedge broadcast. The RFD40's real control is the key layout, `Config.setKeylayoutType(upper, lower)` (sled attribute 2269), which the app never called. Zebra's trigger-remapping tutorial says the same. Whether the sled accepts each layout value is (hardware).
2. **A barcode read by the sled had nowhere to go.** The RFID link carries no barcode data. The only routes are a scanner-SDK session (`com.zebra.scannercontrol.SDKHandler`) and the sled typing as a Bluetooth keyboard (hardware). The app opened a session only to switch the imager off, and its barcode callback only logged.
3. **Every trigger pull started an RFID sweep,** whatever the setting and whatever trigger type the sled reported.
4. **A lost link was never noticed.** The app never called `Events.setReaderDisconnectEvent(true)`, and the SDK drops events that are not registered. A sled that slept or walked out of range stayed "Connected" with a dead trigger. Nothing reconnected.
5. **Each connect leaked threads.** A new `SDKHandler` per connect left one 50 ms polling thread per paired Bluetooth device, for the life of the app. `SDKHandler(context)` also opened a listening socket and started Bluetooth discovery at every connect and disconnect.
6. **`ENUM_TRANSPORT.ALL`** probed five Zebra-only transports on every connect. The right value for a paired sled is `BLUETOOTH`.
7. **The display timing out disconnected the sled.** Operators pull the sled's trigger, not the screen, so the phone dims, the app stops, and the link is torn down and rebuilt. A Bluetooth keyboard appearing or disappearing (the sled in keyboard mode) also restarted the activity and dropped a sweep.
8. Smaller, all confirmed: batch-mode recovery never stopped the batch read; a sled with no region could not be given one; a hopping-configurable region could throw inside the SDK; transmit power was sent as tenths of a dBm where the SDK takes an index into the reader's table; "Blink on read" is an empty call over Bluetooth; failed starts and stops were thrown away; one refused setting stopped the rest of the push; the unique-tag list was never purged between sweeps; connect and disconnect could overlap; the first paired sled was always used; battery was never asked for; operator sentences carried SDK result names; DataWedge detection has no manifest `queries` entry (left as is in this branch: ruling 2).

## Goals

- The trigger switch works, live, on an RFD40 on a phone with no DataWedge: RFID, Barcode, or one trigger each (hardware).
- Sled barcodes reach every scan screen the way a DataWedge scan does, delivered once.
- The app knows when the link drops, says so, and reconnects by itself within set limits.
- Every option on the RFID tab does what it says on the sled, or is removed.
- No thread leak, no discovery, no Zebra-only transports on a phone.
- A build ready for a hardware session: an SDK wire-logging switch, a diagnostic dump at connect, and an ordered script.
- The MC2200 (DataWedge) keeps working; DataWedge handling is untouched.

## Non-goals

The `<queries>` entry for DataWedge (ruling 2); swallowing or consuming the sled's keystrokes; RFID Enroll reading its tag with the sled; showing charging state; link profile, Tari and pre-filters; USB attachment; iOS; merging. Also left out, as in the draft: tag locating; access operations (read, write, lock, kill); Wi-Fi provisioning; firmware update; scanner symbology settings; sled factory reset.

## Rulings

Each is a decision made without asking, easy to reverse. "Source" says where it came from: the draft's ruling, the controller's rulings file (R1 to R16), a critique, or "revision" for a decision made while writing this document. Numbers marked ‡ are chosen, not measured.

1. **Sled triggers: a three-way setting.** RFID (both triggers read tags), Barcode (both scan), Both (upper reads tags, lower scans). Enum `SledTriggerLayout { RFID, BARCODE, SPLIT }` (new); the on-screen names are RFID, Barcode, Both. It applies live. It is always on the RFID tab (dimmed on a Zebra host and for a sled known to have no scanner, so Settings hides nothing), and in `ScanTools` on every scan screen (Scanning, both steps of RFID Enroll, Print Labels, and Asset Lookup, which gains `ScanTools`) while a sled not known to lack a scanner is `Connected`, on a phone that is not a Zebra host. Default RFID. Which physical trigger the firmware calls upper is (hardware). Source: draft 1, operator 3 and 4, R2, R5. *If wrong:* one enum default; the control is one composable inside `ScanTools`.
2. **Zebra hosts and DataWedge.** No `<queries>` entry in this branch. `isZebraHost(context)` (new) = `DataWedge.isPresent(context) || Build.MANUFACTURER.startsWith("Zebra", ignoreCase = true)`, next to `DataWedge`. On a Zebra host the sled always gets the RFID layout whatever the setting says; no scanner session; no sled Scan button; scan screens do not show the Sled triggers control; the RFID tab shows it dimmed with "On this device the handheld's own scanner reads barcodes. Both sled triggers read tags." `DataWedge.enableScannerInput(context)` (new: one `SCANNER_INPUT_PLUGIN` / `ENABLE_PLUGIN` broadcast) is sent once per process from `MainActivity`'s first `onResume`, on a Zebra host only. Sign-in's Move password view collects `ScanBus`. `DataWedge.isPresent`, `configure`, `hasDataWedge` and `DataWedgeReceiver` stay exactly as they are. On the MC2200 the sled changes in three ways: the `BLUETOOTH` transport, the RFID key layout written at connect, and no scan-disable stand-down. DataWedge handling is untouched. Source: R2. *If wrong:* make `isZebraHost` return `DataWedge.isPresent` only, or delete the one `enableScannerInput` call.
3. **Sled keystrokes are never swallowed; one guard delivers each scan once.** `SledScanGuard` (new, `core/scan/SledScanGuard.kt`) refuses a copy only when the other route accepted the same value within `WINDOW_MS = 2_000`‡. Session copies are held `SETTLE_MS = 120`‡, then while typing was noted in the last `QUIET_MS = 150`‡, never past `MAX_HOLD_MS = 1_500`‡. Session barcodes go on `ScanBus` as `ScanSource.SLED`; typed scans go where they go today. Scanner `Ready` means establish returned `SUCCESS` and the stale window passed. Source: R1. *If wrong:* delete the hold and the two composable hooks.
4. **Reconnect.** Waits are `OutboxMachine.BACKOFF` (2, 4, 15, 60 s): four tries after a link that was up drops, then stop with the give-up sentence. A connect that never came up gets the schedule only while a sled screen is open; elsewhere one attempt. Pre-check failures and `RFID_RECONNECT_FAILED` never retry on a timer. Nudges (Bluetooth on, the sled's link appearing) shorten a wait or start one try. No attempt while `PrinterLock` is held. Stop, Disconnect, reader off and the app leaving the foreground cancel it. Source: R3. *If wrong:* delete the retry job; the waits are one existing list.
5. **Display.** One effect beside the NavHost sets `LocalView.current.keepScreenOn` and nothing else. On while Scanning or Asset Lookup is open and the sled is `Connected`, `Connecting` or the app is reconnecting; or RFID Enroll or Print Labels is open, the sled is `Connected` and the layout in force uses the scanner (`usesScanner()`, Settings). Released after `SLED_DISPLAY_IDLE_MS = 600_000`‡ (10 minutes) with no trigger pull, tag, sled barcode or touch; any of those turns it on again. Released when the reconnect gives up. Source: R4. *If wrong:* delete one effect.
6. **Has-scanner is a tri-state** (`Boolean?`). Everywhere it means "unless the sled is known to lack one". Source: R5. *If wrong:* one helper.
7. **The scanner session is opened only when it can be used:** the layout in force uses the scanner (`usesScanner()`, Settings), the link is `Connected`, the phone is not a Zebra host, and the sled is not known to lack a scanner. In RFID layout nothing extra is opened. Source: draft 7, R2. *If wrong:* one condition.
8. **Battery.** One gated block: the battery request, then `Config.getAttribute(2269, AttributeInfo())` to consume any status line; two timeouts in a row on that read mean the link is lost. The adapter asks once at connect; the controller asks after each sweep and after 60 s‡ idle while `Connected`; a battery job is dropped when a sweep is open. Charging is not shown (the SDK's flag parser only works if the sled sends the word "true"; the raw event is logged). Source: R6, draft 12. *If wrong:* drop the controller's poll.
9. **Threads, waits and budget.** One RFID worker thread for the life of the adapter; every vendor block runs on it, in order; it is never interrupted; no `runInterruptible`. Caller waits: connect 30 s‡ (60 s‡ when a batch recovery ran in that attempt), start 5 s‡, stop 4 s‡, everything else 10 s‡. A caller that stops waiting treats the outcome as unknown; the block still finishes. Best-effort setup steps not started within 8 s‡ of the vendor `connect()` returning are skipped and logged. Cleanup after a failed connect runs on its own thread, bounded at 5 s‡; batch cleanup at 20 s‡. `RfidController.VENDOR_TIMEOUT_MS = 15_000L` is replaced by these. Source: R7. *If wrong:* the constants sit in one companion object.
10. **Lock order, outermost first:** `linkGate` (new), `stopGate`, `mutex`, `applyGate`, the adapter worker. Nothing new takes `stopGate` while holding `mutex`. Source: R8, regression 2.1, concurrency 2. *If wrong:* the lock stress test fails; fix the path that took locks out of order.
11. **Names where the critics differed:** `setVendorLogging(on)`; `SledScannerState.Unavailable(kind: SledScannerFault)` with `DID_NOT_START`, `STOPPED_RESPONDING`, `BLUETOOTH_OFF`; `suspend fun retryScanner(): Result<Unit>`; `RfidConnection.Failed(reason, retryable = false, fix: SledFix? = null)`; `pulls: Flow<TriggerPull>` with `triggers` kept for existing doubles; every operator sentence in one object, `SledWords` (new, `core/rfid`). Source: R9. *If wrong:* rename in the first task, before the tracks start.
12. **Soft trigger (the sled's Scan button).** Shown only on a non-Zebra host while the scanner is `Ready`. A tap sends pull, then release on the first sled barcode or after `SOFT_SCAN_HOLD_MS = 3_000`‡, whichever is first. The existing DataWedge Scan button is unchanged. Source: R10. *If wrong:* hide the button.
13. **RFID Enroll** does not read tags with the sled. Its gate takes the web kiosk's rule (`kiosk/src/lib/enrollGate.ts:53-67`): a tag value equal to any roster asset's asset ID or serial is refused, with the web's wording. Source: draft 5, R11, regression 2.5. *If wrong:* remove the `checkEnrollRaw` call in `submitTag`.
14. **Words.** Operator critique section 3 is the source, with three edits: today's permission sentence and "Open app settings" button text are kept byte for byte (two tests pin them); the Zebra-host sentence is added; no sentence for "typed only". No operator sentence contains an SDK name. Source: R12, operator 2. *If wrong:* one object.
15. **Activity configuration.** `android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|navigation|uiMode|density|fontScale"`. `enableEdgeToEdge()` runs again only when the night-mode bits of `uiMode` changed, and `StatusBarIcons` keys its effect on those bits. Source: R13, regression 2.11. *If wrong:* remove the attribute.
16. **Old settings.** A kiosk that had "Trigger drives: Barcode" (which did nothing) comes up in the Barcode layout. Said in the hand-off; hardware block 2 starts by setting RFID. Source: R14. *If wrong:* map old `barcode` to RFID in the parser.
17. **Logs.** Once the scanner session is used, the scanner SDK logs every barcode frame at info level in any build (Time Clock badge codes included). Accepted for this branch; said in the hand-off. Source: R15. *If wrong:* keep Time Clock off the sled route.
18. **Kept out of scope:** see Non-goals. Source: R16. *If wrong:* each item is its own later piece of work.
19. **A sled barcode with no scan screen open is dropped,** like a DataWedge scan today, with no sentence. A sled barcode that arrives while the app is not in front is dropped too (parity with DataWedge, whose receiver is unregistered in `onStop`). Source: draft 6, concurrency (smaller notes). *If wrong:* a replay buffer on `ScanBus`.
20. **The "Scanner plugin on connect" setting is removed** (it only messaged DataWedge and could switch the MC2200's own scanner off). Ruling 2's `ENABLE_PLUGIN` repairs a scanner an earlier build may have left off. Source: draft 8. *If wrong:* none needed; the setting did nothing useful.
21. **"Blink on read" is removed** (an empty call on a Bluetooth sled). Source: draft 9. *If wrong:* none needed; the call did nothing on a Bluetooth sled.
22. **Location.** Location stays in `RfidPermissions.REQUIRED` and still gates the automatic connect, as today. The Connect button and the adapter's pre-check need only Nearby devices (`BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`), the two whose absence throws. Revisit after the script's Location step. Source: draft 11, operator 13. *If wrong:* add Location to the pre-check.
23. **Region.** When the picked region says hopping is configurable, the `hopping` argument is passed (`hopping ?: true`, so the Admin tab's Frequency hopping switch still decides) with the picked region's supported channels; the channel array is never null. The one-tap chooser stays (no confirmation). Whether the sled sends the hopping flag as "true" or "1" is (hardware). Source: draft 4, sdk-truth 11. *If wrong:* pass hopping null.
24. **Link profile, Tari and pre-filters are left as the sled has them** and logged. Inventory state A and SL flag ALL are pinned (Zebra's sample does the same). Source: draft 13. *If wrong:* add a push step per setting and a row on the RFID tab.
25. **`ExportedReceiverContext` stays** as a guard for `Readers` only, with its doc corrected: on API 33 and up this `.aar` passes the export flag itself. Source: draft 14, sdk-truth section 1. *If wrong:* delete the wrapper and pass the plain context.
26. **The trigger-type filter is a deny-list:** only a SCAN-type trigger event is dropped; RFID, DUAL and unknown pass, until a sled has been logged (hardware). Source: draft 15. *If wrong:* turn the filter into an allow-list once the script's step 6 has logged every trigger.
27. **The trigger gate follows the sled, and errs toward not reading.** A pull starts a read only while `Connected`, only when armed, and unless the layout in force has no trigger assigned to tags. The layout in force is `info.trigger.layout` when a read-back was accepted; otherwise `effectiveLayout` of the layout the controller last requested in this generation (the connect request's `layout`, or the last `setTriggerLayout` argument), with `zebraHost` and `info.hasScanner`. When the link came up without a controller connect in this generation (a test double's `setConnection`, the Developer tab's raw connect), the requested layout is the current `triggerLayout` setting. A pull starts no read when that layout is BARCODE, or the read-back has `readsTags == false`. Source: revision; concurrency 12 said "with no read-back, the trigger starts a read" and operator 10 said "the layout the sled was given"; the merged rule is the safer for data, because a sweep on Scanning posts every tag in range. *If wrong:* gate on the read-back only.
28. **Batch mode: one recovery, then stop.** A second `RFID_BATCHMODE_IN_PROGRESS` in a row fails as not retryable with `BATCH_MODE_UNRECOVERABLE_MESSAGE`. Source: revision, taking regression 2.9 over sdk-truth 15's "at most two recoveries per enable": fewer purge-and-save cycles on a sled holding stored tags. *If wrong:* allow one more recovery.
29. **Every failed or timed-out start is followed by one stop.** Source: revision, taking concurrency 10 over sdk-truth 6 (which closes the sweep without a stop when nothing was sent): the extra stop is harmless and leaves no radio on. *If wrong:* skip the stop for "not sent".
30. **Start and stop triggers IMMEDIATE is a must step** (public constructors, two writes, one retry each). A sled left on its own triggers can start the radio while the app is disarmed. Source: regression 2.7. *If wrong:* mark it best.
31. **Every settings change goes through `KioskPrefs.updateRfid { it.copy(…) }`** (new), one atomic DataStore edit. No screen writes a snapshot. Source: concurrency 16, regression 2.13. *If wrong:* none: it only removes a lost-update window.
32. **`enabled` gates automatic connects only.** Lifecycle, reconnect and the switch's off-to-on edge run the stored gate (`enabled` and `RfidPermissions.granted`); `connectNow()`, triggers and sweeps never read `enabled`. A manual attempt checks only `linkWanted`. Source: regression 2.3; revision reconciles concurrency 6's "every attempt re-reads the stored gate" with the tests that connect while `enabled` is false. *If wrong:* manual attempts also run the gate.
33. **The sled-screen signal has one writer.** `SettingsScreen` publishes its active tab to `AppContainer.settingsTab: MutableStateFlow<SettingsTabId?>` (new); the one effect beside the NavHost reads the route and that value. Source: revision (the Settings tab is local state today, so the route alone cannot tell Settings › RFID). *If wrong:* drop Settings › RFID from the sled screens.
34. **The read-back is typed.** `SledTriggerReadback.upper` and `.lower` are `SledKey` (new enum mirroring the SDK's five values plus `UNKNOWN`), not strings. Source: revision of concurrency section 4. *If wrong:* strings.
35. **The Developer row "Zebra SDK logging"** is the one on-screen text that names the vendor's SDK. It is developers only and lives in `DeveloperPanel`, not `SledWords`. Source: revision (operator section 3.5 against its own vocabulary rule). *If wrong:* rename the label (for example "Sled wire log").
36. **Enroll sentences live in `SledWords`** (R9, R11); `EnrollGate.kt` returns them beside `enrollTagText`. Source: R9, R11. *If wrong:* move them into `EnrollGate.kt`.
37. **`BATCH_MODE_UNRECOVERABLE_MESSAGE` keeps its pinned phrases** ("123RFID Mobile", "one-time", "should not return to this state") and drops the word "session" ("an earlier offline session" becomes "earlier offline use"), so it passes the no-SDK-words test. It moves into `SledWords`; the constant name stays. Source: revision (regression 2.9 against operator 2). *If wrong:* restore the old wording and exempt this one sentence from the test.
38. **The address of an automatically chosen sled is saved.** `AppContainer` writes `info.address` to `readerAddress` when `info.autoChosen` is true and the address differs from the saved one (a sled the operator picked in the chooser is never overwritten by an attempt already in flight); the controller does not reconnect when the new saved address equals the connected sled's. Source: operator 5, concurrency (smaller notes). *If wrong:* delete the collector; the operator then picks the sled once two are paired.
39. **Two source scans, not one:** vendor calls in the two Zebra files only (regression 2.12), and device-setting calls across all of `src/main/java` (operator 11). Source: revision of the two critics' different scopes. *If wrong:* merge the two scans into one with two file lists.
40. **`SCANNER_ALREADY_ACTIVE` is up only when this engine opened that session in the same generation;** otherwise terminate, establish once more, and a second `ALREADY_ACTIVE` is `Unavailable(DID_NOT_START)`. Source: sdk-truth 2 with concurrency 8. *If wrong:* treat every `ALREADY_ACTIVE` as up.
41. **Nudges are bounded.** A nudge is ignored during an attempt; a link-appeared nudge is also ignored within 2 s‡ of one ending; it never resets the count. After the schedule has given up, a nudge starts one try, and if it fails the app stays given up. Source: R3, concurrency 6; the last sentence is revision, so a sled that accepts the Bluetooth link and refuses the channel cannot loop. Amended in the final fix wave (F-spec-1): Bluetooth turning on is exempt from the 2 s guard. It cannot be an echo of the app's own attempt (nothing dials while Bluetooth is off), it comes once per off-to-on change, and after a "Bluetooth is off" failure (`retryable = false`) it is the only way back by itself, so a guard that swallowed it left that sentence up with Bluetooth on. *If wrong:* drop the 2 s guard and let a nudge always start a try.
42. **The `info` flow is cleared at the start of each connect attempt** (as well as by `disconnect()`), so the controller can tell a drop (info present) from a connect that never came up (info null). Source: revision of concurrency section 4. *If wrong:* keep `info` through attempts and track the drop with a separate flag.
43. **`batchRecovery: StateFlow<Boolean>`** (new reader member, default false) tells the controller to extend the connect wait to 60 s. Source: revision, so ruling 9's budget is buildable. *If wrong:* a fixed 60 s connect wait.
44. **Asset Lookup's `ScanTools` shows only the sled controls,** never the DataWedge Scan button, so the MC2200's Asset Lookup is unchanged. Source: revision under ruling 2. *If wrong:* pass `showTrigger = container.hasDataWedge` there too.
45. **A sweep the sled ended by itself gets no sentence.** The controller ends the sweep, queues its tags and sends one stop; the reason is logged. Source: revision, taking operator section 3.6 (no sentence) over concurrency 13 (show it on `readError`): ruling 14 makes the operator's words the source, and neither is safer for data, since the tags queue either way. *If wrong:* show a `SledWords` sentence on `readError`.
46. **Setup link trouble fails the connect.** Source: concurrency 10 over the draft's best-step rule (safer: the app never shows Connected over a link that stopped answering during setup). *If wrong:* let a best step's link trouble skip the remaining best steps.

## Target model

### Settings (`core/rfid/RfidSettings.kt`)

- Remove `triggerPersonality`, `scannerPluginMode`, `ledOnRead`, and the enums `RfidTriggerPersonality` and `ScannerPluginMode`. Add `triggerLayout: SledTriggerLayout = SledTriggerLayout.RFID` and `readerAddress: String? = null`.
- `SledTriggerLayout` wire values `rfid`, `barcode`, `split`; labels RFID, Barcode, Both; hints from `SledWords`.
- JSON: write `triggerLayout` and, when not null, `readerAddress`. When `triggerLayout` is absent or unknown, read the old `triggerPersonality` (`rfid` → RFID, `barcode` → BARCODE). When both are present, `triggerLayout` wins. Unknown keys are ignored, so old documents (with `scannerPluginMode`, `ledOnRead`) still parse.
- Not part of the radio push: `enabled`, `region`, `triggerLayout`, `readerAddress`. A `triggerLayout` change queues a layout job; a `readerAddress` change while connected to a different sled reconnects (Controller).
- Restore defaults keeps `enabled`, `region` and `readerAddress` (today it keeps only `enabled`).
- `powerToTenths` stays: it is the fallback when the reader reports no power table.
- `KioskPrefs.updateRfid(transform: (RfidSettings) -> RfidSettings)` (new): read and write inside one `store.edit`. `setRfid` stays for tests; no screen calls it.
- `effectiveLayout(setting: SledTriggerLayout, zebraHost: Boolean, hasScanner: Boolean?): SledTriggerLayout` (new, pure): RFID on a Zebra host or when `hasScanner == false`, else the setting. The adapter writes it; the controller compares against it.
- `fun SledTriggerLayout.usesScanner() = this != SledTriggerLayout.RFID` and `fun SledTriggerReadback.usesScanner() = upper == SledKey.SLED_SCAN || lower == SledKey.SLED_SCAN` (new, pure, T1). "The layout in force uses the scanner" = the accepted read-back's `usesScanner()`, else the requested effective layout's (ruling 27 defines which request). The scanner session (ruling 7), the display rule and the RFID tab's scanner line all follow this one value.

### Connection state (`core/rfid/RfidConnection.kt`)

```
sealed class RfidConnection {
    data object Disabled
    data object Disconnected
    data object Connecting
    data class Connected(val name: String, val batteryPct: Int?)
    data class NeedsRegion(val name: String)                       // new: link up, no region
    data class Failed(val reason: String, val retryable: Boolean = false, val fix: SledFix? = null)
}
enum class SledFix { TURN_ON_BLUETOOTH, BLUETOOTH_SETTINGS, ALLOW, CHOOSE_SLED, CONNECT }  // new
```

| State | Written by | Meaning |
|---|---|---|
| `Disabled` | nobody (screens show it from `enabled == false`, as today) | reader off |
| `Disconnected` | reader, by `disconnect()` (first, before teardown) | no link, none wanted by the last call |
| `Connecting` | reader, at the start of `connect()` | an attempt is running |
| `Connected` | reader, after setup, `info` already set | link up, region set |
| `NeedsRegion` | reader, `info` already set | link up, no region: only `regions()` and `setRegion()` work |
| `Failed` | reader | `retryable` per the list under Adapter rules; `fix` names the button that fixes it |

`reconnecting: StateFlow<Boolean>` lives on the controller, not in this type. `connectionLine` gains a line for `NeedsRegion` (the no-region sentence). The richer `sledLine` (Screens) combines the state with `reconnecting`.

### Reader interface (`input/rfid/RfidReader.kt`)

The contract below goes into the design and into `RfidReader.kt` as KDoc, one paragraph per member. `connect` changes its signature, so hand-written doubles do not keep compiling by default bodies alone: the first task rewrites the eight hand-written doubles as `class X(private val inner: FakeRfidReader = FakeRfidReader()) : RfidReader by inner` (`RfidPanelTest.GatedConnectReader` uses the default argument), overriding only the member under test. Other new members have default bodies, stated in the Members table.

**Types (`core/rfid`, no Android or Zebra imports)**

- `SledTriggerLayout { RFID, BARCODE, SPLIT }`.
- `SledKey { RFID, SLED_SCAN, TERMINAL_SCAN, SCAN_NOTIFY, NO_ACTION, UNKNOWN }`.
- `SledConnectRequest(address: String?, layout: SledTriggerLayout)`.
- `SledTriggerReadback(upper: SledKey, lower: SledKey, raw: Int?, layout: SledTriggerLayout?)`: `layout` is null when the pair is not one of the three; `readsTags` is true when either key is `RFID`.
- `SledInfo(generation: Int, name: String, address: String?, model: String?, serial: String?, firmware: String?, hasScanner: Boolean?, powerMinDbm: Int?, powerMaxDbm: Int?, trigger: SledTriggerReadback?, autoChosen: Boolean)`. `autoChosen` is true when the pre-check picked the only paired sled because no saved address matched.
- `SledScannerState`: `Off`, `Opening`, `Ready`, `Unavailable(kind: SledScannerFault)`; `SledScannerFault { DID_NOT_START, STOPPED_RESPONDING, BLUETOOTH_OFF }`.
- `SledBarcode(value: String, label: String?)`.
- `SledCandidate(name: String, address: String)`.
- `TriggerPull(event: TriggerEvent, atMs: Long?)`. `TriggerEvent` stays the enum it is. A reader stamps every pull or none; the controller uses `atMs ?: clock()`.
- `RfidConnection.Failed(reason, retryable, fix)`, `RfidConnection.NeedsRegion(name)`, `SledFix`.
- `class SledNotConnected : Exception()`: a call made in the wrong state; the controller recognizes it and shows nothing.
- `enum class SledNudge { BLUETOOTH_ON, LINK_APPEARED }` (new; the controller's `nudge` takes it).
- `object SledWords`: every operator sentence (Words).

**Members**

| Member | Contract |
|---|---|
| `val connection: StateFlow<RfidConnection>` | Only the reader writes it. `connect`: `Connecting`, then `Connected`, `NeedsRegion` or `Failed`. Link loss: `Failed(retryable = true)`, written only when the loss's generation is current and the state is `Connecting`, `Connected` or `NeedsRegion`. `disconnect()` always ends `Disconnected`, from any state, idempotent. Nothing writes `Disabled`. |
| `val connectNote: StateFlow<String?>` | Kept. Cleared at the start of each attempt. A note carried over from the previous attempt (the batch note) is set by the next successful connect after its own clear. |
| `val info: StateFlow<SledInfo?>` | Null at the start of each connect attempt and after `disconnect()`. Set before `Connected` or `NeedsRegion` is published. Kept through a `Failed` caused by link loss. `trigger` is updated by `setTriggerLayout` and at connect. Default body: a constant null flow. |
| `val scanner: StateFlow<SledScannerState>` | `Off` whenever the link is not `Connected`, the layout in force does not use the scanner (`usesScanner()`), or the phone is a Zebra host; otherwise `Opening`, `Ready` or `Unavailable`. `Ready` only after establish returned `SUCCESS` and the stale window passed. `Off` at once on link loss and on `disconnect()`. `Unavailable(BLUETOOTH_OFF)` is published only while the link is still `Connected`; it becomes `Off` when the link drop is recorded. Default: constant `Off`. |
| `val batchRecovery: StateFlow<Boolean>` | True while a batch-mode recovery runs inside the current attempt. Default: constant false. |
| `val tags: Flow<String>`, `val pulls: Flow<TriggerPull>` | Delivered on a coroutine dispatcher, never on a vendor thread, and only for the current generation. `triggers: Flow<TriggerEvent>` remains for existing doubles; the default `pulls` maps it with `atMs = null`. |
| `val barcodes: Flow<SledBarcode>` | Emitted only while `scanner` is `Ready` for the current generation. Value already decoded and trimmed. Backed by a shared flow with a buffer of at least 16 (the delegate uses `tryEmit` from a vendor thread); a failed `tryEmit` is logged. Default: empty flow. |
| `val unsolicitedStops: Flow<String>` | A sweep the sled ended without being asked. The string is a reason for the log, never shown (ruling 45). Emitted after the same tag wait a requested stop uses. Default: empty flow. |
| `suspend fun connect(request: SledConnectRequest): Result<Unit>` | Success when the link is up (`Connected` or `NeedsRegion`). Never called concurrently with itself or `disconnect()` (the controller's `linkGate`). Tears down a stale link first. Failure carries the same sentence as `Failed.reason`. |
| `suspend fun disconnect()` | Bumps the generation and publishes `Disconnected` first, then tears down on the worker. Never throws. |
| `suspend fun apply(settings: RfidSettings): Result<Unit>` | Needs `Connected`. Tries every step; a refusal does not stop the push; link trouble does. The failure message is a `SledWords` sentence naming what was refused. |
| `suspend fun startInventory(): Result<Unit>` | Needs `Connected`. Follows the `perform()` outcome table: success for "started" and "sent, not confirmed"; failure with a sentence otherwise. |
| `suspend fun stopInventory(): Result<Unit>` | Needs `Connected` (otherwise `SledNotConnected`, which the controller reads as "nothing to stop"). Success when nothing was running. Returns after the tag wait. |
| `suspend fun regions(): Result<RfidRegions>`, `suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit>` | Need `Connected` or `NeedsRegion`. `setRegion` never reconnects. |
| `suspend fun setTriggerLayout(layout: SledTriggerLayout): Result<SledTriggerReadback>` | Needs `Connected`. Writes the effective layout. Success carries the read-back even when it differs from the request. A read-back that could not be accepted is a failure with "Couldn't check the sled's trigger setting." and leaves `info.trigger` null. Opens or closes the scanner session to match the layout in force (`usesScanner()`, Settings) and returns without waiting for it. Default: `Result.failure(SledNotConnected())`. |
| `suspend fun requestBattery()` | Fire-and-forget; the answer arrives as `Connected.batteryPct`. Does nothing unless `Connected`. One gated block with its consuming read. Default: does nothing. |
| `suspend fun softScan(pull: Boolean): Result<Unit>` | Fails unless `scanner` is `Ready`. A failed pull sets `Unavailable(DID_NOT_START)`. Default: `Result.failure(SledNotConnected())`. |
| `suspend fun retryScanner(): Result<Unit>` | The Try again button: terminate, then establish once. Needs `Connected` and a layout that uses the scanner; fails at once in `STOPPED_RESPONDING` (the worker is stuck). Default: `Result.failure(SledNotConnected())`. |
| `fun pairedSleds(): List<SledCandidate>` | Android's bonded list only, by name prefix `RFD40`, `RFD90`, `RFD8500`. Never builds a `Readers`. Empty when Bluetooth is off or Nearby devices is not granted (`RfidPermissions.nearbyGranted`). Safe in any state, on any thread. Default: `emptyList()`. |
| `fun setVendorLogging(on: Boolean)` | Default body does nothing. Process-wide, not saved. The Developer tab calls it and imports no `com.zebra`. |
| `val vendorLogging: StateFlow<Boolean>` | What `setVendorLogging` last set (false at process start). The Developer switch shows it, so it stays right after the tab recomposes. Default: constant false. |

All calls except `connect` and `disconnect` may be made from any coroutine at any time; the reader queues them on its worker. A call made in the wrong state returns `Result.failure(SledNotConnected())` without a vendor call. Canceling a caller stops its wait and never interrupts a vendor call.

**What `FakeRfidReader` must do** (it ships in `main`; the first task finishes it; then it and the interface are frozen):

- Keep today's members: `applied`, `inventoryRunning`, `connectCalls`, `regionsCalls`, `connectResult`, `applyResult`, `reportedRegions`, `lastRegionSet`, `regionResult`, `setConnectNote`, `setConnection`, and the loud `emitTag` / `emitTrigger` checks.
- Record: `lastRequest`, `layoutCalls`, `batteryRequests`, `softScans`, `retryScannerCalls`, `vendorLogging` (the interface's `StateFlow`, written by `setVendorLogging`).
- `setConnection(Connected|NeedsRegion)` while `info` is null also sets `info` to `SledInfo(generation = ++generation, name = <the state's name>, address = null, autoChosen = false, …all others null)`; while `info` is set it keeps it (a battery change is not a new generation). `setConnection` to any other state leaves `info` as the reader contract says.
- Knobs: `connectResult`, `applyResult`, `startResult`, `stopResult`, `layoutResult`, `regionResult`, `needsRegion` (makes `connect()` publish `NeedsRegion`; `regions()` and `setRegion()` work there; `apply`, `startInventory`, `setTriggerLayout` return `SledNotConnected`), `paired` (what `pairedSleds()` returns). Defaults stay "success": the Developer tab drives this fake (`DeveloperPanel.kt`).
- Drivers: `emitTrigger(event, atMs: Long? = null)` (emits on `pulls`; `triggers` is its mapping), `emitTag`, `emitBarcode`, `emitUnsolicitedStop(reason)`, `setInfo`, `setScanner`, `setBatchRecovery`, `dropLink(reason)` (writes `Failed(reason, retryable = true)` and clears `inventoryRunning`).
- `generation` increases on every successful `connect()` and is carried in `info`; `info` is null during an attempt. A successful `connect(request)` publishes `info = SledInfo(generation, name = <its name>, address = request.address)` before `Connected` or `NeedsRegion`.
- Also records `disconnectCalls`. `softScan(pull)` records `pull` and succeeds only while `scanner` is `Ready`, else `SledNotConnected`; `retryScanner()` counts its calls and succeeds while `Connected`, else `SledNotConnected`; `setTriggerLayout` records every call in `layoutCalls`, including calls that fail.
- Test knob `holdNext: CompletableDeferred<Unit>?`: the next call in the `violations` list awaits it before returning, so a test can hold a call open and prove the overlap check fires.
- `connect()` while already `Connected` reconnects (a new generation), so the controller's "returns success without dialing" rule shows as `connectCalls` not growing.
- `stopInventory()` when not `Connected` returns `SledNotConnected`.
- `violations: List<String>`: any of `apply`, `startInventory`, `regions`, `setRegion`, `setTriggerLayout`, `requestBattery` or `connect` made while `inventoryRunning`, and any two of those (or `stopInventory`/`disconnect`) in flight at once. `softScan`, `retryScanner`, `pairedSleds` and `setVendorLogging` are never violations. Controller tests assert it is empty.

### Adapter rules (`ZebraRfidReader.kt`, `ZebraBarcodeEngine.kt`)

`ZebraRfidReader(context, scope, zebraHost: Boolean = false)`: `AppContainer` passes `isZebraHost` (T1 adds the parameter, stored and unused until Track A; the default keeps the three constructions in `ZebraRfidReaderTest` compiling).

**Pre-check, before any vendor object.** Behind its own `protected open` seam, so the existing seam tests reach the fake vendor plumbing under Robolectric. The decision is a pure helper (new, `core/rfid`) over: Bluetooth on; Nearby devices granted (API 31 and up); the bonded list (name, address); the saved address.

| Finding | Result |
|---|---|
| Bluetooth off | `Failed(bluetoothOff, fix = TURN_ON_BLUETOOTH)` |
| Nearby devices not granted (`RfidPermissions.nearbyGranted` false) | `Failed(permission sentence, fix = ALLOW)` |
| A bonded device has no name | `Failed(namelessDevice, fix = BLUETOOTH_SETTINGS)` (the SDK compares every bonded name with no null check and fails with `RFID_RECONNECT_FAILED`) |
| No bonded `RFD40…`, `RFD90…` or `RFD8500…` | `Failed(noSledPaired, fix = BLUETOOTH_SETTINGS)` |
| Saved address among the paired sleds | that sled |
| Saved address not among them | counts as none saved |
| None saved, one paired | that sled, with `info.autoChosen` true (`AppContainer` then saves its address) |
| None saved, several paired | `Failed(severalPaired, fix = CHOOSE_SLED)` |
| Two bonded devices share the chosen sled's name | `Failed(duplicateName, fix = BLUETOOTH_SETTINGS)` (the SDK connects by name) |

Then `Readers(context, ENUM_TRANSPORT.BLUETOOTH)`, `GetAvailableRFIDReaderList()` once per `Readers`, and the entry whose address equals the chosen sled's.

**One worker thread.** Every vendor block (connect, setup, teardown, apply, start, stop, purge, regions, set region, trigger layout, battery, scanner-free reads) runs on one RFID worker thread for the life of the adapter, in order. The worker is the adapter gate. It is never interrupted. Each public call posts its block and awaits it; a caller's timeout stops only the wait. Every block checks the state before its first vendor call: apply, start, stop, trigger layout and battery need `Connected`; regions and set region need `Connected` or `NeedsRegion`; otherwise `SledNotConnected`. The SDK bounds its own waits: 2 s per status (4 s after one mismatch), 15 s for `saveConfig`, under 30 s for `connect()`.

One exception: cleanup after a failed connect (and the batch recovery's close) runs on a separate cleanup thread, against that attempt's `Readers` and `RFIDReader` only. The worker's next block waits for it, up to 5 s‡ (20 s‡ for batch cleanup), then drops the references and goes on. The cleanup thread is never reused for another attempt.

**Per-connection generation.** A new listener object per connection captures its generation; every callback (tag, trigger, battery, disconnect) from another generation is dropped. All state writes use `_connection.update`. The disconnect handler makes no vendor call; it records the loss for its generation and writes `Failed(SledWords.couldNotReach(name), retryable = true)` only when its generation is current and the state is `Connecting`, `Connected` or `NeedsRegion`. `connect()` fails retryable, instead of publishing `Connected` or `NeedsRegion`, when a loss was recorded for its generation or `rfid.isConnected()` is false. `SledInfo.generation` is set before the state is published. Marking the link lost (two link-trouble results in a row from any block, including the battery block's consuming read) records a loss for the current generation and writes `Failed(SledWords.couldNotReach(name), retryable = true)` by the same rule as the disconnect handler; the worker then refuses every block for that generation except teardown, with `SledNotConnected`.

**Connect sequence.** Must: a failure fails the connect. Best: guarded, logged, never fails it.

| # | Step | Kind |
|---|---|---|
| 1 | `rfid.connect()` | must (special results below) |
| 2 | batch-mode prevention, as today (reads 1500 with the attribute-number check; saves) | best |
| 3 | add this generation's listener; `setReaderDisconnectEvent(true)` | must |
| 4 | `setHandheldEvent(true)`; check `isEventRegistered(RFID_EVENT_TYPE.HANDHELD_TRIGGER_EVENT)`; retry once | must |
| 5 | `setTagReadEvent(true)`; `setAttachTagDataWithReadEvent(true)` as today | must |
| 6 | inventory start and stop events; battery, power and temperature events | best |
| 7 | start and stop triggers IMMEDIATE, built with the public `StartTrigger()` and `StopTrigger()` constructors (two writes, one retry each) | must |
| 8 | identity: model, serial, firmware, scanner name, capability (has-scanner), power table (first, second, last, size) | best |
| 9 | dump: attributes 2269 (key layout as found), 1587 (Bluetooth host mode), 2325 (scan batch mode), each read with the attribute-number check; external keyboard input devices (name, vendor id, product id; no vendor call) | best |
| 10 | trigger layout write (effective layout) and read-back | best |
| 11 | battery request and its consuming read | best |
| 12 | scanner session, only when ruling 7 allows, queued on the scanner worker after `connect()` has returned | best, off the connect path |

Budget: the controller waits 30 s‡ for the whole call, 60 s‡ when `batchRecovery` turned true in this attempt. A best step not started within 8 s‡ of step 1 returning is skipped and logged. Link trouble on any setup step, must or best, fails the connect as retryable; a refusal on a best step is logged and setup goes on (ruling 46). A failed step 4 (the trigger events) fails with `Failed.reason` exactly `SledWords.TRIGGER_NOT_SET_UP`, retryable per the list below, so `sledLine` can recognize it. The batch-mode prevention step's `saveConfig()` runs before the layout write, so the layout is never saved (hardware: whether it survives a power cycle anyway).

**Special connect results.**

- `RFID_BATCHMODE_IN_PROGRESS`: the link is up, capabilities were not fetched. Only `setReaderDisconnectEvent(true)` is registered (with capabilities missing, `setHandheldEvent(true)` would tell the sled to exclude trigger notifications). `batchRecovery` goes true. Each recovery step is guarded on its own and its result logged: `Inventory.stop()`, a 500 ms‡ pause, `purgeTags()` (returns false on failure, never throws), `setBatchMode(DISABLE)` (refused with `RFID_OPERATION_IN_PROGRESS`: wait 500 ms‡, try once more), `saveConfig()`, close. Bounded at 20 s‡ on its own. Then fail as retryable with `Failed.reason` exactly `SledWords.BATCH_CLEARED_RETRYING` (the controller recognizes it: Reconnect). The adapter remembers that this attempt cleared a batch: the next successful connect sets the batch note (the "cleared" wording only when `purgeTags()` returned true). A second batch result in a row fails as not retryable with `BATCH_MODE_UNRECOVERABLE_MESSAGE` (`BatchModeUnrecoverableException` stays). The old recovery avenues (`PostConnectReaderUpdate()`, `reconnect()`, a bare second `connect()`) and `batchModeRecoveryUsable` go.
- `RFID_READER_REGION_NOT_CONFIGURED` (from `connect()`, from a setup step, or a region that reads `NA`): keep the link; only the listener and the disconnect event are registered (if it surfaced in a later setup step, what was already registered stays until the reconnect); set `info`; publish `NeedsRegion(name)`. Only `regions()` and `setRegion()` work. `regions()` is guarded: `SupportedRegions.length()` throws when the sled never answered `getallsupportedregions`.
- `RFID_CONNECTION_PASSWORD_ERROR`: not retryable, the password sentence.

`retryable = true` exactly for: the disconnect event; a loss recorded during setup; an open error, a send error or a command timeout from `connect()` or from a must step; batch mode cleared (first time). `false` for everything the operator has to fix: every pre-check failure, a password, a class-loading error, `RFID_RECONNECT_FAILED`, a second batch result in a row.

**Teardown** (on the worker, after `disconnect()` has published `Disconnected`, or at the top of the next `connect()` for a stale link):

1. Queue scanner terminate then `DISABLED` on the scanner worker; do not wait.
2. Only when the link is known to be up: stop inventory, then the batch-mode safety step (set DISABLE; skip `saveConfig()` when this connection wrote a trigger layout; the next connect's prevention step saves before its layout write).
3. Remove the listener, `disconnect()`.
4. `Readers.Dispose()`, guarded on its own (it throws `NullPointerException` when no `RFIDReader` was built in this process).

Cleanup after a failed connect runs on its own thread, bounded at 5 s‡; past that the references are dropped and the connect returns.

**Trigger layout.** Write `Config.setKeylayoutType(upper, lower)` with `ENUM_NEW_KEYLAYOUT_TYPE` values (RFID 0, SLED_SCAN 1, TERMINAL_SCAN 2, SCAN_NOTIFY 3, NO_ACTION 4); attribute value = `upper * 5 + 4 + lower`.

| Layout | Pair written | Value | Fallbacks, in order (after a refusal only) |
|---|---|---|---|
| RFID | (RFID, RFID) | 4 | (RFID, TERMINAL_SCAN) = 6, then raw `"0"` |
| Both (`SPLIT`) | (RFID, SLED_SCAN) | 5 | raw `"2"` |
| Barcode | (SLED_SCAN, SLED_SCAN) | 10 | (SLED_SCAN, RFID) = 9, then raw `"3"` |

- Read back with `Config.getAttribute(2269, AttributeInfo())` and accept the value only when `getAttNum() == 2269`; otherwise "could not read the layout back". `getKeylayoutType()` is never used (it returns a process-wide slot that can hold the previous attribute's value).
- Decode (the SDK's own table): 0 = RFID / terminal scan, 1 = terminal scan / RFID, 2 = RFID / sled scan, 3 = sled scan / RFID; 4 to 28: upper = (v − 4) / 5, lower = (v − 4) % 5, with 0 RFID, 1 sled scan, 2 terminal scan, 3 notify, 4 none; anything else `UNKNOWN`.
- After any failed write, read back first; a read-back equal to the request is success. The fallbacks run only after a refusal as the result classifier defines it (an out-of-step result is retried once; a second one on the same write counts as a refusal), each followed by a read-back; the first accepted read-back ends it. Link trouble, on a write or on the read-back, ends the write: `setTriggerLayout` records it toward marking the link lost, leaves `info.trigger` as it was and fails with "Couldn't check the sled's trigger setting."; at connect step 10 it fails the connect as retryable (ruling 46). Raw values go through `Config.setAttribute(SetAttribute(2269, "B", "<digits>", 0))` (the SDK runs `Integer.parseInt` on the string). Which values the firmware accepts is (hardware).
- Never `saveConfig()` for a layout. `setTriggerMode(mode, false)` is called only when the model name contains `RFD8500` (RFID or Both: `RFID_MODE`; Barcode: `BARCODE_MODE`).
- The note and the on-screen line state what the read-back decodes to, never the request.

**Trigger events.** Every event's value and type is logged. A SCAN-type event (`HANDHELD_TRIGGER_SCAN`) is dropped; RFID, DUAL and unknown pass. A notification with no type field decodes as RFID, so only the raw line shows what the sled sent (hardware). Each pull is stamped with `System.currentTimeMillis()` on receipt and emitted on `pulls`.

**Inventory.** When unique reporting is on, `purgeTags()` runs before `perform()` (a false result is logged). Whether the sled's unique list outlives a sweep is (hardware).

| `perform()` outcome | Meaning | Adapter returns | Controller does |
|---|---|---|---|
| success | started | success | keep the sweep |
| `RFID_API_COMMAND_TIMEOUT`, or `RFID_API_UNKNOWN_ERROR` with vendor message exactly "Unknown error" | sent, not confirmed (the start status may ride on the first tag: hardware) | success, logged "unconfirmed" | keep the sweep; confirmed by `INVENTORY_START_EVENT` or the first tag; never confirmed and the stop also times out: the link is lost |
| the controller stopped waiting (5 s‡) | unknown | (still running) | send one stop, close the sweep, show the reason |
| `RFID_BATCHMODE_IN_PROGRESS` | the sled is reading into its store | failure; the adapter first sends stop and runs the batch-mode safety step | send one stop, close the sweep, show the reason |
| `RFID_OPERATION_IN_PROGRESS` | an inventory is already running (the sled's own start trigger) | success; after the next stop, the adapter sets the start and stop triggers to IMMEDIATE again | keep the sweep |
| `RFID_CHARGING_COMMAND_NOT_ALLOWED` | the sled is on its charger | failure, the charging sentence | send one stop, close the sweep, show the reason |
| `RFID_API_LOCK_ACQUIRE_FAILURE`, `RFID_COMM_SEND_ERROR` | not sent | failure | send one stop (ruling 29), close the sweep, show the reason |
| any other sled status | refusal | failure | send one stop, close the sweep, show the reason |

No forced stop on a timer: nobody knows yet whether the sled sends a start notification with no tag in range (hardware). `StopInventory` returns on the status of `abort` and does not wait for the stop event or drain the tag queue, so after `Inventory.stop()` returns the adapter waits until the stop event has arrived and 100 ms‡ have passed with no tag emitted, at most 500 ms‡ in all. A stop event with no stop requested and an inventory running is emitted on `unsolicitedStops` after the same wait.

**Settings push and the result classifier.** One pure helper (new, `core/rfid`), tested, used by setup, the push, the layout write and the sweep. It takes the result name, the vendor message and whether the exception was `InvalidUsageException`:

| Class | Results | Effect |
|---|---|---|
| link trouble | `RFID_API_COMMAND_TIMEOUT`, `RFID_COMM_SEND_ERROR`, `RFID_COMM_NO_CONNECTION` | stops a push; two in a row mark the link lost (after a link loss every command returns a timeout after 2 s, because writes are dropped silently) |
| out of step | `RFID_API_UNKNOWN_ERROR` with vendor message exactly "Unknown error"; `RFID_API_LOCK_ACQUIRE_FAILURE` | retry that step once |
| refusal | any other result; `InvalidUsageException` | logged; the push continues; the failure names it |

Push steps, each labeled with its RFID tab row label: Sled beeper; Transmit power; Session (with inventory state A and SL flag ALL); Tag population; Report each tag once; Dynamic power optimization. Result names go to the log, never into the sentence.

**Power index rule.** The SDK builds the table as `MIN_POWER + k * POWER_STEPS` for `MAX_POWER − MIN_POWER + 1` entries, so with a step other than 1 the last entry overstates the maximum. Decide the unit from the entries that are 400 or less: if the largest of them is 40 or less the table is in dBm, otherwise in tenths. `powerMinDbm` and `powerMaxDbm` come from those entries. The index sent is the last entry not above the wanted value (in the table's unit), never above `size − 1`. With no table, today's value (`powerToTenths`). The real table is (hardware).

**Region.** `Config.getRegionInfo` is read for the active and the picked region only. The active-region read is guarded on its own: if it throws, the list still loads with no active region. When the picked region says hopping is configurable, the `hopping` argument is passed (`hopping ?: true`) with the picked region's supported channels (ruling 23). The channel array is never null (the picked region's channels, or empty), because the SDK decides from its own fresh `getregion` reply and throws on a null array. If the write throws, the region is read back before failure is reported.

**Battery.** `requestBattery()` is one worker block: `Config.getDeviceStatus(true, false, false)`, then `Config.getAttribute(2269, AttributeInfo())`, which consumes the battery command's status line if the sled sent one (hardware) and costs one round trip if not. Two timeouts in a row on that read mark the link lost. Charging is not parsed. The battery event's raw text is logged.

**Scanner engine (`ZebraBarcodeEngine.kt`).**

- One `SDKHandler(appContext, false)` for the life of the process, one scanner worker thread that is never interrupted, delegate and subscription set once. Vendor calls go through an internal interface (new) with no vendor types in it, run on an injected executor; only the real implementation holds the `SDKHandler`. Tests use a fake and a direct executor.
- The worker keeps one desired value, (generation, open or closed), and after each vendor call acts on the latest; opens and closes for older generations are skipped. A result is published only when its generation is current.
- Immediately before building the handler and before every `dcssdkSetOperationalMode(DCSSDK_OPMODE_BT_NORMAL)`, on the worker: `BluetoothAdapter.isEnabled`. Off: `Unavailable(BLUETOOTH_OFF)`, no vendor call (the vendor's Bluetooth manager would otherwise switch Bluetooth on itself, or park the worker until it is on).
- Every open: `DCSSDK_OPMODE_DISABLED`, then `BT_NORMAL`; list only to find the sled's id (matched by address, then serial, with the existing `chooseScanner`; cached; the listed names are logged); `dcssdkEstablishCommunicationSession(id)`.
- Establish results: `SUCCESS` = up. `SCANNER_ALREADY_ACTIVE` = up only when this engine opened that session in the same generation; otherwise terminate, establish once more, and a second `ALREADY_ACTIVE` or any other result is `Unavailable(DID_NOT_START)`. `SCANNER_NOT_AVAILABLE`: drop the cached id, list once, establish once.
- Stale window: 250 ms‡ from `dcssdkEventCommunicationSessionEstablished` (the SDK's barcode queue is static and outlives sessions; how much a sled leaves in it is (hardware)); a barcode received before that callback or inside the window is dropped and logged with its length. A real scan made while the line says "Starting" is dropped by this rule. `Ready` is published when establish has returned `SUCCESS` and the window has passed. The delegate emits a barcode only while `scanner` is `Ready` for the current generation.
- When no longer needed, on a `dcssdkEventCommunicationSessionTerminated` the engine did not ask for, on an RFID link loss, and when the adapter's own receiver sees Bluetooth turning off: `scanner` goes `Off` at once, and terminate then `DISABLED` are queued, `DISABLED` in a `finally`. The cached id is dropped when Bluetooth turns off. While `BT_NORMAL` is in the mode mask the SDK's own receiver rebuilds a BLE manager, sleeps a second on the main thread and may start an unfiltered LE scan when Bluetooth comes back; `DISABLED` stops that.
- Watchdog: 10 s‡ for a command, 45 s‡ for establish (establish can properly take about 31 s after the socket opens). It changes only the displayed state, to `Unavailable(STOPPED_RESPONDING)`. When the call returns, its real result is applied if its generation is current (still wanted: `Ready`; no longer wanted: terminate and `DISABLED`).
- Never: `SCAN_DISABLE` or `SCAN_ENABLE` opcodes, `dcssdkClose()` between uses, automatic re-establishment, available-scanner detection.
- Every delegate body catches everything. Barcode bytes: strict UTF-8, else ISO-8859-1; a type label from a small table.
- Soft trigger: `DCSSDK_DEVICE_PULL_TRIGGER` and `DCSSDK_DEVICE_RELEASE_TRIGGER` with the four-argument `dcssdkExecuteCommandOpCodeInXMLForScanner` and an empty XML string. Each blocks up to 8 s for the acknowledgment.
- Hazard to log, not fix: while `BT_NORMAL` is set the SDK compares every listed scanner's name on `ACL_DISCONNECTED` on the main thread; a listed device with a null name would throw there.
- A real session with the RFID link up beside it on a Pixel has never been seen (hardware).

**Vendor logging.** `setVendorLogging(on)` calls `RFIDReader.LOGGER.EnableDebugLogs(on)`. Off at process start.

### Never call (two source-scan tests)

1. **Vendor scan.** Reads `ZebraRfidReader.kt` and `ZebraBarcodeEngine.kt` only, with comments and string literals stripped, and matches call syntax. Fails on: `.getCradleStatus(` (can end the process), `.setBluetoothMode(` (a stub that always throws), `import com.zebra.barcode.sdk`, `SDKHandler(` with one argument, `dcssdkEnableAutomaticSessionReestablishment`, `dcssdkEnableAvailableScannersDetection`, `dcssdkStartScanForAvailableDevices`, `dcssdkSetSTCEnabledState`, `dcssdkEnableBluetoothScannersDiscovery`, `dcssdkClose(`, `DCSSDK_DEVICE_SCAN_DISABLE`, `DCSSDK_DEVICE_SCAN_ENABLE`, `DCSSDK_OPMODE_BT_LE`, `DCSSDK_OPMODE_SNAPI`, `DCSSDK_OPMODE_USB_CDC`, `ENUM_TRANSPORT.ALL`, `.reconnect(`, `.connect(` with an argument (`Readers.connect(String)`), `setTriggerMode(` with `true`, `setScanBatchMode(`, `setUsbBatchMode(`, `resetFactoryDefaults(`, `.reset(` on `Actions`, `PostConnectReaderUpdate(`, `setScanDataEvent`, `getKeylayoutType(`, `runInterruptible`; `Dispose(` except once, `Readers.Dispose()` in the teardown function; `saveConfig(` except in the batch-mode prevention, recovery and teardown functions.
2. **Device-settings scan.** Reads all of `src/main/java`, comments and strings stripped. Fails on: `.enable()` and `.disable()` with no arguments (a Bluetooth adapter), `Settings.System.put`, `Settings.Global.put`, `Settings.Secure.put`, `requestedOrientation`, `newWakeLock(`, `FLAG_KEEP_SCREEN_ON`, and `keepScreenOn` in any file other than `ui/SledDisplayEffect.kt` (the display effect, App wiring). The Bluetooth-off fix stays Android's own prompt (`BluetoothSettingsIntents.enableBluetooth()`).

Neither scan reads `src/test` (`ZebraReadersConstructibleTest.kt` constructs a `Readers`). New patterns contain no `(?u)`, `(?U)` or `(?d)` (`AndroidRegexTest`).

### Controller (`RfidController.kt`)

**Constructor.** `RfidController(reader, settings, scope, zebraHost: Boolean = false, printerBusy: () -> Boolean = { false }, clock: () -> Long = System::currentTimeMillis)`. `clock` stays the last parameter (eleven test sites pass it as a trailing lambda). `AppContainer` passes `printerBusy = { printerLock.isLocked }`, which needs a read-only `isLocked` on `PrinterLock` (new, from its private `Mutex`).

New public surface: `info`, `scanner` (read-throughs), `reconnecting: StateFlow<Boolean>`, `readError: StateFlow<String?>`, `layoutError: StateFlow<String?>`, `lastActivityMs: StateFlow<Long>`, `setSledScreenOpen(open: Boolean)`, `stopReconnecting()`, `nudge(reason: SledNudge, address: String? = null, name: String? = null)` (the controller applies the address and name rule under Reconnect), `noteActivity()`, `retryScanner()`, `softScanOnce()`. Existing: `connection`, `connectNote`, `session`, `applyError`, `connectionError`, `arm`, `disarm`, `stopBurst`, `connectForLifecycle`, `disconnectForLifecycle`, `connectNow`, `disconnectNow`, `loadRegions`, `setRegion`, `burstsFor`, `forgetQueued`.

**Lock order, outermost first: `linkGate`, `stopGate`, `mutex`, `applyGate`, the adapter worker.**

- `endBurst` already holds `stopGate` and takes `mutex` inside it; `onTrigger` already passes through `stopGate` before `mutex`. Nothing new takes `stopGate` while holding `mutex`.
- Nothing that holds `applyGate` or waits on the adapter takes `mutex`, `stopGate` or `linkGate`.
- The only reader call under `mutex` is the START branch's `startInventory()` (under `applyGate`). `setRegion` takes `applyGate` while holding `mutex` and makes its reader call after releasing `mutex`, as today. The "may still be reading" stop runs at the top of `onTrigger`, under `stopGate`, and holds `applyGate` for the call (taken after `stopGate`, released before `mutex` is taken), so it never overlaps a queued job. A failed start is closed after `mutex` is released, never by calling `endBurst` inside it.
- `mutex` is never held longer than one start wait (5 s‡) plus any wait for `applyGate`.

**Link management.**

- `linkGate` (new `Mutex`) serializes connect and disconnect. A connect that finds the reader `Connected` or `NeedsRegion` returns success without dialing.
- `linkWanted` is an atomic value written without suspending: by `connectForLifecycle`, `connectNow`, `disconnectForLifecycle`, `disconnectNow` and `stopReconnecting` on their caller's thread, and by the settings collector on an `enabled` edge, in each case before the matching command is queued. `connectForLifecycle` (which stores its gate), `connectNow` and `enabled` false-to-true set it true. `disconnectForLifecycle`, `disconnectNow`, `stopReconnecting` and `enabled` true-to-false set it false and cancel the retry job in the caller, before anything is queued.
- Automatic attempts (lifecycle, retry, nudge, the enable edge) re-read `linkWanted` and the stored gate after they hold `linkGate`, and do not dial when either is false; a false gate is logged. A manual attempt (`connectNow`) re-reads only `linkWanted`.
- `connectNow()` and `disconnectNow()` run on the controller's scope; the caller only awaits. Canceling the caller (leaving the RFID tab) does not cancel the attempt.
- The connect request is built from `settings.first()`, not from `current`, so a lifecycle connect issued before the settings collector's first value still carries the saved address and layout.
- Connect wait: 30 s‡, 60 s‡ when `reader.batchRecovery` turned true. On timeout the controller sets `connectionError` to the couldn't-reach sentence and keeps `linkGate` until the adapter's attempt has returned (every SDK wait is bounded). Disconnect wait: 10 s‡.
- Enable and disable are queued on `connectionCommands`, never run inside the settings collector. The controller connects when `enabled` changes from false to true between two consecutive collected values and disconnects on true to false; equal values do nothing (`prefs.rfid` re-emits on every DataStore write); the first collected value is not a change. `RfidPanel` stops calling `disconnectNow()` itself on switch-off.
- A `readerAddress` change while `Connecting`, or while connected to a sled with a different address, queues a disconnect and a connect after the current attempt; a change to the connected sled's own address does nothing.

**Connection collector.** `combine(connection, info)` with `distinctUntilChangedBy` on (state class, generation), never `collectLatest` on the raw flow (battery updates would cancel a push in flight). On a new generation reaching `Connected`: queue one push, then one layout check (queue a layout write when there is no read-back, or its layout differs from `effectiveLayout(setting, zebraHost, info.hasScanner)`; at most once per generation, so a sled that refuses is not written in a loop). On leaving `Connected`, or a generation change: end any open sweep and queue its tags (`endBurst(stopReader = false, queue = true)`). On `Failed(retryable = true)`: the reconnect rules. A `Connected` with `info == null` (a hand-written double) counts as a new generation on each transition into `Connected`.

**Reconnect.**

- One retry job, owned by the controller; `reconnecting` is true while it runs.
- It starts on `Failed(retryable = true)` only while `linkWanted` is true and no job is running, and only for: a drop (the link was up: `info` not null), or a connect that never came up while a sled screen is open (`setSledScreenOpen(true)`: Scanning, Asset Lookup, RFID Enroll, Print Labels, Settings › RFID). Elsewhere a never-up connect is one attempt, as today. `setSledScreenOpen(true)` while the state is a retryable `Failed` from a connect that never came up (`info` null), `linkWanted` is true, the stored gate passes, no job is running and the schedule has not given up starts the schedule at try 1 (wait 2 s).
- A `Failed(retryable = true)` from a first batch clear (`reason == SledWords.BATCH_CLEARED_RETRYING`) is followed by one immediate try on any screen, with no wait. It does not advance `attempt` and is not counted as a nudge.
- Waits: `OutboxMachine.BACKOFF` (2, 4, 15, 60 s) before tries 1 to 4. `attempt` counts failed attempts since the last `Connected`; a retry's own failure advances it and does not restart the schedule. After the fourth failure: `reconnecting` false, `connectionError` the give-up sentence, the display released.
- Any attempt that starts, from any source, cancels a pending wait. A manual attempt that fails retryably restarts the schedule at try 1 if a sled screen is open.
- No attempt starts while `printerBusy()` is true; the wait extends until it is false.
- Never on a timer: pre-check failures and every `retryable = false` result. A try inside the schedule that fails with `retryable = false` ends the job at once: `reconnecting` false, that failure's sentence and fix shown, the display released; only a nudge or Connect tries again.
- Nudges (`nudge(SledNudge.BLUETOOTH_ON)`, `nudge(SledNudge.LINK_APPEARED, address, name)`), from the app's receiver: Bluetooth turned on; `ACL_CONNECTED` for the last connected sled's address or, when none is known, any bonded device whose name starts `RFD40`, `RFD90` or `RFD8500`. A nudge shortens a wait in progress, or starts one try when the link is wanted and down and the stored gate passes. It is ignored during an attempt, a link-appeared nudge also within 2 s‡ of one ending (ruling 41: Bluetooth turning on is not), and it never resets `attempt`. After the schedule gave up, a nudge starts one try; if that fails the app stays given up. `ACL_CONNECTED` also fires for the app's own outgoing connect (platform), which is why a nudge during an attempt does nothing.
- Stop (RFID tab button while trying), Disconnect, the reader switched off and the app leaving the foreground cancel the job.
- The loss reason shows once per loss and is not raised again by retries.
- **Logging.** One `RfidController` line for each link decision the log cannot otherwise show: each call that makes the link unwanted (Stop, Disconnect, the app leaving the front, the reader off) and what it ended; each attempt as it dials, with its origin; each end of the tries other than the give-up line; each drop that starts no tries; and each ignored nudge, with its reason.

**Sweeps.**

- A pull starts a read only while armed (Scanning or Asset Lookup), only while `Connected`, and unless the layout in force has no trigger assigned to tags (ruling 27). `NeedsRegion`: no sweeps.
- The latch window is measured from `TriggerPull.atMs ?: clock()`.
- "No vendor call between `startInventory()` being issued and `stopInventory()` returning, except stop." The live panel may open while a start waits behind a call already in flight. The start wait (5 s‡) counts from when the call is issued.
- Start: the outcome table above. A thrown `Throwable` from `startInventory()` is a start failure too. After any failed or timed-out start: one `stopInventory()`, then the sweep is closed (after `mutex` is released) and `readError` is set. `readError` clears on the next successful start.
- Stop: `endBurst` holds `stopGate` across `stopInventory()` (4 s‡). A returned failure (not a thrown one, not `SledNotConnected`) is retried once; if it fails again the controller remembers "may still be reading", sets `readError`, and runs one stop at the top of the next `onTrigger` before evaluating it. A thrown `Throwable` is caught as today and not retried.
- `unsolicitedStops`: `endBurst(stopReader = true, queue = true)` and a log line; no `readError` (ruling 45). The extra stop is harmless: `Inventory.stop()` tolerates "no inventory in progress".
- `SledNotConnected` from any call sets no `readError`, `applyError` or `layoutError`.

**Job queue.** Pushes, layout writes, battery requests and region loads are jobs on one queue with one consumer coroutine.

- Pushes coalesce to the latest settings. A battery job is dropped, not delayed, when a sweep is open. A region load is awaited by its caller (`loadRegions()` returns its `Result`).
- For each job other than a layout write, the consumer waits until `session` is null; for a layout write it first calls `endBurst(stopReader = true, queue = true)` (holding no lock), then proceeds the same way. Then, under `mutex`, it re-checks `session == null` and takes `applyGate` with `tryLock()`; if a sweep opened again, it releases `mutex` and waits for that sweep to end; if `tryLock()` fails it releases `mutex` and tries again when `applyGate` is free.
- A layout job calls `setTriggerLayout` under `applyGate`; a failure sets `layoutError`.
- The settings collector and the connection collector only enqueue; they never wait for a sweep or for `applyGate`. Only START and `setRegion` may wait for `applyGate` while holding `mutex`.
- Each job's wait is 10 s‡.

**Battery.** The adapter asks once at connect. The controller queues a battery job after each sweep ends and after 60 s‡ with no sweep and no other job while `Connected`.

**`NeedsRegion`.** No push, no sweeps, no layout write. `loadRegions` and `setRegion` are allowed; the controller never calls `regions()` at connect (the Admin tab's effect does). After `setRegion` succeeds in `NeedsRegion`, the controller releases `applyGate`, then under `linkGate` disconnects and connects with the current request, and returns when that connect has finished. That reconnect is a manual attempt: it checks only `linkWanted`. `connectNow()` in `NeedsRegion` returns success without dialing.

**Soft scan.** `softScanOnce()`: `softScan(true)`, then `softScan(false)` on the first sled barcode or after `SOFT_SCAN_HOLD_MS = 3_000`‡, whichever is first.

**Activity.** `lastActivityMs` updates on every pull, tag and sled barcode (`noteActivity()` from the barcode collector), and on every typed scan character (`ScanInput`'s `noteTyping` hook and the Time Clock key hook also call `rfid.noteActivity()`). It is read by the display effect.

### App wiring

**Zebra host.** `isZebraHost(context)` is a top-level function in `input/datawedge/DataWedge.kt`. `AppContainer.isZebraHost` (new) is computed once, beside `hasDataWedge`, and passed to the adapter and the controller. `DataWedge.enableScannerInput(context)` sends one broadcast to `com.symbol.datawedge` with `SCANNER_INPUT_PLUGIN` = `ENABLE_PLUGIN`. It does not check `isPresent` (on an MC2200 where detection is off it must still go). Whether DataWedge receives it when this app cannot see its package is (platform).

**`SledScanGuard`** (new, pure Kotlin, `core/scan/SledScanGuard.kt`; time passed in on every call; all callers pass `SystemClock.elapsedRealtime()`; thread-safe):

```
class SledScanGuard(enabled: Boolean = true, log: (String) -> Unit = {}) {
    var scannerReady: Boolean
    fun noteTyping(nowMs: Long)
    fun acceptTyped(value: String, nowMs: Long): Boolean
    fun acceptSession(value: String, nowMs: Long): Boolean
    fun sessionHoldMs(arrivedMs: Long, nowMs: Long): Long   // 0 = publish now
    companion object { const val WINDOW_MS = 2_000L; const val SETTLE_MS = 120L; const val QUIET_MS = 150L; const val MAX_HOLD_MS = 1_500L; val ACCEPT_ALL: SledScanGuard }
}
```

- A copy is refused only when the other route accepted the same value within `WINDOW_MS`. The same route twice is never refused (a real double scan).
- Hold: wait `SETTLE_MS` from arrival; then keep waiting while typing was noted within the last `QUIET_MS`; never past `MAX_HOLD_MS` from arrival.
- Each refusal is logged: which route delivered first, the gap in ms and the value's length (never the value).
- A typed acceptance made while `scannerReady` that ages past `WINDOW_MS` with no session copy is logged "typed only" at the next guard call. No sentence, no automatic terminate or re-establish.
- `enabled = false` accepts every value and holds nothing; `ACCEPT_ALL = SledScanGuard(enabled = false)`.
- `AppContainer` owns one instance (log tag `SledScanGuard`) and writes `scannerReady` from a collector of `rfidReader.scanner`. `MainActivity` provides it through `LocalSledScanGuard = staticCompositionLocalOf { SledScanGuard.ACCEPT_ALL }` (new, in `APP/ui/components/ScanInput.kt`, since `core/scan` holds no Compose types), so tests that do not provide it see no change.

Hooks:

| Where | On | Call |
|---|---|---|
| `ScanInput` | text grew | `noteTyping` |
| `ScanInput` | submit | `acceptTyped`; refused: `onValueChange("")`, nothing submitted |
| Time Clock Welcome raw-key handler (`TimeclockFlowScreen`'s `onPreviewKeyEvent`) | each character | `noteTyping` |
| same | Enter | `acceptTyped(query)`; refused: query cleared, no search |
| `AppContainer`'s collector of `rfidReader.barcodes` | each barcode | hold per `sessionHoldMs`, then `acceptSession`, then publish |

**`ScanSource.SLED` and the barcode collector.** `ScanSource` gains `SLED`. `AppContainer` collects `rfidReader.barcodes`: hold, `acceptSession`; when accepted and `foreground` is true, `scanBus.publish(ScanEvent(value, ScanSource.SLED, label))` and `rfid.noteActivity()`. Not in front: dropped and logged. A second collector saves the address: on a new `info` with `autoChosen` true and an `address` that differs from the saved `readerAddress`, one `prefs.updateRfid` whose transform re-checks inside the edit and writes the address only when the saved address is null or is not among `rfidReader.pairedSleds()` (ignoring case), so a sled the operator picked meanwhile is kept (ruling 38).

**Bluetooth receivers.** Two, both with idempotent register and unregister (as `DataWedgeReceiver` is; `AppContainerPrinterTest.linkClosesOnBackgroundAndSignOut` calls `onStop` before `onStart`):

- The app's nudge receiver (new), registered in `processLifecycle.onStart` and unregistered in `onStop`: `ACTION_STATE_CHANGED` to on → `rfid.nudge(SledNudge.BLUETOOTH_ON)`; `ACL_CONNECTED` → `rfid.nudge(SledNudge.LINK_APPEARED, address, name)`. It reads device names and addresses only with `BLUETOOTH_CONNECT` granted.
- The adapter's own receiver, registered for the adapter's life: `ACTION_STATE_CHANGED` to turning off or off → the scanner engine's terminate and `DISABLED`, and drop the cached scanner id.

**`MainActivity`.**

- `dispatchKeyEvent` logs the first key seen from each external, non-virtual keyboard device (name, vendor id, product id; tag `SledScanGuard`) and always calls `super`. Nothing swallows, consumes or collects a key.
- The first `onResume` in the process, on a Zebra host only, calls `DataWedge.enableScannerInput(this)` (after `DataWedge.configure`, which `AppContainer.start()` already ran).
- `onConfigurationChanged` calls `enableEdgeToEdge()` only when the night-mode bits of `uiMode` changed (`enableEdgeToEdge()` resets the status-bar icon color the screens set). `StatusBarIcons` keys its `LaunchedEffect` on those bits too, so it re-applies afterward.
- `CompositionLocalProvider` adds `LocalSledScanGuard provides container.sledScanGuard`.

**Manifest.**

- `MainActivity`: `android:configChanges` per ruling 15. With the activity kept alive: the biometric prompter survives; photo capture reads rotation at capture time; the camera scanner's rotation is fixed at bind time and stale until the sheet reopens.
- Remove the vendor's `READ_EXTERNAL_STORAGE` with `tools:node="remove"` (its only use in the `.aar` is the USB scanner path; the app never requests it). Add `xmlns:tools` to the root.
- No `<queries>` (ruling 2).
- The five permission and feature lines `BluetoothPermissionsTest` reads as text stay byte for byte.

**Prefs.** `KioskPrefs.updateRfid` (Settings). `prefs.rfid` keeps re-emitting on every DataStore write; the controller's edge rules absorb that.

**Effects beside the NavHost** (in `KioskApp`'s `Box`, next to `ScanFlash`):

- Sled screens: `rfid.setSledScreenOpen(route in SLED_ROUTES || (route is Settings && container.settingsTab.value == SettingsTabId.RFID))`, where `SLED_ROUTES` = `Routes.SCAN`, `Routes.LOOKUP`, `Routes.ENROLL`, `Routes.LABELS_PRINT`. `SettingsScreen` writes its active tab to `container.settingsTab` while composed and null on dispose.
- The display effect is `@Composable internal fun SledDisplayEffect(container: AppContainer, route: String?)` in `APP/ui/SledDisplayEffect.kt` (new, Track B), called from `KioskApp`'s `Box` next to `ScanFlash`. It is the only file that sets `keepScreenOn` (never-call scan 2).
- Display: `LocalView.current.keepScreenOn = keepDisplayOn(…)`, and nothing else anywhere. `keepDisplayOn` (new, pure, `core/rfid`) takes the route kind (Scanning or Asset Lookup; Enroll or Print Labels; other), `enabled`, the connection state, `reconnecting`, whether the layout in force uses the scanner, and the time since the last activity (the later of `rfid.lastActivityMs` and the last touch, seen by a `pointerInput` on the `Box` in the initial pass):

| Screen | Condition | Display |
|---|---|---|
| Scanning, Asset Lookup | enabled, and `Connected` or `Connecting` or `reconnecting`, and activity within 10 min‡ | on |
| RFID Enroll, Print Labels | enabled, `Connected`, layout in force uses the scanner, activity within 10 min‡ | on |
| any | not reconnecting, and `Failed`, `NeedsRegion`, `Disconnected` or reader off (this includes after the reconnect gave up) | off |
| any other screen | | off |

Rows are tried top to bottom; the first that matches wins. While `reconnecting` is true on Scanning or Asset Lookup the display stays on, whatever the connection state (R4); the third row never overrides the first.

The effect re-runs `keepDisplayOn` from a `LaunchedEffect(lastActivity)` that waits `SLED_DISPLAY_IDLE_MS − elapsed` and then recomputes, so the 10-minute release happens with no further event.

**Developer switch.** A row on the Developer tab, label "Zebra SDK logging", hint from Words, a switch that shows `container.rfidReader.vendorLogging` and calls `container.rfidReader.setVendorLogging(on)`; off by default; not saved. It goes on its own lines, below the developer-mode check; no line ending in `// INTERNET-TEST` is edited, joined, split or reflowed.

**Sign-in collector.** While `LoginScreen` shows the Move password view (`ui.view == LoginView.MOVE`), it collects `container.scanBus.events` and calls `vm.submitScannedMove(it.value, goHome)`, so a sled barcode (or a DataWedge intent scan) can enter the move QR.

**Purity and markers.** All vendor code stays in `ZebraRfidReader.kt` and `ZebraBarcodeEngine.kt` (`CorePurityTest`). New helpers in `core/` take no Android or vendor types. New wiring in `AppContainer.kt` and `DeveloperPanel.kt` goes on its own lines next to the marked lines (`RemovalGuardTest`, `MarkedLinesAreDeletableTest`); no new file outside `nettest/` contains "nettest".

### Screens

**`sledLine` and the slot.** One pure helper in `core/rfid`, `sledLine(connection, reconnecting, enabled, permissionMissing): SledLine` (new; `SledLine(text, fix: SledFix?, offersStop: Boolean)`), used by the RFID tab, the Devices tab and the scan-screen slot, so all three say the same thing. `permissionMissing` = `RfidPermissions.missing(context).isNotEmpty()` (`REQUIRED`, as today's permission line). While `reconnecting`, the text is the reconnecting sentence with Stop: "The sled disconnected. Reconnecting…" after a drop, "Connecting to *name*…" for a connect that never came up, and the trigger-did-not-set-up sentence when that was the last failure. The trigger case is `Failed.reason == SledWords.TRIGGER_NOT_SET_UP` (the adapter writes exactly that constant). Words for every state are in Words. Fix buttons map to existing ones: `TURN_ON_BLUETOOTH` → `BluetoothFixButton(BluetoothFix.TURN_ON)`; `BLUETOOTH_SETTINGS` → `BluetoothFixButton(BluetoothFix.FORGET)` (labeled "Bluetooth settings"); `ALLOW` → today's "Open app settings" button; `CHOOSE_SLED` → none (the RFID tab shows the list); `CONNECT` → Connect.

**RFID tab (`RfidPanel`).**

- "RFID reader" row: the switch, then the `sledLine` text. Its hint is today's ("A Zebra RFD40 paired to this device over Bluetooth.") followed by the display and reconnect lines from Words ("The two behaviors in the 'RFID reader' hint"). Nothing toggleable is placed above the switch (`RfidPanelTest.turningTheReaderOnWithAMissingPermissionRequestsIt` picks the first toggleable node).
- `connectNote` under the line, in the muted tone, only while connected (the batch note is set on the successful connect, so it is seen).
- Buttons: Connect (dimmed while connecting; when Nearby devices is missing (`RfidPermissions.nearbyGranted` false), tapping it opens Android's prompt for `RfidPermissions.REQUESTED`); Disconnect in `Connected` and `NeedsRegion`; Stop while reconnecting. The permission launcher's callback calls `connectNow()` when nothing in `REQUIRED` is missing any more.
- The permission sentence and "Open app settings" stay exactly as today.
- The fix button for a `Failed` state, in a `FlowRow` under the sentence.
- Reader chooser, shown whenever two or more sleds are paired (`pairedSleds()`): one sled per line, `SetupCard(selected, onClick)`, the saved one selected; a tap writes `readerAddress` through `updateRfid`.
- "Sled triggers" row (where "Trigger drives" was): `Segmented` RFID · Barcode · Both, the hint for the selected option. Under it, only when needed: the disagreement sentence, or the check-failed sentence (`layoutError`). A sled known to have no scanner: the control dimmed (`Segmented(enabled = false)`) with the no-scanner sentence. A Zebra host: dimmed with the Zebra-host sentence.
- Scanner line, while the layout in force uses the scanner (never on a Zebra host): Starting / Ready / Did not start with a Try again button (`rfid.retryScanner()`) / Stopped responding.
- The power slider is capped at `info.powerMaxDbm` when known; a saved value above it shows "This sled's maximum is *n* dBm."
- `applyError` is shown as its sentence (today's "The reader refused a setting: " prefix goes; the sentence is complete).
- The "Trigger drives", "Scanner plugin on connect" and "Blink on read" rows are gone. No reader-details block (the dump logs model, serial and firmware).
- Restore defaults keeps `enabled`, `region` and `readerAddress`.

**Scan screens.**

- `ScanTools` lays out in a `FlowRow`. It keeps today's DataWedge Scan button (`showTrigger = container.hasDataWedge`, unchanged) and gains: the Sled triggers control with a one-word caption "Sled triggers" above it and no hint (non-Zebra host, `Connected`, `info.hasScanner != false`), writing through `updateRfid`; and the sled Scan button (non-Zebra host, `scanner` `Ready`), which calls `rfid.softScanOnce()`. Call sites: Scanning, both steps of RFID Enroll, Print Labels (all exist today), and Asset Lookup (new; sled controls only, ruling 44).
- The slot, on Scanning and Asset Lookup only: at most one sled line, in the place the red RFID toast uses today (below the scan box, so the box never moves), and nothing when the sled is connected and working. Priority: connection, region, scanner (starting or failed only), read error. A drop during this visit is red; a state already there when the screen opened is muted. The fix button sits in a `FlowRow` under the sentence, the way `PrinterReachNotice` lays it out. Shown only while the reader is enabled. On Asset Lookup only when the screen is ready. The existing transition toast on Scanning (`shownRfidFailure`) is removed.
- Scanning's three buttons (Retry failed, Clear sent, Discard failed) move from a `Row` to a `FlowRow`.

**Admin (`AdminPanel`).** The region effect stays keyed on a boolean, now `connection is Connected || connection is NeedsRegion` (never on the state value, so battery updates do not reload). A failed load shows "Couldn't read the sled's regions. Tap Retry." with Retry. The hopping switch shows only when the sled says hopping is configurable. After a region is set on a sled in `NeedsRegion`: "Region set. Reconnecting the sled…" until `setRegion` returns, then the list reloads. The saved `region` is written through `updateRfid`.

**Devices tab.** The "RFID reader" row shows the `sledLine` text. The "Zebra DataWedge" row is unchanged.

**RFID Enroll gate.** New pure function `checkEnrollRaw(index: ScanIndex<A>?, target: A, raw: String): EnrollTagVerdict?` in `core/scan/EnrollGate.kt` returns null when `index` is null, else `matchAssetOrSerial(index, raw.trim())` mapped to the new `EnrollTagIssue` values `OWN_ASSET_ID`, `OWN_SERIAL`, `OTHER_ASSET_ID`, `OTHER_SERIAL` (holder = asset name, else asset ID, else null → "another asset"). `EnrollViewModel.submitTag` calls it before `padRfid` and shows `enrollTagText(it)` on a hit, as the web checks the raw value before padding. `checkEnrollTag` is unchanged. A hit refuses with "That's this asset's own asset ID, not an RFID tag." / "That's this asset's own serial, not an RFID tag." for the target asset, and "That's the asset ID for *name*, not an RFID tag." / "That's the serial for *name*, not an RFID tag." for another (name = asset name, else asset ID, else "another asset"). Sentences in `SledWords` (ruling 36); `checkEnrollRaw` returns the verdict and `enrollTagText` maps each of the four new issues to its `SledWords` sentence.

**320 dp.** At `w320dp-h533dp-hdpi`, every option of the trigger control, the Scan buttons, each chooser line and each fix button is displayed with `boundsInRoot.right <= root width`, checked the way `AssetLookupScreenTest.fitsAt320dp` checks Search and Clear. Estimates (nothing rendered): "RFID | Barcode | Both" about 210 dp of the 288 dp a 320 dp screen leaves; control plus Scan button about 298 dp, so they stack in the `FlowRow`.

**Colors.** Every color on the new lines (the slot's red and muted tones, the scanner line, the disagreement line, the chooser) comes from `LocalKioskColors` and `ChipTone`, as the rest of the tab does; no fixed colors, and every new line follows light and dark.

## Words

Vocabulary: **sled** is the thing in the hand; **the sled's barcode scanner** is its imager; **tags** and **barcodes** are what it reads. Never on an operator screen: session, layout, key layout, imager, plugin, read-back, SDK, HID, or any `RFID_…`, `DCSSDK_…`, `ENUM_…` name. Result names go to the log.

Every sled sentence is a constant or a function in `SledWords` (`core/rfid`), used by the adapter and the screens alike. Test (`SledWordsTest`, new): every constant, and every function's output for representative inputs, contains none of `RFID_`, `DCSSDK_`, `ENUM_`, `SDK`, `layout`, `session`, `imager`, `plugin`, `read-back`, `HID` (case-insensitive for the words). The refused-settings sentence takes the RFID tab's row labels as its names; the tab's own "Session" row label is the one allowed use of that word, and the test checks that sentence with other labels. The same test covers `connectionLine`, `sledLine`, the layout hints, the Enroll sentences and the adapter's `Failed` reasons. `SledWordsTest` is written in T1 for every `SledWords` member and `connectionLine`; Track B adds `sledLine`'s table test, and Track A asserts that every adapter `Failed.reason` is a `SledWords` value.

Rows marked "added" are not in the operator critique; this revision wrote them because a rule needs them.

### Connection (RFID tab, Devices tab, the scan-screen slot)

| State | Sentence | Button |
|---|---|---|
| Reader off | Off. Turn the reader on to use the sled. (unchanged) | none |
| Not connected | Not connected. (unchanged) | Connect |
| Connecting | Connecting… (unchanged) | Connect, dimmed |
| Connected | Connected to *name* · battery *n*% (unchanged) | Disconnect |
| Dropped, trying again | The sled disconnected. Reconnecting… | Stop |
| Gave up, or a connect failed | Couldn't reach *name*. Make sure it is on, charged and close by, then tap Connect. (*name* is "the sled" when none is chosen) | Connect |
| Same, more than one sled paired | the same, then: To use a different sled, choose it in Settings › RFID. | Connect |
| Bluetooth off | Bluetooth is off. Turn it on to use the sled. | Turn on Bluetooth |
| Permission missing | Android needs Bluetooth and location permission before the sled can connect. Grant them in this app's settings. (today's, byte for byte) | Open app settings (today's) |
| No sled paired | No sled is paired with this device. Pair the RFD40 in Bluetooth settings, then come back and tap Connect. (provisional until the script records the real pairing steps) | Bluetooth settings |
| Several paired, none chosen | More than one sled is paired with this device. Choose one in Settings › RFID. | none (on the RFID tab: the list) |
| A paired device has no name (added) | A paired Bluetooth device has no name. Remove it in Bluetooth settings. | Bluetooth settings |
| Two paired devices share the sled's name (added) | Two paired Bluetooth devices are named *name*. Remove the one that isn't the sled in Bluetooth settings. | Bluetooth settings |
| No region | *name* has no region set, so it can't read tags. An admin sets it in Settings › Admin. | none |
| Never connected, trying again (added) | Connecting to *name*… (*name* is "the sled" when none is chosen) | Stop |
| Stored tags cleared, connecting again (added; `BATCH_CLEARED_RETRYING`) | The sled was holding tags from offline use. Connecting again… | none |
| The app could not load the sled's software (class-loading error; added) | This app couldn't start the sled connection. Restart the app; if it happens again, reinstall it. | none |
| Trigger did not set up, while retrying (`TRIGGER_NOT_SET_UP` while reconnecting) | The sled connected, but its trigger didn't answer. Trying again… | Stop |
| Trigger did not set up, not retrying (added) | The sled connected, but its trigger didn't answer. Tap Connect to try again. | Connect |
| Sled asks for a password | This sled is locked with a password. This app can't unlock it. | none |
| Note after clearing stored tags | The sled was holding tags from offline use. They were cleared. | none |
| Note when the stored tags could not be cleared (added) | The sled was holding tags from offline use. They couldn't be cleared. | none |
| A second batch result in a row | `BATCH_MODE_UNRECOVERABLE_MESSAGE`, today's text with "an earlier offline session" changed to "earlier offline use" (ruling 37) | none |

### Sled triggers

| Where | Text |
|---|---|
| Row label | Sled triggers |
| Options | RFID · Barcode · Both |
| Hint, RFID | Upper and lower triggers read tags. |
| Hint, Barcode | Upper and lower triggers scan barcodes. |
| Hint, Both | Upper trigger reads tags. Lower trigger scans barcodes. |
| The sled reports something else | The sled didn't take that. It is set to: *the hint for what it reports* |
| The check failed | Couldn't check the sled's trigger setting. |
| No scanner (control dimmed) | This sled has no barcode scanner. Both triggers read tags. |
| Zebra host (control dimmed; R2) | On this device the handheld's own scanner reads barcodes. Both sled triggers read tags. |
| Scan screens | the caption "Sled triggers" only |

"What it reports" is built per trigger from the read-back: RFID "reads tags", sled scan "scans barcodes", terminal scan, notify, none and unknown "is not assigned"; "Upper and lower triggers …" with the plural verb when both are the same, else "Upper trigger … Lower trigger …". The three hints above are exactly what this builds for the three layouts. Upper and lower may be the other way round on the sled (hardware); the script's Both step corrects the hints in this one place.

### The sled's barcode scanner (RFID tab; Starting and the two failures also in the slot)

| State | Sentence | Button |
|---|---|---|
| `Opening` | Starting the sled's barcode scanner… | none |
| `Ready` (RFID tab only) | Barcode scanner ready. | none |
| `DID_NOT_START` | The sled's barcode scanner didn't start, so scans from the sled won't arrive. Tap Try again, or scan with the camera. | Try again |
| `STOPPED_RESPONDING` | The sled's barcode scanner stopped responding. Close the app and open it again. | none |
| `BLUETOOTH_OFF` | covered by the connection line | |

### Reading

| Case | Sentence |
|---|---|
| The read did not start | The sled didn't start reading. Pull the trigger again. |
| The sled is on its charger (`RFID_CHARGING_COMMAND_NOT_ALLOWED`) | The sled can't read tags while it is charging. |
| No region | the connection sentence for no region |
| A stop was not confirmed | The sled may still be reading. Pull the trigger once to stop it. |

### Settings, Admin, Developer, RFID Enroll

| Where | Sentence |
|---|---|
| A setting was refused | The sled didn't accept: transmit power. The other settings were applied. (names each one refused, by its RFID tab row label) |
| The push stopped at link trouble (added) | The sled stopped answering before every setting was applied. |
| Power above the sled's top | This sled's maximum is *n* dBm. |
| Admin, the region list failed to load | Couldn't read the sled's regions. Tap Retry. (button Retry) |
| Admin, after a region is set on a sled that had none | Region set. Reconnecting the sled… |
| Developer row (developers only; ruling 35) | Label: Zebra SDK logging. Hint: Writes everything sent to and from the sled to this device's log, including tag and barcode values. Off again when the app closes. |
| RFID Enroll, the asset's own barcode | That's this asset's own asset ID, not an RFID tag. / That's this asset's own serial, not an RFID tag. |
| RFID Enroll, another asset's barcode (the web's words) | That's the asset ID for *name*, not an RFID tag. / That's the serial for *name*, not an RFID tag. |

### What gets no sentence

A sled barcode with no scan screen open, or with the app not in front (ruling 19); a typed scan with no session copy ("typed only", log only); a sweep the sled ended by itself (the panel closes and the tags queue; ruling 45); a battery, power or temperature event whose cause text has not been seen on a sled (log it, show nothing until the words are known).

### The two behaviors in the "RFID reader" hint (and the hand-off)

- **Display.** "While the sled is in use, the display stays on in the scan screens, so the sled isn't dropped when the phone sleeps. It turns off after 10 minutes without a trigger pull or a touch." (adjusted to ruling 5's Enroll, Print Labels and idle rules)
- **Reconnect.** "If the sled drops, the app tries to reconnect four times over the next few minutes. Tap Stop, or turn the reader off, to stop it."
- Sled keystrokes need no line: nothing is swallowed, and a scan is entered once.

## Options: what each SDK option gets

| Option (matrix row) | Decision |
|---|---|
| Reader choice (A1) | Now: pre-check by saved address; chooser when two or more are paired |
| Reader appeared / disappeared (A2) | Not used: the SDK clears its handlers on every dispose; the app's own receiver nudges the reconnect |
| Connection password (A4) | Not now; a sentence when `connect()` returns `RFID_CONNECTION_PASSWORD_ERROR` |
| No region at connect (A5), batch mode at connect (A6) | Now |
| Disconnect event (A7), reconnect (A8) | Now (a fresh connect, never `reconnect()`) |
| Command serialization (A10) | Now: one worker thread, never interrupted |
| SDK logging (A11) | Now: Developer switch |
| Transmit power (B1) | Now: index from the reader's table by the unit rule; slider capped |
| Link profile, Tari (B2, B3) | Left as the sled has them; logged |
| Session, tag population (B4, B5) | Kept |
| Inventory state, SL flag (B6, B7) | Pinned to A and ALL, no control |
| Unique reporting, purge (B9, B10) | Now: purge before each sweep when unique reporting is on |
| RSSI and tag fields (B11), tag locating (B18) | Not now |
| Inventory start and stop events (B14) | Now |
| Pre-filters (B16) | Left as the sled has them; a plain inventory sends neither select flag; whether the sled applies stored filters is (hardware) |
| LED blink (C2) | Removed |
| Feedback cue (C3), scanner beep and vibration (C4) | Not now |
| Trigger type (D2), key layout (D3) | Now |
| Trigger mode (D4) | RFD8500 only, always with the plugin flag false; plugin flag (D5) removed |
| Trigger status query (D8) | Not used until a lone release is seen (hardware) |
| Has a scanner (E1), scanner session (E3), barcode data (E4), soft trigger (E6) | Now, never on a Zebra host |
| Aim (E7), scanner settings (E8) | Not now |
| Session auto re-establish (E9) | Never (the app owns reconnect) |
| Bluetooth host mode (E10), scan batch mode (F4) | Read and logged only. The host-mode setter always throws; the scan-batch setter works and is never called. |
| Batch mode event (F2) | Not needed for recovery |
| Battery level (G1) | Now, with the consuming read; charging not shown; statistics (G2) not now |
| Power and temperature events (G3) | Registered and logged; no sentence until the wire text is seen |
| Idle power-off (G4), friendly name (I3) | Not now |
| Cradle (G5), factory reset (J2), reader reset (J3) | Never called |
| Supported regions, set region (H1, H3) | Now |
| Model, serial, firmware (I1, I2) | Now, in the connect dump; not shown on the RFID tab |
| Save configuration (J1) | Only in the batch-mode functions; never for a layout |

## Things that must ship together

- The trigger-type filter with the key-layout write.
- Keep-display-on with the disconnect event and the reconnect.
- `ENUM_TRANSPORT.BLUETOOTH` with the app-side pre-check (the `Readers.Dispose()` null trap).
- Dropping `SCAN_DISABLE` with the key layout.
- `NeedsRegion` only with `BLUETOOTH` (a listing with `ALL` re-points the SDK's static transport while a reader object is held).
- Failed-start handling only with the `perform()` outcome table (a timeout is "unconfirmed", not a failure).
- Battery polling and the layout read-back only with the job queue's no-call-during-a-sweep rule; every battery request only with its consuming read.
- Sled barcodes on `ScanBus` only with `SledScanGuard` and its three hooks.
- The scanner session only with `DISABLED` on loss and the Bluetooth-on check before `BT_NORMAL`.
- The automatic reconnect only with the generation (one push per generation) and the `linkWanted` cancel rules.
- "Turning the reader off disconnects" only with `updateRfid` (a stale snapshot would write `enabled = false`).
- IMMEDIATE triggers as a must step only with triggers ignored until `Connected`.
- Removing the scanner-plugin setting only with the Zebra-host RFID-only rule and the one `ENABLE_PLUGIN` broadcast.
- The no-SDK-names sentence rule only with the rewrite of the adapter's message tests.

## Tests that change

"Test" = rewrite the test; the design is right. "Design" = the design gave way to keep what the test pins.

| # | Change | Existing tests that fail | Gives way |
|---|---|---|---|
| 1 | Settings: remove `triggerPersonality`, `scannerPluginMode`, `ledOnRead` | `RfidSettingsTest.defaultsMatchTheSpec`, `roundTripsThroughJson`, `junkAndMissingFieldsFallBackToTheDefaults`; `RfidControllerTest.togglingOnlyTriggerPersonalityOrScannerPluginModeDoesNotPushSettingsToTheReader`; `RfidPanelTest.pickingATriggerPersonalityWritesIt`, `pickingAScannerPluginModeWritesIt` | Test. Add: an old document with `"triggerPersonality":"barcode"` reads as Barcode; both keys present, `triggerLayout` wins; a `triggerLayout` or `readerAddress` change calls no `apply()` |
| 2 | `connect(request: SledConnectRequest)` | Compile failure in the eight hand-written doubles (`RfidControllerTest.kt:338, 440, 671, 752, 837, 871`; `RfidRegionControllerTest.kt:99`; `RfidPanelTest.kt:144`), `FakeRfidReaderTest` (six calls), `ZebraRfidReaderTest` (five calls, two seam overrides at :83 and :394), `RfidControllerTest.kt:250`, and in main `DeveloperPanel.kt:25-26, 115` | Test (mechanical); wrappers become `RfidReader by inner` |
| 3 | Pre-check before any vendor object | `ZebraRfidReaderTest.aConnectCancelledPartwayLeavesADefiniteStateAndNoAttachedReader` (renamed `aConnectCancelledPartwayLeavesADefiniteStateWithTheLinkItBuilt` in the final fix wave), `aConnectFollowingADisconnectionEventTearsDownThePreviousReaderFirst`, `aBatchModeRecoveryThatExhaustsAllThreeAvenuesReportsTheFinalMessageRatherThanCrashingOrLooping` (no bonded sled under Robolectric) | Design: the pre-check sits behind its own `protected open` seam |
| 4 | A pull starts a read only while `Connected` | `RfidControllerTest.aSlowLifecycleConnectDoesNotStarveArm` (its proof is a sweep opened while not connected) | Test: keep its purpose; release the connect, then pull. Correct the header comment at :34-42 |
| 5 | A failed start closes the sweep | `RfidControllerTest.aTriggerWhoseStartInventoryThrowsAnErrorDoesNotKillTriggerHandling` | Test: a thrown `Throwable` is a start failure; "session closed, `readError` set, next press starts a read" |
| 6 | Stop retried once, "may still be reading" | none: `aStopThrowingAnErrorFromStopInventoryDoesNotWedgeTheController` throws on every stop | Design: the retry and the pre-start stop apply to returned failures only |
| 7 | Turning the reader off disconnects | `RfidControllerTest.togglingOnlyEnabledDoesNotPushSettingsToTheReader` | Test |
| 8 | No vendor call during a sweep | `aTriggerPullOpensTheBurstWhileASettingsPushIsStuckOnTheVendorLink`, `RfidRegionControllerTest.aTriggerStartWaitsForAnInFlightRegionWriteToFinish` (read literally) | Design: the rule is "between `startInventory()` issued and `stopInventory()` returning"; both keep passing |
| 9 | Batch recovery replaced | `ZebraRfidReaderTest.batchModeRecoveryUsableRequiresConnectedAndBothFieldsPresent` | Test: deleted with the helper |
| 9b | Same | `batchModeUnrecoverableCarriesTheHonestFinalMessage`, `aBatchModeRecoveryThatExhausts…` | Design: `BatchModeUnrecoverableException` and its pinned phrases stay as the terminal state; the second test's comment about three avenues is updated |
| 10 | Plugin flag and trigger-mode note removed | `resolveScannerPluginFlagFollowsDataWedgePresenceOnlyWhenAutomatic`, `triggerModeOutcomeNoteNamesTheCombinationWhenAccepted`, `triggerModeOutcomeNoteNamesTheCombinationWhenRefused` | Test: deleted with the functions |
| 11 | No `SCAN_DISABLE` | `ZebraBarcodeEngineTest.imagerStandDownNoteForSuccessSaysItWasSilenced`, `…ForNotIdentifiedNamesTheProblemAndTheRisk`, `…ForSessionFailedNamesTheVendorResult`, `…ForCommandFailedNamesTheVendorResult`, `…ForUnreachableNamesTheDetail`, `everyOutcomeProducesADistinctSentence` | Test: deleted. The five `chooseScanner…` tests and `scanCommandXmlIsEmpty` stay |
| 12 | The note only while connected | `RfidPanelTest.connectNoteAppearsBeneathTheConnectionLineWhenSet` (the fake is `Disconnected`) | Test: connect first |
| 13 | Connect gated on Nearby devices | `RfidPanelTest.aStaleConnectionErrorIsHiddenWhileARetryIsStillInFlight`, `aFailedConnectionReasonAppearsExactlyOnce`, `whenErrorTextDiffersFromStatusLineBothAppear` (Robolectric grants nothing) | Test: grant `RfidPermissions.REQUIRED` first |
| 14 | The slot replaces the transition toast | `ScanScreenTest.aDisconnectWhileArmedShowsAToastOnScreen`, `aReaderAlreadyFailedBeforeTheScreenOpensShowsNoToast` | Test: a drop during the visit shows the red line once; a state already there at open shows the muted line, never red |
| 15 | `ENUM_TRANSPORT.BLUETOOTH`; never-call scans | `ZebraReadersConstructibleTest.kt:40` constructs `Readers(context, ENUM_TRANSPORT.ALL)` (fails only if a scan walked `src/test`) | Test: construct with `BLUETOOTH`; the scans read `src/main` only |
| 16 | A receiver registered while in front | `AppContainerPrinterTest.linkClosesOnBackgroundAndSignOut` calls `processLifecycle.onStop` before `onStart` | Design: register and unregister are idempotent |
| 17 | Controller constructor grows | eleven sites pass `clock` as a trailing lambda (`RfidControllerTest.kt:53, 498, 547, 610, 722, 802, 921, 958, 1010`; `RfidRegionControllerTest.kt:33, 159`) | Design: `clock` stays last; new parameters go before it with defaults |
| 18 | No SDK names in operator sentences | `ZebraRfidReaderTest.operationFailurePrefersResultsAndStatusDescriptionTogether`, `operationFailureFallsBackToVendorMessageWhenNoStatusDescription`, `operationFailureWithOnlyAResultsNameStillNamesIt`, `operationFailureWithOnlyDetailAndNoResultsNameStillReports`, `operationFailureWithNothingAtAllStillEndsInASentence`, `invalidUsagePrefersInfoOverVendorMessage`, `invalidUsageFallsBackToVendorMessageWhenInfoIsBlank`, `invalidUsageWithNothingAtAllStillEndsInASentence`, `genericMessageKeepsAnAlreadyReadableSentenceAsIs`, `genericMessageWrapsAShortOrUnpunctuatedRawMessage`, `genericMessageFallsBackWhenThereIsNoMessageAtAll`, `regionNotConfiguredGetsItsOwnActionableSentence` (they pin result names inside sentences) | Test: sentences come from `SledWords`; result names are asserted in the log line instead; the region test asserts the `NeedsRegion` sentence names "Settings › Admin" and contains no `RFID_` |
| 19 | Waits replaced (ruling 9) | `RfidControllerTest.aStuckSettingsPushReportsATimeoutAfterVendorTimeoutMsElapses` (15 s); the two tests in `ZebraRfidReaderTest`'s "cancellation / stale-reader teardown" block (`aConnectCancelledPartwayLeavesADefiniteStateAndNoAttachedReader` (renamed `aConnectCancelledPartwayLeavesADefiniteStateWithTheLinkItBuilt` in the final fix wave), `aConnectFollowingADisconnectionEventTearsDownThePreviousReaderFirst`) | Test: the push wait is 10 s; the cancellation tests move to the worker model (a caller that stops waiting leaves the block running; the state still ends definite; cleanup runs once) |
| 20 | Pre-check under Robolectric | `ZebraRfidReaderTest.connectingWithNoReaderPresentFailsWithSomethingReadable` | Test: new signature; the pre-check now fails first, still with a sentence |
| 21 | Fake's stop when not connected | `FakeRfidReaderTest` (no test pins success today; check) | Test if needed: `SledNotConnected` |
| 22 | Enroll's new raw check (`checkEnrollRaw` in `submitTag`) | `EnrollViewModelTest`, `EnrollGateTest`: any fixture whose tag value equals a roster asset's ID or serial | Test: check the fixtures when building |

Tests that keep passing but pin something the design must not move:

- `BluetoothPermissionsTest.theManifestTiesScansToLocationAndKeepsBluetoothLeOptional` reads the manifest as text: the exact `<uses-permission android:name="…" />` lines for `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`, no `neverForLocation`, and the `bluetooth_le` feature line. `tools:node="remove"` and `android:configChanges` leave them byte for byte.
- `AdminRegionTest.batteryPercentageChangeAloneDoesNotReloadRegions` asserts one `regions()` call after connect: `NeedsRegion` detection lives in the adapter; the controller never calls `regions()` at connect; `AdminPanel`'s effect stays keyed on a boolean.
- `AssetLookupScreenTest.leavingDisarmsTheSled`, `sweepOfSeveralTagsSaysSo`, `ScanViewModelRfidTest`, `DeveloperRfidBurstTest` (all three) and `AdminRegionTest` connect while `enabled` is false: `enabled` gates automatic connects only.
- `RfidSettingsTest.powerConvertsToTheTenthsOfADbmTheSdkWants`: `powerToTenths` stays as the no-table fallback.
- `RfidPanelTest.turningTheReaderOnWithAMissingPermissionRequestsIt` picks `onAllNodes(isToggleable())[0]`: nothing toggleable above the switch (`Segmented` is clickable, not toggleable). Its comment names "Blink on read" and is corrected.
- `RfidPanelTest.aMissingPermissionShowsTheWarningAndTheSettingsButtonWhileEnabled` pins the permission sentence and "Open app settings": both kept.
- `RfidPanelTest.restoreDefaultsPutsEverythingBack` (power back to 27) keeps passing.
- `RfidControllerTest.lifecycleStyleConnectAndDisconnectLandInTheOrderIssued` must still end in the last-issued state.
- `RfidControllerTest.aTriggerPullArrivingWhileAStopIsInFlightStartsANewReadOnceTheStopCompletes` and `aTagArrivingWhileStopInventoryIsInFlightIsStillIncludedInTheBurst` catch the obvious lock-order inversions.
- `ZebraRfidReaderTest.everyOperationOnADisconnectedReaderReportsRatherThanThrows` keeps passing (`SledNotConnected`).
- `RfidConnectionTest`: `Failed(reason)` with defaults still constructs.

Guard tests the new code can trip:

- `RemovalGuardTest` (`TOUCH_POINTS`: `AppContainer.kt` 7 marked lines, `DeveloperPanel.kt` 2) and `MarkedLinesAreDeletableTest`: the work edits both files next to marked lines (`AppContainer.kt:113, 121, 226, 243, 282`; `DeveloperPanel.kt:35, 64`). A marked line may not be edited, joined, split or re-indented. `RemovalScan.refers` fails any file outside `nettest/` that contains "nettest" in any case or the marker text.
- `CorePurityTest.onlyDesignatedFilesImportTheZebraSdk` allows `import com.zebra` in the two Zebra files only; `coreImportsNothingFromAndroid` and `coreRfidImportsNothingFromZebra` hold for every new `core/` helper.
- The never-call scans: scope and patterns as written above, so `reader.connect(request)` in the controller and `zebraBluetooth.connect(…)` in the printer code do not match, and the Zebra files' KDoc and log strings naming forbidden calls are stripped first.
- `AndroidRegexTest`: no `(?u)`, `(?U)` or `(?d)` in new patterns (name matching, barcode decode).

## Testing

Unit and Robolectric tests with the fake reader and a fake scanner SDK; no test contacts a sled. The full suite (baseline 1441 tests, 0 failures) and `assembleDebug` must pass. New tests, by the names the critiques use:

**Controller (concurrency section 5 and the critic's T-list).**

1. T15, lock stress: connect, disconnect, push, layout change, start, stop and region load from several coroutines on `Dispatchers.Default`; the fake asserts one call at a time; the test ends, so nothing deadlocked.
2. A push pending, a sweep open, the link drops: the sweep ends and its tags are queued.
3. T3: `violations` is empty after a battery poll, a layout change, a region load and a settings change, each fired during an open sweep.
4. A call made during teardown returns `SledNotConnected` and shows no error.
5. A loss recorded during setup fails the connect; a stale-generation loss changes nothing; a loss during teardown ends `Disconnected`.
6. Two connections with no observed gap between them both get a push.
7. Backoff with virtual time: waits of 2, 4, 15, 60 s and nothing in between; no call after `disconnectForLifecycle()`, `disconnectNow()`, `stopReconnecting()` or disable, including when the wait was already running or a try was dialing (that try runs to its end, nothing follows it, and Bluetooth turning on afterwards does not dial); a nudge during an attempt does nothing; a nudge during a wait dials once; four failures end with `reconnecting` false and the give-up sentence; a never-up failure retries only with a sled screen open; a never-up failure on another screen, then a sled screen opened: the schedule starts once; a first batch clear gets one immediate try on any screen and does not advance `attempt`; a `retryable = false` failure inside the schedule ends it; no attempt while `printerBusy()`; pre-check failures never retry on a timer.
8. The keep-display-on table (`keepDisplayOn`), including the 10-minute release, the give-up release, and `Failed` while `reconnecting` on Scanning staying on (first matching row wins).
9. A start that times out is followed by a stop; every row of the `perform()` outcome table gives the controller action listed.
10. `setRegion` in `NeedsRegion`: one disconnect, one connect, in that order, after `applyGate` is free; `connectNow()` in `NeedsRegion` does not dial.
11. Connect before the first settings value uses the saved address and layout; a read-back of RFID with a setting of Barcode still sweeps; a read-back of Barcode, or no read-back with Barcode written, does not (ruling 27); a sled with no scanner on a Barcode kiosk sweeps.
12. An unsolicited stop ends the sweep, queues its tags, sends a stop and sets no `readError`.
13. T4: a start returning "unconfirmed" keeps the session; a refusal closes it with the reason.
14. T10: connect and disconnect never overlap; a pull while `Connecting` starts nothing; a SCAN-type trigger is dropped, RFID, DUAL and unknown pass.
15. The enable edge: false to true connects once through the gate, true to false disconnects, equal re-emissions do nothing; the permission callback connects.
16. A `readerAddress` change to another sled reconnects; to the connected sled's own address does not.
17. Battery: one request per connect from the adapter; the controller's poll after a sweep and after 60 s idle; dropped while a sweep is open.

**Adapter and scanner engine.**

18. Scanner engine with a fake SDK and a direct executor: a late establish for an old generation is terminated and not published; five open and close flips during one slow establish make at most one more establish; `ALREADY_ACTIVE` not opened by this engine leads to terminate and one retry; Bluetooth off makes no vendor call; an unexpected session-terminated callback gives `Off` and a queued terminate and `DISABLED`; a barcode before the established callback or inside 250 ms is dropped; `Ready` comes after the window; a barcode while not `Ready` is not emitted; the watchdog shows `STOPPED_RESPONDING` and a late result is then applied.
19. T12, delegate guard: a sink that throws does not propagate out of `dcssdkEventBarcode`; null and empty arrays are ignored.
20. T13, pure helpers: key-layout encode and decode (4, 5, 9, 10, legacy 0 to 3, 29, junk); the fallback order; the power index over tables in both units and with a step of 10; the result classifier, including "Unknown error" against another vendor text; barcode decode (strict UTF-8, ISO-8859-1 fallback); type labels; the pre-check decision table; the teardown plan; `effectiveLayout`.
21. The adapter's seam tests with a fake vendor: a pre-check failure never reaches the vendor seam; the batch path (first time retryable with the note carried; second in a row not retryable with the honest message); `NeedsRegion` publishes `info` first.
22. T8, vendor pin test by reflection on the bundled `.aar`: `Config.setKeylayoutType(ENUM_NEW_KEYLAYOUT_TYPE, ENUM_NEW_KEYLAYOUT_TYPE)`, `ENUM_NEW_KEYLAYOUT_TYPE` values 0 to 4 through `getEnumValue()`, `HandheldTriggerEventData.getHandheldTriggerType()`, `Events.setReaderDisconnectEvent`, `setInventoryStartEvent`, `setInventoryStopEvent`, `isEventRegistered(RFID_EVENT_TYPE)`, `RFID_EVENT_TYPE.HANDHELD_TRIGGER_EVENT` (public), `Actions.purgeTags()` returning boolean, `ReaderCapabilities.getTransmitPowerLevelValues()`, `Config.getAttribute(int, AttributeInfo)`, `AttributeInfo.getAttNum()`, `Config.setAttribute(SetAttribute)`, `SetAttribute(int, String, String, int)`, `RegulatoryConfig.setEnabledChannels(String[])`, `OperationFailureException.getVendorMessage()`, `SDKHandler(Context, boolean)`, `DCSSDK_OPMODE_DISABLED`, `DCSSDK_RESULT_SCANNER_ALREADY_ACTIVE`, `DCSSDK_RESULT_SCANNER_NOT_AVAILABLE`, `DCSSDK_RESULT_SCANNER_NOT_ACTIVE`.
23. T5, the two never-call scans.
24. The logging switch (Robolectric with `ShadowLog`): on, an `RFIDReader.LOGGER` line appears under `IRFIDinfo`; off, none; reset to off.

**App wiring and screens.**

25. R1's guard tests: both orders (bus then typed, typed then bus) on Scanning and on RFID Enroll deliver once (T1 for Enroll); the same route twice delivers twice (T2); a session copy arriving mid-typing is held; the hold never exceeds `MAX_HOLD_MS`; the default guard accepts everything; a refusal logs route, gap and length and never the value; Time Clock Welcome's raw keys go through the guard.
26. `dispatchKeyEvent` logs the first key per external keyboard device once and always calls `super`.
27. T11: a sled barcode with no scan-screen collector is dropped with no sentence; a sled barcode while `foreground` is false is dropped.
28. T6: with the activity moved to CREATED, a burst emitted by the controller reaches the outbox.
29. T7: `MainActivity`'s `ActivityInfo.configChanges` has every flag of ruling 15; a configuration change mid-burst keeps the session; `enableEdgeToEdge()` runs only on a night-mode change and `StatusBarIcons` re-applies.
30. The manifest no longer requests `READ_EXTERNAL_STORAGE` (Robolectric `getPackageInfo(…, GET_PERMISSIONS).requestedPermissions`).
31. `DataWedgeTest`: the `ENABLE_PLUGIN` intent's shape; `isZebraHost` for DataWedge present, a Zebra manufacturer, and neither; the broadcast is sent once per process on a Zebra host and never elsewhere.
32. Sign-in: on the Move password view a `ScanBus` event calls `submitScannedMove`; on other views it does nothing.
33. `RfidSettingsTest` additions (row 1); `KioskPrefs.updateRfid` applies two quick writes without losing either.
34. The address auto-save: an automatically chosen sled's address is saved once and does not trigger a reconnect.
35. `SledWordsTest` (Words), plus `sledLine` and the slot's priority and tone as table tests.
36. Screens: the RFID tab (chooser one per line, Sled triggers dimmed on a Zebra host and for a sled with no scanner, the disagreement line only when the sled disagrees, scanner line and Try again, Stop while reconnecting, Disconnect in `NeedsRegion`, power cap sentence); `ScanTools` on all five screens with the right controls per host (T14: an API 30 configuration for the MC2200 shows no sled control); the slot on Scanning and Asset Lookup; Admin's Retry and the `NeedsRegion` load; Enroll's web gate sentences.
37. 320 dp checks per the rule under Screens.

## Build order

All writing, build and review agents run on Opus.

1. **T1, foundation** (one task, leaves `main` and `test` compiling): the types (including `SledNudge` and `SledInfo.autoChosen`); `RfidConnection` changes; the interface with its written contract per member and its default bodies; a finished `FakeRfidReader`; `SledWords` complete, with every sentence and sentence function in Words (including the adapter's `Failed` reasons, `TRIGGER_NOT_SET_UP`, `BATCH_CLEARED_RETRYING`, the functions `couldNotReach(name)`, `refused(labels)` (the refused-settings builder) and `reports(readback)`, the Enroll sentences, and the moved `BATCH_MODE_UNRECOVERABLE_MESSAGE`, with the `ZebraRfidReader.kt` references updated) and `SledWordsTest` for every `SledWords` member and `connectionLine`; `effectiveLayout` and the two `usesScanner()` functions; `ScanSource.SLED`; `isZebraHost` and `DataWedge.enableScannerInput`; `RfidPermissions.NEARBY: List<String>` (`BLUETOOTH_CONNECT` and `BLUETOOTH_SCAN` on API 31 and up, empty below) and `fun nearbyGranted(context: Context): Boolean` (the pre-check, the Connect button and `pairedSleds()` use it; `REQUIRED` and `granted` stay as they are for the stored gate); `ZebraRfidReader(context, scope, zebraHost: Boolean = false)` with the parameter stored and otherwise unused until Track A, `AppContainer.isZebraHost = isZebraHost(app)` beside `hasDataWedge`, and `ZebraRfidReader(app, scope, isZebraHost)` wired in (the default keeps the three test constructions compiling); `KioskPrefs.updateRfid`; the settings changes and migration; delete `resolveScannerPluginFlag`, `triggerModeOutcomeNote`, `toVendorTriggerMode` and the LED push step, with their tests (Tests that change, rows 1 and 10); the eight hand-written doubles rewritten as `RfidReader by inner`; mechanical compile fixes everywhere (a compiling `ZebraRfidReader.connect(request)` that ignores the new fields; `RfidController`, `RfidPanel` and `DeveloperPanel` without the removed fields). After T1 the interface, the fake and `SledWords` are frozen.
2. **Two tracks in separate worktrees off T1.** No file is touched by both. A track that needs an interface or fake change reports it instead of editing. A track that needs a new or changed sentence reports it instead of editing `SledWords.kt`.
   - **Track A, adapter:** `ZebraRfidReader.kt` (including the adapter's own Bluetooth receiver), `ZebraBarcodeEngine.kt`, their tests, the pure helpers the adapter needs (pre-check, key layout, power index, result classifier, barcode text, teardown plan), `ExportedReceiverContext.kt`'s doc (ruling 25), the vendor pin test, the two never-call scans, and a test that every adapter `Failed.reason` is a `SledWords` value.
   - **Track B, app:** `RfidController.kt` and its tests, `PrinterLock.isLocked`, wiring (`AppContainer`, `MainActivity`, manifest, the app's nudge receiver, the effects beside the NavHost including `ui/SledDisplayEffect.kt`, `SettingsScreen`'s tab signal), `SledScanGuard` and its hooks, `sledLine` and its table test, the slot, `keepDisplayOn`, the screens, the Developer row in `DeveloperPanel.kt`, the Enroll gate, sign-in, and their tests.
3. Merge both tracks into `android-rfid-sled`; run the full suite and `assembleDebug`.
4. A whole-branch adversarial review, one fix wave, a re-review.
5. Docs: `Android_Kiosk_App/README.md` "Scanning inputs" (it still says RFID reading works on the Scanning screen only and describes none of this), implementation notes in this spec, the hardware script.
6. Do not merge to main. Do not push.

The ship-together list constrains the order inside each track.

## Hardware script (run with Jimmy; one line each, pass or fail)

A line marked **Fork** says what to change before going on.

**Before the first launch of the new build**

- Debug build, dev server, a test move, Kiosk Setup done, signed in as an admin and developer.
- In the old build, write down: what "Trigger drives" says on the Pixel (the new build inherits it: ruling 16); on the MC2200, what Settings › Devices says on the "Zebra DataWedge" row ("Present — profile ServerSherpaKiosk" or "Not installed on this device") and whether a Scan button shows on Scanning.
- Start `adb logcat -v threadtime > <a file outside the repository>` and leave it running. It holds tag values, barcodes and badge codes; never commit it. Live view: `adb logcat -v threadtime -s ZebraRfidReader ZebraBarcodeEngine RfidController SledScanGuard IRFIDinfo IRFIDError 123RFID API3Wrapper ScannerSDK-SDKHandler BluetoothManager BluetoothScanner BluetoothLEManager System.err AndroidRuntime:E`.
- Launch with `adb shell am start -n com.serversherpa.kiosk/.MainActivity`. Never `adb shell monkey`. Bluetooth and the power key are worked by hand. Nothing is changed on the device through adb; never change rotation or other system settings.
- Blocks 1, 2, 4 and 5 can run on USB. Block 3 runs on battery, or with Developer options › Stay awake confirmed off.

**Block 1. First contact (Pixel)**

1. Pair the sled from Android's Bluetooth settings. Write down the steps that worked and the name shown (feeds the "no sled paired" sentence).
2. First launch. Turn the reader on if it is off; allow the permissions. The app connects by itself.
3. Read the first connect's dump: model, firmware, serial, scanner name, capability, key layout as found, Bluetooth host mode, scan batch mode, power table first, second, last and size, battery event text, external keyboard devices. Run `adb shell dumpsys input`: is there a keyboard named like the sled? **Forks:** scanner yes, no or unknown (decides block 4's reach); the power table tops out near 30 or near 300 (decides the slider); the sled is or is not a keyboard (decides whether a typed route exists).
4. Developer tab: Developer mode on (the Zebra SDK logging row shows only then; a fresh install has it off), then Zebra SDK logging on. RFID tab: Disconnect, then Connect, to get one connect on the wire log. Does `getdeviceinfo` produce a `Command:getdeviceinfo,Status:` line? Repeat this step after every reinstall.
5. Turn the reader switch off and on: it disconnects and connects with no tap on Connect. Tap Connect twice quickly: one attempt in the log.

**Block 2. RFID only (Asset Lookup first, which records nothing; then Scanning on the test move)**

6. Set Sled triggers to RFID first. Pull each trigger: a sweep, no beam. Copy the raw `Notification:TriggerEvent` line for each trigger. **Fork:** a SCAN type here means the filter makes that trigger dead; change the filter before going on.
7. Sweep with no tag near: does the read start without an error, and does `Notification:StartOperation` arrive? **Fork:** decides whether a timeout from the start stays "unconfirmed".
8. "Report each tag once" on: sweep the same tags twice. Reported both times?
9. Each RFID tab control at each extreme, with SDK logging on: beeper Off and High, power lowest and highest, tag population 1 and 1000, session S0 to S3, dynamic power on and off. One status line per command. Then wait three minutes idle and change one setting: it must not fail.
10. Connect and then disconnect a Bluetooth keyboard during a held sweep: the sweep survives.

**Block 3. Losing the link (phone on battery)**

11. Switch the sled off while connected on Scanning, and do not touch the phone: within seconds "The sled disconnected. Reconnecting…", and the display stays on. Switch it on: it reconnects. Time both. Repeat, leaving the sled off: the give-up sentence after four tries, then Connect works. Repeat once more and tap Stop on the RFID tab during a wait: trying stops.
12. Walk out of range with the sled: expect up to about 30 seconds before the app notices (link supervision, platform).
13. Bluetooth off and on, by hand: the same. Watch for `BluetoothLEManager` lines.
14. Reader on, sled off, on Home: one attempt only. Open Scanning: the schedule runs.
15. Sled off, reader on, on Print Labels with a Bluetooth printer: print five labels during the reconnect window. All print, and no sled attempt starts while a label is sending.
16. Sit on Scanning longer than the phone's display timeout with the sled connected: the display stays on. Start a latched sweep and leave it two minutes: tags keep arriving. Press the power key: note the teardown lines. Wake: time to connected.
17. Leave Scanning untouched with the sled connected for over 10 minutes: the display turns off. Then leave the sled idle until it powers itself off: how long, and what the app shows. (Corrects the 10-minute number.)

**Block 4. Barcodes (Pixel)**

18. Sled triggers on Barcode. The scanner line: starting, then ready; how long? Pull during "starting": what happens? Scan a Code 128 and a QR on Scanning: one row each. For each scan, note which route delivered (session or typed) and every `SledScanGuard` line (which route first, the gap, the length): these give the real gaps for the guard's numbers. **Fork:** ready and nothing arrives, or it arrives twice, or only typed: stop and fix before going on. **Fork:** if "starting" lasts longer than about a second, change the order so a layout that uses the scanner is written only once the scanner is ready or has failed (no beam means not ready).
19. If the line says the scanner didn't start: Try again. Does the sled type instead? Record the reason in the log.
20. Sled triggers on Both, on Asset Lookup first: the upper trigger sweeps, the lower scans, and the lower one does not open the read panel. Note which physical trigger is which and correct the Both hint. Scan with the lower trigger during a sweep. Then the same on Scanning.
21. Switch between the three several times from Scanning, including during a sweep. Then count threads (`adb shell ps -T -p <pid> | wc -l`) and look for "Faster Firmware Thread started".
22. The Scan button: beam and a barcode; the beam stops at the barcode or after 3 seconds.
23. In Barcode layout, Bluetooth off and on by hand: no `BluetoothLEManager` line may appear; the scanner line returns to ready after the reconnect.
24. RFID Enroll with the sled: the asset's barcode, then the tag. Scan the asset's own barcode at the tag step: refused with the sentence. Scan another asset's barcode at the tag step: refused with the web's sentence. Print Labels: one label per scan. On both, the display stays on between scans.
25. Sign out. On the Move password view, scan the move QR with the sled: one sign-in.
26. Time Clock Welcome: scan a badge with the sled: one lookup.
27. In Barcode layout, background and foreground the app ten times; count threads before and after.
28. Last in this block, because it can end the process: a QR of 300 or more characters. If the app closes, look for `ArrayIndexOutOfBoundsException` in `BluetoothManager$ConnectedThread`.

**Block 5. Other devices and edges**

29. Admin tab: the region shown; with SDK logging on, copy the raw `getregion` reply row for the active region. Do not tap another region: one tap sets it.
30. MC2200 without the sled, new build: what Settings › Devices says on the "Zebra DataWedge" row (compare with the old build), whether a Scan button shows on Scanning; the handheld's scan key scans once on Scanning, RFID Enroll, Print Labels and Asset Lookup; the move QR on sign-in with the scan key; a badge on Time Clock Welcome; one delivery each. The log shows one `ENABLE_PLUGIN` broadcast.
31. MC2200 with the sled: the RFID tab shows Sled triggers dimmed with the Zebra-host sentence; scan screens show no sled control and no sled Scan button; both sled triggers sweep even when the setting says Barcode; the scan key still scans; no scanner-SDK session lines in the log.
32. Two sleds paired: the chooser appears, one per line, and the saved one is used. Forget the saved one in Bluetooth settings: the other is used and saved.
33. On the Pixel, deny Location and keep Nearby devices: Connect, sweep, scan a barcode. Note that the automatic connect on foreground does not happen (settles ruling 22).
34. The sled on its charger: pull the trigger; note the sentence and the result name in the log.

## Hand-off notes for Jimmy

Read before the hardware session:

- **No `<queries>` entry (ruling 2).** Adding it would let the app see DataWedge where it may not today, which on the MC2200 would: create the `ServerSherpaKiosk` profile with keystrokes off for every activity, so the handheld's scanner stops typing anywhere in the app; deliver scans only to the screens that collect them (Scanning, RFID Enroll, Print Labels, Asset Lookup, Time Clock and, after this branch, sign-in's Move password view); show the Scan button on Scanning, RFID Enroll and Print Labels; and flip the heartbeat's `datawedge` field. It is a separate decision for you. The DataWedge row in Settings › Devices on the MC2200 (script step 30) says whether detection works today.
- **Old settings (ruling 16).** A kiosk where someone chose "Trigger drives: Barcode" (which did nothing) comes up in the Barcode layout: no sweeps until the Sled triggers control is set back to RFID. Script block 2 starts there.
- **Logs (ruling 17).** Once a sled's barcode scanner is used, the scanner SDK logs every barcode frame at info level in any build, Time Clock badge codes included. The Developer switch adds the RFID wire log on top; it is off at every launch.
- **Display (ruling 5).** While the sled is in use the display stays on: on Scanning and Asset Lookup while it is connected, connecting or reconnecting; on RFID Enroll and Print Labels while it is connected in Barcode or Both. It turns off after 10 minutes with no trigger, tag, barcode or touch, and when reconnecting gives up.
- **Reconnect (ruling 4).** After a drop the app tries four times (waits of 2, 4, 15 and 60 seconds), then stops and says so; Stop on the RFID tab, Disconnect, the reader switch and leaving the app stop it. A connect that never came up is retried only on a sled screen. Nothing is tried while a label is printing.
- **Keystrokes (ruling 3).** Nothing is swallowed. If the sled types as a keyboard and also sends through its scanner, the second copy within 2 seconds is dropped; scanning the same thing twice on purpose still counts twice.
- **Location (ruling 22).** The Connect button needs only Nearby devices; the automatic connect still needs precise Location, until step 33 says otherwise.
- **The branch** is not merged and not pushed.

## Implementation notes

Written 2026-11-11, after the merge (M1) and the final review's two fix waves. Built on branch `android-rfid-sled` from `5f0bf6632`; not merged, not pushed. At `97ae173bc` the full suite ran 1846 tests with 0 failures (baseline 1441) and `assembleDebug` passed. Where these notes and the body above disagree, these notes describe the code. The script to run on hardware is `docs/android-sled-hardware-script.md`: this design's script adjusted to the build (two log tags added to the live view, the steps' expected sentences as `SledWords` has them, the open questions below added to steps 5 and 11, and the batch lines as "If it happens at any step").

### What shipped

| Task | Commits | What |
|---|---|---|
| T1, foundation | `527b712d0` | The frozen contract: `RfidReader` with a KDoc paragraph per member, the `core/rfid` types in `Sled.kt`, `NeedsRegion` and the new `Failed`, `SledFix`, every sentence in `SledWords` with `SledWordsTest`, the finished `FakeRfidReader`. The settings migration (`triggerLayout`, `readerAddress`, old `triggerPersonality` read), `KioskPrefs.updateRfid`, `isZebraHost`, `DataWedge.enableScannerInput`, `RfidPermissions.NEARBY` and `nearbyGranted`, `ScanSource.SLED`, the eight doubles as `RfidReader by inner`; the plugin flag, the trigger-mode note and the LED step deleted. 1484 tests. |
| A1, pure helpers | `61e64193a` | `SledKeyLayout`, `SledPower`, `SledResults`, `SledPrecheck`, `SledLifecycle`, `SledBarcodeText` in `core/rfid`, with tests. |
| A2, link on one worker | `bfb662013`, fix `894f27afa` | One never-interrupted RFID worker; the pre-check seam; `ENUM_TRANSPORT.BLUETOOTH`; a generation per connection; loss detection; connect steps 1 to 7; batch recovery once, then stop only; the failed-connect cleanup thread. |
| A3, operations | `35e667617`, fix `2dd61762d` | Steps 8 to 11; key-layout write and checked read-back; the settings push through the classifier; the `perform()` outcome table; the stop settle; unsolicited stops; region with hopping and channels; the battery block; vendor logging; `pairedSleds`. |
| A4, scanner engine | `bdce7f5c6` | One `SDKHandler(appContext, false)` per process, a scanner worker acting on the latest desired value, the stale window, both watchdogs, the Bluetooth check before `BT_NORMAL`, the soft trigger, the adapter's own Bluetooth receiver; the stand-down functions deleted. |
| A5, scans and pins | `da5a6b185` | `SledNeverCallTest` (both scans, with a fixture test of every rule) and `ZebraVendorPinTest`. |
| Track A merge | `144ae6991` | |
| B1, link and reconnect | `b0b6db49c` | `linkGate`, `linkWanted`, the stored gate, the enable edge, the reconnect schedule, nudges, `SledRetry`. |
| B2, sweeps and jobs | `755937f35`, fix `09bb94c7c` | Sweeps gated on the layout in force, failed and timed-out starts, the stop retry and "may still be reading", unsolicited stops, the job queue, the battery poll, `softScanOnce`, activity. |
| B3, wiring | `710cf13b7` | `SledScanGuard` and its hooks, the sled barcode collector, the address auto-save, `SledNudgeReceiver`, `SledDisplayEffect` and `keepDisplayOn`, `MainActivity` (key log, configuration changes, `ENABLE_PLUGIN` once, edge-to-edge), the manifest, `PrinterLock.isLocked`, the Developer row, the sign-in collector, `settingsTab`. |
| B4, screens | `90615bf2c`, fix `e741b02ff` | `sledLine` and the slot, the sled controls in `ScanTools` on five screens, the rebuilt RFID tab, Admin's region Retry and `NeedsRegion` flow, the Devices tab line, Enroll's raw check. |
| M1, merge | `de1fc5215` | Both tracks, no conflicts; 1801 tests, 0 failures. |
| Final fix wave, adapter | `8b8652cb9`, `f117785ec` | 22 findings; 1817 tests. |
| Final fix wave, app | `3988d54f9`, `97ae173bc` | 36 findings; ruling 41 and hardware step 4 amended in place; 1846 tests. |
| D1, documents | this commit | The README's "Scanning inputs" and "RFID sled", these notes, the hardware script. |

### Decisions the plan made where the design left room

- `SledRetry(afterDrop, name, lastReason)` in `core/rfid/SledRetry.kt`, and `RfidController.retry: StateFlow<SledRetry?>`, non-null exactly while `reconnecting`, so `sledLine` can choose the reconnecting sentence (after a drop, connecting to *name*, or the trigger sentence). `sledLine` takes `retry` as a last parameter defaulting to null.
- `SledWords.couldNotReach(name, severalPaired = false)`: with `severalPaired`, the sentence is followed by `USE_A_DIFFERENT_SLED`, which is the design's "same, more than one sled paired" row.
- `SledWords.refused(labels, othersApplied = true)`: `othersApplied = false` drops "The other settings were applied." An empty list gives `SETTINGS_NOT_APPLIED`.
- `SledWords` members the Words tables did not name: `SETTINGS_NOT_APPLIED` ("The sled didn't accept every setting.", a failed push with no sentence of its own), `FINISH_READ_FIRST` (today's controller text for a region change during a read), `REGION_NOT_SET` ("The sled didn't accept that region."), and the `ROW_*` row labels the refused sentence names.
- `SledConnectException(failed: RfidConnection.Failed)`: every connect failure, whose `failed` equals the state just published, so the message equals `failed.reason`.
- `SledInfo` members other than `generation` and `name` default (null, or false for `autoChosen`), so a double builds one from two values.
- Layout jobs coalesce to the latest layout, as pushes coalesce to the latest settings: at most one more write while a write is in flight, and the latest always last (Review Focus 2).
- The stored gate starts null, and a null gate does not dial: nothing automatic connects before the first `connectForLifecycle`.
- A disconnect that does not answer within 10 s is logged and sets no `connectionError`.
- `SledScanGuard(…, onTyping: () -> Unit = {})`: the hook runs on every `noteTyping`. `AppContainer` passes `{ rfid.noteActivity() }`, so `ScanInput` needs no container.
- The barcode collector's hold is computed from its own delays (`arrived` plus the waits it has made), never from a clock that does not move under Robolectric.
- `SledDisplayEffect(container, route, lastTouchMs = 0L, now = System::currentTimeMillis)`: `KioskApp` passes the last touch, and tests pass a fake `now`.

### Preflight rulings (the controller, before T1)

1. `VendorOpen`, and the A1 types named in `protected open` seams (`Precheck`, `BondedDevice`, `TeardownPlan`), are public: Kotlin refuses a `protected` member of a public class that names an `internal` type.
2. The engine seam is `internal open fun buildScannerEngine()`, not `protected open`, and the engine is built lazily on first use, never from the constructor.
3. A second batch result in a row fails as `SledConnectException(Failed(BATCH_MODE_UNRECOVERABLE_MESSAGE))` with a `BatchModeUnrecoverableException` cause, and the kept test asserts the cause.
4. Step 4 is retryable on an open error, a send error, a command timeout or a recorded loss, and not when registration silently fails with no vendor error. Amended in the final fix wave (below).
5. A2 removed the connect path's `standDownBarcodeImager` call, and A4 deleted the stand-down functions.
6. `runBestSteps` takes a trailing `name` for its `couldNotReach(name)` failure.
7. The fake keeps `inventoryRunning = false` in `connect()` and `disconnect()`, and nulls `info` at the start of every `connect()` and in `disconnect()`; `FakeRfidReaderTest` pins all four.
8. `SledRetry.afterDrop` and `name` are fixed when the schedule starts (the name from `info.name` at the drop, else the paired sled matching the request's address), and the give-up and timeout sentences are `couldNotReach(that name, severalPaired = pairedSleds().size >= 2)`.
9. Because the stored gate starts null, the edge and reconnect tests first call `connectForLifecycle { <gate> }`.
10. Controller tests drive a rig that runs in `backgroundScope` with repeated `runCurrent()` and `advanceTimeBy`, never `advanceUntilIdle()`.
11. B3 could edit `KioskApplication.kt` (on neither track's list): the class is `open`, `onCreate` takes its container from `internal open fun createContainer()`, and the test-source `TestKioskApplication` returns `testContainer()`, so spec tests 26 and 29 build `MainActivity`.
12. Helpers in new test files of the two shared packages are `private` or nested.
13. `sledLine` with `reconnecting` true and `retry` null says `connectingTo(null)` with Stop.
14. `reportsBuildsTheThreeHintsExactly` passes raw 28, not 24, for NO_ACTION/NO_ACTION.

### Amendments from the final review

The final whole-branch review had six lenses (SDK, concurrency, contract, spec, operator, regression). Every finding was fixed or recorded; none was refuted. These change the body above.

Adapter wave (`8b8652cb9`, `f117785ec`):

- **Ruling 9, cleanup after a failed connect** (and "Adapter rules", "Teardown"). The cleanup removes the listener, disconnects and disposes (`teardownPlan(linkUp = false, …)`), with no stop, batch-mode write or save, whatever the vendor says about the link, so it asks nothing of the sled. The next worker block joins it without a bound: 5 s and 20 s now only time a log line, and the references are never dropped early. The vendor's protocol and transport wrappers are static, so a cleanup does not act "against that attempt's objects only", and an abandoned one could overlap the next link.
- **Step 4 and preflight ruling 4.** After two registration tries that saw no retryable error, a checked read of 2269 decides: link trouble, or an open, send or timeout result, is retryable; a refusal, or a sled that answers, is not. The read counts toward marking the link lost.
- **The power index rule.** The real top is `levels[0] + levels.size − 1`, replacing the 400 ceiling. The unit, `powerMinDbm`, `powerMaxDbm` and `PowerTable.topIndex` come from entries at or below it, and the index is capped at `topIndex`. A1's ruling for a table with no entry of 400 or less is gone with the ceiling.
- **A layout is never saved** (step 2, "Teardown", "Trigger layout"). `SledLayoutMemory` (`core/rfid/SledLifecycle.kt`) records, by address, every sled this adapter wrote a layout to, for the life of the process. Teardown, the stop after a batch start, ruling 28's recovery and connect step 2 skip `saveConfig()` for such a sled. Step 2 goes through `batchPrevention`: "0" needs nothing; a rejected read, or a sled that may hold a layout, gets DISABLE without a save; any other value gets DISABLE and a save. The memory does not outlive the process (parked, below).
- **The batch-mode-off save trade.** Nearly every connect writes a layout, so after the first one in a process batch mode OFF is never saved for that sled: not at step 2, at teardown, after a batch start, or by ruling 28's recovery. Every connect still turns it off at step 2. Deliberate: a save would also keep the layout.
- **Ruling 40.** `SCANNER_ALREADY_ACTIVE` is always terminated and established once more, and a second `ALREADY_ACTIVE` is `Unavailable(DID_NOT_START)`. The "opened by this engine" fast path is gone: every open and close sends `DISABLED` first, which closes the vendor's socket, so that case can never be live when it is checked.
- **An unrequested termination** while the session is still wanted shows `Unavailable(DID_NOT_START)`, with Try again, not `Off`. Bluetooth turning off and a link loss still show `Off`.
- **The disconnect handler** (and two link-trouble results in a row) writes `Failed(couldNotReach(name), retryable = true, fix = SledFix.CONNECT)`. The frozen fake's `dropLink` was not changed and writes no fix.
- **`requestedLayout`** is written only inside an accepted `setTriggerLayout` block, under `stateLock`, while its generation is current, so a refused call queued before a newer connect never overwrites that connect's layout. A4's ruling "updated at the start of every `setTriggerLayout` block, whatever the outcome" is replaced.
- **Unsolicited stops.** `InventoryTracker` records the sweep whose start went out and counts the stops asked for; a stop event is dropped when a start was asked for after that read's start went out, or a stop was asked for since the event. An owed stop event expires after `STOP_EVENT_OWED_MS = 2_000`‡.
- **The tag buffer** is `TAGS_BUFFER = 16_384`‡ (was 512): a `SharedFlow` grows its buffer only as it fills.
- **The step-9 dump** also logs the link profile (antenna 1's RF mode table index), Tari and the pre-filter count, each read guarded on its own (ruling 24's "logged").
- **New seam** `protected open fun linkedReader()`, so spec test 4 (a call during teardown returns `SledNotConnected` and shows nothing) is covered whole. `ZebraVendorPinTest` also pins the trigger type's `toString()` and the dump's three accessors. Rows 3 and 19 name the renamed test.

App wave (`3988d54f9`, `97ae173bc`):

- **Ruling 41** is amended in place: Bluetooth turning on is exempt from the 2 s window. The Reconnect bullet is amended to match.
- **Connect wait** ("Link management"). The timeout writes the couldn't-reach sentence only while the link is wanted and no schedule is running; otherwise the waiting caller gets `SledNotConnected`. A schedule that starts clears the old sentence, and a try that the schedule's end overtook clears it when the link is unwanted. The try right after a first batch clear waits 60 s.
- **Start wait.** 5 s, plus `PURGE_WAIT_MS = 5_000`‡ while "Report each tag once" is on. The adapter logs `Start: purge N ms, perform M ms (OUTCOME).` to size it.
- **Activity** is stamped in `ACTIVITY_STEP_MS = 1_000`‡ steps (or when the clock moves back), and a touch counts only when a finger goes down (`Modifier.onEveryTouchDown`), so a drag no longer recomposes per frame.
- **`layoutError`** clears on each new generation, after a disconnect, and when a write the controller stopped waiting for later lands with an accepted read-back.
- **`setRegion`** runs on the controller's scope and takes `afterSet` (Admin's `updateRfid { region }` moved into it), so a cancelled caller still gets the `NeedsRegion` reconnect. A one-region sled in `NeedsRegion` is offered that region as a choice; this extends the 2026-09-16 region design's "one region = Locked".
- **Reconnect.** A drop starts its schedule only when the stored gate passes (otherwise the failure line, no flashing "Reconnecting…").
- **The nudge filter** (`core/rfid/SledNudgeFilter.kt`) uses the last or saved sled's address only while that sled is still paired, else the name rule; the receiver and the controller share it. This replaces the Reconnect bullet's "the last connected sled's address".
- **The nudge receiver** is registered `RECEIVER_EXPORTED`, so the Bluetooth process can reach it with `ACL_CONNECTED` (B3's `RECEIVER_NOT_EXPORTED` is replaced). It logs each Bluetooth-on and each link it hears, addresses only.
- **The chooser.** Choosing a sled while the state is the "More than one sled is paired" failure connects to it.
- **The slot** ("Scan screens", row 14). A connection line is red only for a drop seen during the visit: a failure after the link was up since the screen opened, or a reconnect after a drop the visit saw begin. "Connecting…", "Not connected." and the never-up tries an open screen starts stay muted. The region and scanner lines keep the text-at-open rule, and a read error is always red. The slot sits under the tool row, still below the scan box.
- **The RFID tab.** The Sled triggers row sits above Trigger (B4 had it after). The dimmed row hints and lights the layout in force (`effectiveLayout`, so RFID), and the hint and the control read one settings value.
- **The guard's hooks table** gains Time Clock's Enter Your Name (text growth notes typing, Search or Enter goes through `acceptTyped`, a refused copy clears the box) and sign-in's Move password field (typing noted, Enter through `acceptTyped` via `submitMoveTyped`; the Sign in button stays unguarded).
- **`SledWords`** gained the RFID tab's row hints (`HINT_*`), `activeRegion(code)` and `READERS_OWN_REGION`, byte for byte the old inline texts. This edited a file frozen after T1, safe once the tracks had merged. "RFID reader", "Trigger", "Repeat sweeps", "Region" and "Restore defaults" stay inline.
- **Logs.** One `DataWedge` line per `ENABLE_PLUGIN`; one `SledScanGuard` "Delivered a sled scan through the scanner session (N characters, TYPE)." per session scan, never the value; the nudge receiver's lines.
- **Hardware step 4** starts with Developer mode on.
- **Parked items closed by the two waves:** A4-r0-1 to -3 and -7, B1-r0-1, -3, -5 and -7, B3-r0-2 and -3, and the RFID tab hints parked at B4. Enroll's sled controls gained the screen test spec test 36 asked for.

### Parked at the final review

- `SledLayoutMemory` lasts only for the process. After an app restart without a sled power cycle, the first connect's step 2 (on a 1500 read other than "0"), or the teardown of a connect that failed before step 10, can still save a layout the previous process wrote. It needs the hardware answer to whether an RFD40 keeps its running settings across a link drop (script steps 5 and 11).
- After a first batch clear, the `BATCH_CLEARED_RETRYING` sentence gives way to "Connecting…" almost at once, because the immediate try clears `info`, and stays replaced through the up-to-20 s cleanup join. Cosmetic.
- `TimeclockFlowViewModel.onType` returns early while a lookup runs, so a refused typed copy can stay in Enter Your Name's box until the next key or step. Harmless.
- From the re-review: an orphaned KDoc in `RfidControllerTest` above the new scope-cancel test. The live-view logcat filter missing `DataWedge` and `SledNudgeReceiver` is fixed in the hardware script.
- Older minor items still parked are listed one per line at the end of the hardware script.

### Implementer rulings that changed this design

The task reports (`.superpowers/sdd/2026-11-10-android-sled-sdk-review/task-*-report.md`, not in git) hold every ruling. These are the ones that change or extend what the body says; rulings that only picked a mechanism inside its letter are left there. "Replaced" marks a ruling a later fix undid.

T1:
- Every wrong-state call on the fake fails with `SledNotConnected`; a non-`SledConnectException` connect failure is wrapped, with the original as its cause; a blank reason falls back to `couldNotReach(name)`.
- The fake's `setConnection`: `Connecting`, `Disconnected` and `Disabled` clear `info`, `Failed` keeps it. `stopInventory` while `Connected` always clears `inventoryRunning`. Its accepted read-back has `raw = null`.
- `SledWords.reports` treats "the same" as the same description, so two different unassigned keys read "Upper and lower triggers are not assigned."

A1:
- After a failed write, `runLayoutWrite` accepts a read-back equal to that entry's own pair (a fallback's pair, not only the first request's), and it reads back after every failed write, link trouble included.
- In the push, a second out-of-step result on one step counts as a refusal, and a retry that meets link trouble stops the push.
- An invalid-usage error is a refusal for `perform()`; at connect it is `couldNotReach`, not retryable, with fix CONNECT.
- The duplicate-name pre-check compares names exactly, case included (the SDK's own match).

A2:
- The "region reads `NA`" check is a best step right after step 1 (the step table has no region read).
- Step 7's one retry each follows any failure except link trouble and a region refusal. Step 4 also treats `RFID_COMM_NO_CONNECTION` as retryable.
- Link trouble in a setup step fails with `couldNotReach(name)` without the several-paired sentence.
- A batch result "in a row" is reset by any other outcome of the vendor open, not by a pre-check refusal; a third in a row is the end state too.
- A connect whose generation is stale when its block starts makes no vendor call and returns `SledNotConnected`; a failure that ends stale returns `SledNotConnected` and publishes nothing.
- The batch recovery's steps are bounded by the vendor's own waits (about 24 s worst case); the 20 s figure applies to its close.
- A leaf lock, `stateLock`, makes the generation check atomic with the state writes; it never surrounds a vendor call or another lock, so the lock order is unchanged.
- Fix round: a second batch result in a row gets only a stop (no purge, no batch-mode write, no save, `batchRecoveryPlan`), `batchRecovery` still turns true on it, and the batch note stays the one the purging recovery set.
- Replaced: step 2's "save only when 1500 is not '0'" (now `batchPrevention`); the cleanup's "link up when no loss, not retryable and the vendor says up" (now always `linkUp = false`).

A3:
- Step 11 fails the connect on the battery read's first timeout (ruling 46), through a third `batteryBlock` parameter.
- `stopInventory` always sends the vendor stop while `Connected`; with nothing running, a refused stop is success and no wait runs. A refused stop while a read ran fails with `MAY_STILL_BE_READING`.
- The purge before a start follows the last applied settings, kept across connections.
- Has-scanner comes from the vendor's `ReaderDevice.getDeviceCapability`: "…SCAN…" true, "PREMIUM (WiFi)" and "STANDARD" false, anything else null.
- `regions()` reads `getRegionInfo` for the active region only, `setRegion` for the picked one; blank channel entries are dropped; a picked region whose detail cannot be read counts as not configurable.
- A region refusal during steps 8 to 11 ends the connect in `NeedsRegion` with the info gathered.
- `vendorLogging` is process-wide (a companion flow). A start event of the current generation marks a read running even when the app did not ask (the only way it learns of the sled's own start).
- Fix round: the stop settle is timed from the stop's return; a battery level that arrives during the connect shows at the publish; each IMMEDIATE trigger write is guarded and retried on its own; an owed stop event is consumed only when no stop is in progress.

A4:
- Each open request gets a number, and the worker opens at most once per request, so a `DID_NOT_START` does not loop.
- An accepted `ALREADY_ACTIVE`, or a `SUCCESS` whose callback never came, starts the stale window when establish returns.
- The watchdog shows `STOPPED_RESPONDING` only while a session is wanted; `retry` while stuck fails with `SCANNER_STOPPED_RESPONDING`.
- Step 12 is asked from the RFID worker at the `Connected` publish, not after `connect` returns to its caller.
- The adapter's Bluetooth receiver is registered when the engine is first built and never unregistered.
- When Bluetooth turns off, the close's terminate and `DISABLED` still run (Review Focus 5's "no vendor call" means no open call).
- A barcode is gated on `Ready` only, not on its scanner id.
- Replaced: the `ALREADY_ACTIVE` ownership record (now always terminated); "an unrequested termination holds the request closed and shows `Off`" (now `DID_NOT_START`); `requestedLayout` written whatever the outcome.

A5:
- `Dispose(` with no occurrence passes ("at most once"). Plain patterns match as substrings, and string templates count as code.
- The pin test also checks the return types the adapter relies on.

B1:
- `connectNow` and `disconnectNow` go through the FIFO `connectionCommands` queue on the controller's scope, not a bare `scope.async`, so the last-issued state still wins.
- Each `reader.connect()` and `reader.disconnect()` also holds `applyGate` for the call (outer to inner), so a START or `setRegion` waiting on `applyGate` can wait behind a connect.
- `reconnecting` follows the schedule: an attempt that replaces a pending try counts as the schedule's next try. A try that cannot dial (gate closed, link up) ends the schedule.
- `printerBusy()` holds back only the retry machine's tries (schedule, nudge, the batch try), checked every `PRINTER_POLL_MS = 500`‡; lifecycle, switch and manual connects do not wait for the printer.
- The batch immediate try inherits the attempt's manual flag, and its own batch failure is an ordinary retryable failure.
- A nudge is also ignored while the retry job is past its wait; a one-off nudge try outside a schedule does not set `reconnecting`.
- A timed-out caller gets `SledConnectException(Failed(sentence, retryable = true))`; a skipped connect gets `SledNotConnected`.
- A new `readerAddress` counts letter case as no change, and its reconnect is a manual attempt that runs only while the link is wanted. `setRegion`'s reconnect runs only while the link is wanted.
- "Given up" clears when the link comes up, on a manual attempt, and whenever `linkWanted` goes false.

B2:
- A stop not answered within 4 s counts as a returned failure: retried once, then "may still be reading".
- A failed start's one stop is not retried and never sets `MAY_STILL_BE_READING`, and its sweep closes with its tags queued.
- `endBurst`'s stops hold `applyGate` for each call, and a disconnect waits on `stopGate` after its own `endBurst`.
- When the link leaves `Connected`, a sweep already opened on the generation now `Connected` is kept.
- A job whose turn comes while not `Connected` makes no call and is used up. A layout job passes the raw setting; the reader writes the effective layout.
- The battery timer restarts after every finished job, so an idle sled is asked every 60 s. `lastActivityMs` starts at the controller's construction time.
- `softScanOnce` does not release a pull that failed.
- Withdrawn in its fix round: the inline region-load fast path (a region load is always a queued job).

B3:
- The guard: one accepted copy cancels at most one copy from the other route, and every acceptance still inside the window is kept; refused when the gap is under 2 000 ms (exactly 2 000 is accepted).
- The "Zebra SDK logging" row sits after the fake reader's row, above the local-data inspector, still below the developer-mode check.
- `SettingsScreen` clears `settingsTab` with `compareAndSet(tab, null)`; `SledDisplayEffect` sets `keepScreenOn = false` when it leaves composition.
- The ruling-38 collector compares addresses ignoring case.
- Sled barcodes are handled one at a time, in the sled's order. A blank Enter on Time Clock Welcome skips the guard.
- Replaced: the receiver's own last-sled address and `RECEIVER_NOT_EXPORTED` (now the shared nudge filter and `RECEIVER_EXPORTED`).

B4:
- The slot shows Stop when the line offers it, and Try again under the scanner's did-not-start sentence (`SledFix` has no Try again).
- `sledLine` gives `Connecting`, `Connected` and `NeedsRegion` no fix, and `Disabled` while enabled reads "Not connected." with Connect.
- On the RFID tab the fix row leaves out Connect (the tab's own button is there) and Choose (the chooser is the fix).
- "Region set. Reconnecting the sled…" shows once the link has left `NeedsRegion` after an accepted write, not from the tap. A region load failing with `SledNotConnected` shows nothing.
- The paired list is re-read when the link or the permissions change. The disagreement line and `layoutError` can both show.
- Fix round: the Session hint reads "A higher setting keeps a tag quiet longer after it answers."; Admin's region error clears when the link drops; the permission snapshot is read again on every resume (RFID tab, Devices tab, the slot); the dimmed row hints the layout in force.
- Replaced: the slot's text-at-open rule for the connection line (now `dropDuringVisit`), and the Sled triggers row after Trigger (now above it).

### Other deviations

- Two files frozen after T1 changed: `SledWords.kt` (the RFID tab hints, app wave) and `FakeRfidReader.kt` (KDoc only: where the fake differs from the adapter).
- Numbers chosen during the build, beside the waits list: `PRINTER_POLL_MS = 500`, `PURGE_WAIT_MS = 5_000`, `ACTIVITY_STEP_MS = 1_000`, `STOP_EVENT_OWED_MS = 2_000`, `TAGS_BUFFER = 16_384`, and the unsolicited-stop wait polled in 10 ms steps, at most 50.
- The single-file rule left `ZebraRfidReader.kt` at 2,543 lines, `ZebraBarcodeEngine.kt` at 1,023 and `RfidController.kt` at 2,096; splitting them after the merge is parked.
- Found on hardware, 2026-11-11 (steps 12 and 13): Stop tapped 0.5 s into the first try looked like a lost try, because Stop, the try it overtook and the ignored Bluetooth-on nudge logged nothing. Log lines added; no rule changed.
- No task found the spec and the plan disagreeing beyond the conflicts preflight rulings 1, 2, 3, 10 and 11 settle; in each, the spec (or the frozen contract) won.
