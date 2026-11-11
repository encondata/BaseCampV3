# Android kiosk: Zebra sled review and fix — design

Date: 2026-11-10. Branch `android-rfid-sled` (not merged; Jimmy tests on hardware first).

## What Jimmy asked for

"we have a real problem with our zebra rfid readers not running well on an android that doesn't have datawedge. Can you work through the android code and make sure that all available options are implemented and match with the sdk and expected operation. One thing missing is the switch from rf to barcode doesn't work right now. no questions just a review and fix. do not merge when complete, let me know so i can connect my phone and we can start debugging on real hardware"

So: no questions (every open decision below is a ruling, listed in "Rulings"), fix what the review finds, leave the branch unmerged, and make the build ready for a hardware session.

## How the review was done

The vendor SDK (`RFIDAPI3Library/API3_LIB-release.aar`, Zebra RFID API3 2.0.5.292, which bundles the scanner SDK 2.6.9.4) was decompiled and used as ground truth. Six reviewers read the app code against it, a seventh built an options matrix, Zebra's own guides and samples were fetched, then six verifiers tried to refute every finding, two fact-checkers answered from the SDK alone, and a critic listed what was still missing. None of the main findings was refuted. The full record (not in git) is in the main checkout at `.superpowers/zebra-sled-review/`: `connect.md`, `inventory.md`, `trigger.md`, `controller.md`, `ui.md`, `platform.md`, `options-matrix.md`, `vendor-reference.md`, `vendor-reference-extra.md`, `verify-*.md`, `blind-*.md`, `critic.md`. The decompiled SDK is at `.superpowers/zebra-sdk-src/src` (reference only; never copied into the repository).

Nothing here has been seen on a sled. Every statement about sled firmware is marked "hardware" and is in the hardware script at the end.

## What was wrong (confirmed in code)

1. **The RFID / Barcode switch did nothing.** `Config.setTriggerMode` sends a command only to an RFD8500; on an RFD40 it returns success and sends nothing. Its "scanner plugin" flag is a DataWedge broadcast. The RFD40's real control is the key layout, `Config.setKeylayoutType(upper, lower)` (sled attribute 2269), which the app never called. Zebra's trigger-remapping tutorial says the same.
2. **A barcode read by the sled had nowhere to go.** The RFID link carries no barcode data. The only route is a scanner-SDK session (`com.zebra.scannercontrol.SDKHandler`); the app opened one only to switch the imager off, and its barcode callback only logged.
3. **Every trigger pull started an RFID sweep,** whatever the setting and whatever trigger type the sled reported.
4. **A lost link was never noticed.** The app never called `Events.setReaderDisconnectEvent(true)`, and the SDK drops events that are not registered. A sled that slept or walked out of range stayed "Connected" with a dead trigger. Nothing reconnected.
5. **Each connect leaked threads.** A new `SDKHandler` per connect left one 50 ms polling thread per paired Bluetooth device, for the life of the app. `SDKHandler(context)` also opened a listening socket and started Bluetooth discovery at every connect and disconnect.
6. **`ENUM_TRANSPORT.ALL`** probed five Zebra-only transports on every connect. The right value for a paired sled is `BLUETOOTH`.
7. **The display timing out disconnected the sled.** Operators pull the sled's trigger, not the screen, so the phone dims, the app stops, and the link is torn down and rebuilt. A Bluetooth keyboard appearing or disappearing (the sled in keyboard mode) also restarted the activity and dropped a sweep.
8. Smaller, all confirmed: batch-mode recovery never stopped the batch read; a sled with no region could not be given one; a hopping-configurable region could throw inside the SDK; transmit power was sent as tenths of a dBm where the SDK takes an index into the reader's table; "Blink on read" is an empty call over Bluetooth; failed starts and stops were thrown away; one refused setting stopped the rest of the push; the unique-tag list was never purged between sweeps; connect and disconnect could overlap; the first paired sled was always used; battery was never asked for; DataWedge detection lacked a manifest `queries` entry.

## Goals

- The trigger switch works, live, on an RFD40: RFID, Barcode, or one trigger each.
- Sled barcodes reach every scan screen the way a DataWedge scan does, on a phone with no DataWedge.
- The app knows when the link drops, says so, and reconnects by itself.
- Every option on the RFID tab does what it says on the sled, or is removed.
- No thread leak, no discovery, no Zebra-only transports on a phone.
- A build ready for a hardware session: SDK wire logging switch, a diagnostic dump at connect, and an ordered script.
- The MC2200 (DataWedge) keeps working.

## Non-goals

USB attachment; tag locating; access operations (read, write, lock, kill); pre-filters; Wi-Fi provisioning; firmware update; scanner symbology settings; sled factory reset; RFID Enroll reading its tag with the sled; iOS; merging.

## Rulings (decisions made without asking, each easy to reverse)

1. **The switch is a three-way "Trigger buttons" setting:** RFID (both triggers read tags), Barcode (both scan), Split (upper reads tags, lower scans). It applies live. It is on the RFID tab and, when a sled with a scanner is connected, on Scanning and Asset Lookup. Default RFID, as today. *If wrong:* one enum default.
2. **The display stays on while a sled is connected and Scanning or Asset Lookup is open.** One effect beside the NavHost. No background grace period. *If wrong:* delete one effect.
3. **The app reconnects by itself** after a drop or a failed connect, while the reader is enabled and the app is in front: 2, 4, 8, 15, 30, 30, 30, 30 seconds, then it stops and says so. Bluetooth coming back on, or the sled's link appearing, tries at once. A manual Disconnect stops it. *If wrong:* a constant.
4. **Region:** a hopping-configurable region is written with hopping on and every supported channel, taken from the sled. The one-tap chooser stays as designed (no confirmation).
5. **RFID Enroll still does not read tags with the sled.** It gains one safety rule: a tag equal to the selected asset's own ID or serial is refused (a barcode delivered twice would otherwise be saved as the tag).
6. **A sled barcode with no scan screen open is dropped,** like a DataWedge scan today.
7. **The sled's scanner session is opened only when the layout uses the scanner** (Barcode or Split) and the sled is not known to lack one. In RFID layout nothing extra is opened, so an MC2200 with the default setting is unchanged apart from item 8.
8. **The "Scanner plugin on connect" setting is removed** (it only messaged DataWedge and could switch the MC2200's own scanner off). On DataWedge hosts the app sends one `ENABLE_PLUGIN` at start to repair a scanner an earlier build may have left off.
9. **"Blink on read" is removed** (empty call on a Bluetooth sled).
10. **While the scanner session is ready, keystrokes from the sled's own keyboard device are swallowed,** so one scan is delivered once. If the session is not ready the sled's keystrokes type into the scan box as today.
11. **Location stays in the sled's permission list for now.** The review says the sled path does not need it, but Zebra's samples request it and the label printer needs it anyway. Revisit after hardware.
12. **Charging is not shown.** The SDK parses the flag in a way that only works if the sled sends the word "true"; the raw event is logged for the hardware session.
13. **Link profile, Tari and pre-filters are left as the sled has them** and logged. Inventory state A and SL flag ALL are pinned (Zebra's sample does the same).
14. **`ExportedReceiverContext` stays** as a guard for `Readers` only, with its doc corrected (this `.aar` passes the flag itself).
15. **The trigger-type filter is a deny-list:** only a SCAN-type trigger event is ignored; RFID, DUAL and unknown pass, until a sled has been logged.

## Target model

### Settings (`core/rfid/RfidSettings.kt`)

- Remove `triggerPersonality`, `scannerPluginMode`, `ledOnRead`. Add `triggerLayout: SledTriggerLayout = RFID` and `readerAddress: String? = null`.
- JSON: write `triggerLayout` and `readerAddress`. When `triggerLayout` is absent, read the old `triggerPersonality` (`rfid` or `barcode`). Unknown keys are ignored, so old documents still parse.
- Not part of the radio push: `enabled`, `region`, `triggerLayout`, `readerAddress`. Restore defaults keeps `enabled`, `region` and `readerAddress`.

### Connection state (`core/rfid/RfidConnection.kt`)

`Disabled`, `Disconnected`, `Connecting`, `Connected(name, batteryPct)`, new `NeedsRegion(name)` (link up, no region: only the region can be set), `Failed(reason, retryable = false)`.

### Reader interface (`input/rfid/RfidReader.kt`)

New members have default bodies so hand-written test doubles keep compiling.

- `connect(request: SledConnectRequest)` where `SledConnectRequest(address: String?, layout: SledTriggerLayout)`.
- `barcodes: Flow<SledBarcode>`; `info: StateFlow<SledInfo?>` (name, address, model, serial, firmware, has-scanner tri-state, power range in dBm, trigger read-back); `scanner: StateFlow<SledScannerState>` (`Off`, `Opening`, `Ready`, `Unavailable(reason)`); `unsolicitedStops: Flow<String>`.
- `setTriggerLayout(layout): Result<SledTriggerReadback>`; `requestBattery()`; `softScan(pull: Boolean)`; `pairedSleds(): List<SledCandidate>`.

### Adapter rules (`ZebraRfidReader.kt`, `ZebraBarcodeEngine.kt`)

- **Pre-check before any vendor object:** Bluetooth on, permission held, a bonded device named `RFD40…`, `RFD90…` or `RFD8500…`. Then `Readers(context, ENUM_TRANSPORT.BLUETOOTH)`. Pick the entry whose address equals the request's; none saved and one paired: use it; several and none saved: fail with a sentence that says to choose.
- **One vendor gate.** Every blocking vendor block (apply, start, stop, regions, set region, trigger layout, battery request, purge) runs under one adapter `Mutex`. The SDK's own lock is a try-lock that fails a second caller at once.
- **Per-connection generation.** The disconnect handler makes no vendor call; it records the loss for its generation and moves the state to `Failed(reason, retryable = true)`.
- **Connect sequence** (must = a failure fails the connect; best = guarded, logged, never fails it):

  | Step | Kind |
  |---|---|
  | `connect()` | must (special cases below) |
  | add listener, `setReaderDisconnectEvent(true)` | must |
  | `setHandheldEvent(true)`, check `isEventRegistered`, retry once | must |
  | `setTagReadEvent(true)`, `setAttachTagDataWithReadEvent` as today | must |
  | inventory start and stop events, battery, power, temperature | best |
  | batch-mode prevention (as today) | best |
  | start and stop triggers IMMEDIATE (built with the public constructors) | best |
  | identity: model, serial, firmware, scanner name, capability, power table | best |
  | diagnostic dump: raw key layout, Bluetooth host mode, scan batch mode | best |
  | trigger layout write and read-back | best |
  | battery request | best |
  | scanner session, only if the layout needs it, after `connect()` has returned | best, off the connect path |

- **Special connect results.** `RFID_BATCHMODE_IN_PROGRESS`: `Inventory.stop()`, short pause, `purgeTags()`, `setBatchMode(DISABLE)`, `saveConfig()`, close, and fail as retryable with a note; the controller's retry connects again. `RFID_READER_REGION_NOT_CONFIGURED` (from connect or from setup, or a region that reads `NA`): keep the link, wire the listener and the disconnect event, publish `NeedsRegion`; only `regions()` and `setRegion()` work; after a region is set, disconnect and connect again.
- **Teardown.** Scanner session terminate is queued and not waited for. Stop inventory and the batch-mode safety step run only when the link is known to be up. Then remove the listener, `disconnect()`, `Readers.Dispose()`. Cleanup after a failed connect is not cancellable.
- **Trigger layout.** `setKeylayoutType(upper, lower)`: RFID = (RFID, RFID), Barcode = (SLED_SCAN, SLED_SCAN), Split = (RFID, SLED_SCAN). Read back with `getKeylayoutType()` and decode; the note shows the read-back, not the request. If a write is refused, try the legacy raw value through `Config.setAttribute` (RFID `0`, Split `2`) and report. Never `saveConfig()` for it. A sled known to have no scanner always gets RFID. `setTriggerMode(mode, false)` is called only for a model name containing `RFD8500`.
- **Trigger events.** Every event's value and type is logged. A SCAN-type event is dropped.
- **Inventory.** Purge before `perform()` when unique reporting is on. A command timeout from `perform()` counts as started (the start status may ride on the first tag; hardware); a status the sled sent counts as a refusal. After `stop()`, wait briefly for the stop event, then for the tags already sent. A stop the app did not ask for is reported on `unsolicitedStops`.
- **Settings push.** Each setting is a labeled step; a refusal is logged and the push continues; link trouble stops it; the error names what was refused. Transmit power is an index found from the reader's table (unit decided from the table's maximum: about 30 is dBm, about 300 is tenths); with no table, today's value. Inventory state A and SL flag ALL ride on the session step.
- **Region.** `Config.getRegionInfo` is read for the active and the picked region only. When the sled says hopping is configurable, hopping and the supported channels are supplied. If the write throws, the region is read back before reporting failure.
- **Scanner engine.** One `SDKHandler(appContext, false)` for the life of the process, one worker thread that is never interrupted, delegate and subscription set once. Per use: `dcssdkSetOperationalMode(DCSSDK_OPMODE_BT_NORMAL)`, list only to find the sled's id (cached), `dcssdkEstablishCommunicationSession(id)` (`SUCCESS` or `SCANNER_ALREADY_ACTIVE` = up). When no longer needed: `dcssdkTerminateCommunicationSession(id)`, then `DCSSDK_OPMODE_DISABLED`. No `SCAN_DISABLE` or `SCAN_ENABLE` opcodes, no `dcssdkClose()` between uses, no automatic re-establishment, no `dcssdkEnableAvailableScannersDetection`. Every delegate body catches everything. Barcode bytes: strict UTF-8, else ISO-8859-1; a type label from a small table; a barcode in the first 250 ms of a session is dropped (stale queue). Soft trigger: `DCSSDK_DEVICE_PULL_TRIGGER` and `DCSSDK_DEVICE_RELEASE_TRIGGER` with the four-argument call and an empty XML string. A watchdog marks the scanner `Unavailable` when a vendor call does not return.

### Never call (a source-scan test enforces it)

`Config.getCradleStatus` (can crash the app), `Config.setBluetoothMode` (a stub that always throws), `com.zebra.barcode.sdk.*` (mislabels types and can throw on the SDK's thread), `SDKHandler(Context)` (one argument), `dcssdkEnableAutomaticSessionReestablishment`, `dcssdkEnableAvailableScannersDetection`, `ENUM_TRANSPORT.ALL`, `Readers.connect(`, `RFIDReader.reconnect(`, `setTriggerMode(` with `true`; `saveConfig(` only in the batch-mode functions.

### Controller (`RfidController.kt`)

- **Lock order:** `linkGate` (connect and disconnect), then `mutex`, then `applyGate` or `stopGate`; the adapter's gate is innermost. Nothing is called on the reader under `mutex` except as today.
- Connect and disconnect are serialized by `linkGate`. A connect that finds the reader connected returns success.
- Turning the reader on connects; turning it off disconnects. The first collected value is not a change.
- A trigger starts a read only while `Connected` and only when the layout is not Barcode.
- **No vendor call while a sweep is open, except stop.** A settings push, a layout change, a battery request and a region load wait for the sweep to end (a layout change ends it first, queuing its tags).
- Layout change while connected: end any sweep, then `setTriggerLayout` under `applyGate`; the failure is shown.
- Start failure: close the sweep and show the reason (`readError`). Stop failure: retry once, remember "may still be reading" and stop before the next start. Both calls have a timeout.
- Battery: asked after connect, after each sweep, and once a minute while connected and idle.
- Reconnect per ruling 3; `reconnecting` is exposed for the UI; one toast per loss, not per retry.
- `NeedsRegion`: no push, no sweeps; `loadRegions` and `setRegion` allowed; after a region is set while `Connected`, the settings are pushed again.
- The latch window is measured from when the event was received.

### App wiring

- `ScanSource.SLED`; `AppContainer` collects `rfidReader.barcodes` into `ScanBus`.
- A receiver for Bluetooth turning on and for the saved sled's link appearing nudges the reconnect (registered while in front).
- `MainActivity`: `android:configChanges` so a keyboard appearing, a rotation or a theme change does not restart it; `enableEdgeToEdge()` again on change; swallow the sled keyboard's keys while the scanner session is ready.
- Manifest: `<queries>` for `com.symbol.datawedge`; remove the vendor's `READ_EXTERNAL_STORAGE`.
- `DataWedge.enableScannerInput` once at start on DataWedge hosts.
- Developer tab: "Zebra SDK logging" switch (`RFIDReader.LOGGER.EnableDebugLogs`), off by default, not saved.

### Screens

- **RFID tab:** connection line, battery, reader details (model, serial, firmware); "Reconnecting…"; Connect disabled while connecting and gated on permission; clear sentences and a fixing button for Bluetooth off and for no sled paired; a Reader chooser when more than one sled is paired; Trigger buttons (three-way, live) with the sled's read-back under it, or "This sled has no barcode scanner."; a scanner line when the layout uses it; the power slider capped at the reader's maximum; the note only while connected; the "Scanner plugin" and "Blink on read" rows gone.
- **Scanning and Asset Lookup:** when the reader is enabled and not connected, one line saying so with a Connect button; the Trigger buttons control when a sled with a scanner is connected; a Scan button that fires the sled's scanner when its session is ready and the phone has no DataWedge; a line when a read could not start.
- **Admin:** regions load in `NeedsRegion`; a failed load says why and offers Retry; the hopping switch follows the sled.
- Everything fits 320 dp.

## Options: what each SDK option gets

| Option (matrix row) | Decision |
|---|---|
| Reader choice (A1) | Now: chooser by saved address |
| Reader appeared / disappeared (A2) | Not used: the SDK clears its handlers on every dispose; the app's own receiver nudges the reconnect |
| Connection password (A4) | Not now; a sentence if the sled asks for one |
| No region at connect (A5), batch mode at connect (A6) | Now |
| Disconnect event (A7), reconnect (A8) | Now (fresh connect, not `reconnect()`) |
| Command serialization (A10), SDK logging (A11) | Now |
| Transmit power (B1) | Now: index from the reader's table, slider capped |
| Link profile, Tari (B2, B3) | Left as the sled has them; logged |
| Session, tag population (B4, B5) | Kept |
| Inventory state, SL flag (B6, B7) | Pinned to A and ALL, no control |
| Unique reporting, purge (B9, B10) | Now: purge before each sweep |
| RSSI and tag fields (B11), tag locating (B18) | Not now |
| Inventory start and stop events (B14) | Now |
| LED blink (C2) | Removed |
| Feedback cue (C3), scanner beep and vibration (C4) | Not now |
| Trigger type (D2), key layout (D3) | Now |
| Trigger mode (D4) | RFD8500 only; plugin flag (D5) removed |
| Trigger status query (D8) | Not used until a lone release is seen on hardware |
| Has a scanner (E1), scanner session (E3), barcode data (E4), soft trigger (E6) | Now |
| Aim (E7), scanner settings (E8) | Not now |
| Session auto re-establish (E9) | Never (the app owns reconnect) |
| Bluetooth host mode (E10), scan batch mode (F4) | Read and logged only; the setter does not work in this SDK |
| Batch mode event (F2) | Not needed for recovery |
| Battery level (G1) | Now; charging not shown (ruling 12); statistics (G2) not now |
| Power and temperature events (G3) | Now, as a note |
| Idle power-off (G4), cradle (G5: never call), friendly name (I3), factory reset (J2), reader reset (J3) | Not now |
| Supported regions, set region (H1, H3) | Now |
| Model, serial, firmware (I1, I2) | Now |
| Save configuration (J1) | Only for batch mode, as today |

## Things that must ship together

- The trigger-type filter with the key-layout write.
- The `queries` entry with removal of the scanner-plugin flag.
- Keep-display-on with the disconnect event.
- `ENUM_TRANSPORT.BLUETOOTH` with the app-side pre-check.
- Dropping `SCAN_DISABLE` with the key layout.

## Testing

Unit and Robolectric tests with the fake reader for every controller rule above; pure-helper tests (key-layout encode and decode, power index over both units, backoff, barcode decode, type labels, link-loss classifier, trigger filter); a vendor pin test by reflection on the bundled `.aar` (the methods and enum values this design relies on); the never-call source scan; Enroll's own-ID rule; a scan with no collector; 320 dp checks for the new rows. The full suite and `assembleDebug` must pass. No test contacts a sled.

## Hardware script (run with Jimmy; one line each, pass or fail)

Log filter: `adb logcat -s ZebraRfidReader ZebraBarcodeEngine RfidController IRFIDinfo IRFIDError 123RFID API3Wrapper ScannerSDK-SDKHandler BluetoothManager BluetoothScanner`. Launch with `am start`, never `monkey`.

1. Developer tab: turn on Zebra SDK logging. Connect. Read the dump: model, firmware, serial, scanner name, capability, raw key layout as found, Bluetooth host mode, scan batch mode, power table first, last and size, battery event text.
2. RFID layout: pull each trigger. Expect a sweep and no scanner beam. Note the trigger type logged for each.
3. Sweep with no tag near: does the read start without an error? (timeout on `perform()`)
4. Sweep the same tags twice with "Report each tag once" on: are they reported both times?
5. Barcode layout: expect the scanner line to say ready, the beam on a pull, and the barcode on the Scanning screen once (not twice). Try a Code 128, a QR and a long QR (300+ characters).
6. If the scanner line says not available: does the sled type into the scan box instead? Record the reason shown.
7. Split layout: sweep with the upper trigger, scan with the lower; note which physical trigger is which.
8. Switch layouts several times from the Scanning screen, including during a sweep.
9. Scan button on the Scanning screen: beam and a barcode.
10. Switch the sled off while connected: the app should say so within a few seconds and show "Reconnecting…". Switch it on: it should reconnect by itself.
11. Turn Bluetooth off and on: same.
12. Let the phone sit on the Scanning screen: the display should stay on. Press the power key, wait, wake: it should reconnect.
13. Background and foreground the app ten times; `adb shell ps -T -p <pid> | wc -l` before and after should be about the same.
14. Each RFID tab control at each extreme with SDK logging on: beeper Off and High, power lowest and highest, tag population 1 and 1000, session S0 to S3, dynamic power on and off. One status line per command.
15. Admin tab: region list, and the hopping switch if the sled offers it.
16. MC2200: the handheld's own scan key still scans with the sled connected; Scanning, RFID Enroll, Print Labels and Asset Lookup still work.
17. Two sleds paired: the chooser appears and the saved one is used.
