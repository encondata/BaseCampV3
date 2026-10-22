# iPad Bluetooth printing to Zebra printers — design

Date: 2026-10-22. Status: approved by Jimmy 2026-10-22; built on branch `ios-ble-printing`. The Implementation notes at the end record where the build changed this text and what is still open.
Scope: the iOS kiosk app (`IOS_Kiosk_App/`). Related: `docs/superpowers/specs/2026-10-21-android-label-printing-design.md` (the label printing design, with its "iOS implementation notes" section), and the throwaway test branch `ble-spike` (never merged; kept as a reference until this ships).

## 1. Why

Our crews work in data centers. The iPad and the Zebra printer often aren't on the same network, and we don't always deploy our own Wi-Fi, so today's network printing (TCP 9100) can't reach the printer. The ZD421 has a Bluetooth Low Energy (BLE) radio. Zebra markets it as "for setup", but its documented "Zebra Bluetooth LE Parser Service" accepts ZPL and returns replies. With Bluetooth, the iPad prints straight to the printer next to it, with no network.

The Zebra SDK is ruled out (Jimmy): it brings App Store approval problems (MFi / ExternalAccessory), and its iOS version only speaks Bluetooth Classic, which a BLE-only ZD421 doesn't have. Apple's CoreBluetooth is enough.

## 2. What the test proved (2026-10-22, Jimmy's iPad Pro 13, iPadOS 27.2, office ZD421-300dpi, Link-OS 7.3)

| Check | Result |
|---|---|
| Finding the printer | Found by scan with no FEED hold, although `bluetooth.discoverable` is off. It advertises only its name, which is its serial (`D8J224508535`), with no service UUIDs. |
| Pairing | No pairing prompt; the printer reports no connection security (`bluetooth.connected_security_mode` "nc", security mode 1). |
| Tap to ready | 1.15 s (connect 0.61 s, discovery, Device Information reads, indications on). |
| Device Information (180A) | Manufacturer "Zebra Technologies", model "ZD421", serial, firmware "V93.21.38Z", Link-OS "7.3". |
| Write size | 244 bytes per chunk (ATT MTU 247); long writes up to 512. The printer does **not** offer write-without-response. |
| Replies | `~HI`, `~HS`, `~HQES`, `^HW` file listing and every `getvar` came back whole and parsed by the existing parsers, 3–33 ms after the write finished. |
| Speed | 50 KB labels: 12.7 s each, 3.9 KB/s, steady over 3 runs; every label printed its END marker (no lost bytes). A 1–2 KB asset label sends in well under a second. |

The raw logs are in Jimmy's Downloads (`text-C10B61E13359-1.txt`, `text-5D357FED3DE8-1.txt`).

## 3. Goals, non-goals, anti-goals

**Goals**
- **Bluetooth is a real printer choice in Printer Setup**, next to Scan network and Enter IP. It lists nearby Zebras, connects to the one picked, and saves it.
- **Everything a network printer gets works over Bluetooth:** the setup checks (printer answers, ready to print, DPI matches the templates, fonts installed, peeler), installing missing fonts, test labels (alignment and sample), offsets, and peel/tear.
- **Print Labels prints over Bluetooth** through the same app-wide print queue and printer lock, the same way: scan an asset, the stored label prints, one Labeled scan is recorded.
- **Settings gets a Troubleshooting tab** for the deeper tools: connection details, a Bluetooth scan with signal strength, printer details, ask-the-printer buttons, a speed test and a shareable report. The Bluetooth test card leaves Printer Setup.
- **When a printer has forgotten the iPad** (a printer set to a higher security mode, or its pairing list cleared), the app says so and walks the user through Forget This Device in iPad Settings.

**Non-goals (this round)**
- Android Bluetooth printing (later; same printer service, different code).
- Sending the printer's connection type to the portal or the kiosk settings document. The iPad keeps its printer settings on the device today, and stays that way.
- Pictures (`^GF`) generated on the iPad, ID badges, or any new label content.
- The Zebra SDK, Bluetooth Classic, MFi.
- Printing while the app is in the background (no `bluetooth-central` background mode). The app stays on screen while a crew is working.
- More than one saved printer at a time.

**Anti-goals (would make this a failure even if it works)**
- **No status checks, polls or waits on the print path** (Jimmy's standing rule): a scanned label goes straight to the printer. Bluetooth adds only what a send needs (a link that is up). The one extra command is the clear step after a failed send, which Jimmy approved (decision 16).
- **Never change a printer setting from the app** without Jimmy asking for it (no `setvar`, no `^JUS`, no `discoverable` changes). The app works with the printer as it is set.
- **Network printing must not get slower or change behavior,** apart from the clear step after a failed send. It keeps its one-connection-per-command TCP path and its timeouts.

## 4. Decisions

### Jimmy's
- Bluetooth Low Energy through CoreBluetooth; no Zebra SDK.
- After a failed send, the next send first tells the printer to drop the half label it may be holding (decision 16). Normal labels never get this step.
- One iPad per printer: a site usually has one iPad printing, and when there are several, each has its own printer. So an iPad keeps its printer connected while the app is in use and never needs to share it (decision 4).
- Bluetooth sits beside the network options in Printer Setup and does everything network printing does.
- The debugging and testing tools move to a Troubleshooting tab in Settings.

### My calls (check these)
1. **One transport seam, mirrored from the web kiosk.** Network and Bluetooth printers both implement one small interface (send text, send a font with progress, query with a completion rule). Identify, status, peeler, fonts and test labels are built once on top of it, so both transports send identical bytes (the pattern in `kiosk/src/lib/stationPrinter.ts`). The existing `SetupZebra`, `LockedZebra`, `PrinterLock`, `PrintQueue`, completion predicates and parsers stay; only the "how bytes get there" part is new.
2. **The saved printer records its connection.** `SavedPrinter` gains a connection: network (host, as today) or Bluetooth (the printer's serial plus the iPad's identifier for it). Printers saved before this change read back as network printers.
3. **A Bluetooth printer is found again by serial.** iOS gives each iPad its own identifier for a printer and never exposes the real address. The app reconnects by the saved identifier first and, if iOS no longer knows it, scans for the name equal to the saved serial. After connecting it confirms the serial from the printer's Device Information before using it.
4. **The link stays open while the app is in use.** Connecting costs about 1.2 s, too much per label. The app connects when a Bluetooth printer is first needed and keeps the link up. Opening Print Labels or Printer Setup with a saved Bluetooth printer starts the link in the background (nothing waits for it and nothing is checked), and the first job connects if no screen did. If the printer drops an idle link, the next job reconnects first (one ~1.2 s pause, no user action). The link closes when the app goes to the background, on sign-out, and when the saved printer changes. After the printer drops a link, the app does not reconnect until something needs the printer (a job, Printer Setup, Troubleshooting), so it never grabs the printer back the moment the printer lets go. If the link drops during a send, that send fails at once and is not retried inside the same send (Ruling 9): the printer is marked for the clear step (decision 16), and the next send or Retry reconnects and clears first.
5. **Writes:** MTU-sized chunks (`maximumWriteValueLength(.withoutResponse)`, 244 bytes on the test iPad), each with response, the next only after the printer acknowledges the last. This is what printed 150 KB without losing a byte. Write-without-response is not used (the ZD421 doesn't offer it).
6. **Replies:** indications on "From Printer Data" are turned on before anything is sent. Before each query, stray bytes still arriving from an earlier command are drained (0.3 s of quiet, at most 1 s). A reply is complete by the same rules network replies use (ETX frames, quoted value), with quiet-time and total-time limits.
7. **Timeouts for Bluetooth:** connect and get ready 10 s, counted from the connect (when iOS no longer knows the saved identifier and the app has to scan for the serial, that search has its own 10 s, and a printer heard late in it gets a fresh 10 s for the connect itself); a query 5 s total; a send gets 15 s plus 1 s per 2 KB (allowing for half the measured speed), so a 170 KB font has about 100 s. Network timeouts don't change.
8. **Font installs over Bluetooth are allowed** with a progress bar and a time estimate (about 45 s for a 170 KB font; about 4½ minutes for a 1 MB one).
   - A font download (`~DY`) announces its size up front, and the printer treats everything after it as font data until that many bytes arrive. So the app never cuts a font on purpose: **Cancel finishes the font being sent and stops before the next one.**
   - If a font send is cut anyway (the link drops, the app goes to the background, a timeout), the app stops all traffic to that printer and says: "The font install was cut off. Turn the printer off and on, then tap Check again." Until a check succeeds, Print Labels shows the same message instead of sending.
   - **The stop survives a relaunch.** It is saved on the iPad by printer (the network host or the Bluetooth serial), because a printer cut mid-font is still waiting for font bytes after the app is restarted, and would swallow every label sent next. A relaunched app still shows the same message instead of sending. The first check that gets an answer to `~HI` lifts it, and the saved copy with it. Settings › Developer › Reset app leaves it in place.
   - **The font check compares sizes, not just names.** The printer's file listing shows each font's size; a font whose size doesn't match the library's is shown as damaged and offered for reinstall (sending `~DY` again overwrites it). This catches a half-written font without any extra commands to the printer. It applies to network printers too.
9. **Finding printers:** the Printer Setup scan lists devices whose name looks like a Zebra serial (12 letters and digits) or that advertise Zebra's service, strongest signal first, refreshing as it scans, with the FEED hint from the test. A 30 s scan, stoppable; the 30 s starts once Bluetooth is ready, so answering iOS's first-use permission prompt doesn't use it up. Picking one connects, reads Device Information (must say "Zebra Technologies"), identifies it with `~HI` (model, DPI) and saves it, then runs the checks.
10. **Recovery:** if iOS reports the printer removed its pairing (CBError 14) or pairing timed out (CBError 15), the app stops retrying and shows the steps: "The printer forgot this iPad. In the iPad's Settings app, open Bluetooth, tap ⓘ next to <serial>, choose Forget This Device, then come back and tap Connect." The card offers Connect and no Open Settings button: iOS can't open Settings › Bluetooth from an app, and a button that lands on the app's own settings page would mislead (Ruling 15). Reconnects after a link that connected and dropped before it was ready are capped (3 reconnects after the first attempt, 3 s apart); a connect that never connects fails at the 10 s limit with no retries, so a refused pairing can't loop (Ruling 8).
11. **Bluetooth off or not allowed:** Printer Setup and Print Labels say so plainly ("Turn on Bluetooth to reach the printer." / "Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer.", the second with an Open Settings button), the way Local Network denial is handled today. Opening either screen with a saved Bluetooth printer starts the link, so these messages (and the pairing-lost steps of decision 10) show on opening rather than on the first failed label. The Bluetooth permission prompt appears the first time someone picks Bluetooth, not at app launch.
12. **Wording names the printer, not an IP.** Messages that say "at 10.0.0.5" become transport-neutral: "Can't reach the printer D8J224508535 over Bluetooth" / "Can't reach the printer at 10.0.0.5". The Print Labels summary reads "ZD421 · Bluetooth D8J224508535 · 300 dpi".
13. **Troubleshooting tab:** visible to everyone signed in (crews troubleshoot on site). It works on the saved printer, network or Bluetooth:
    - Connection: type, address or serial, connected / idle, MTU and write size for Bluetooth, last disconnect and why, and whether Bluetooth itself is on, off or not allowed.
    - Printer details: `~HI` model/firmware/DPI; for Bluetooth also the Device Information values.
    - Ask the printer: status, error report (`~HQES`), DPI, peeler, serial, font listing buttons, each showing the reply and how long it took.
    - Speed test: 10 / 25 / 50 KB labels that print END at the bottom, with seconds and KB/s.
    - Bluetooth scan: everything nearby with signal strength, Zebras flagged (for "why can't I find my printer?").
    - Report: Copy / Share a text report of all of the above with a log, like the test screen's, which carries the Bluetooth link's own events (connect and ready times, chunk size, drops, retries, pairing errors) merged in by time.
    - A refusal a crew fixes on the iPad (Bluetooth not allowed, a printer that forgot this iPad) shows with its Open Settings or Connect button in the section whose call met it, as on Print Labels.
    - A free-text "send a command" box only for admins and developers, because a raw command can change printer settings.
14. **The Bluetooth test card comes out of Printer Setup;** the spike's code is not merged (the branch stays as a reference).
15. **Info.plist:** `NSBluetoothAlwaysUsageDescription` = "Finds and prints to Zebra label printers over Bluetooth."
16. **The clear step after a failed send (Jimmy approved; the mechanics are my call).**
    - A send that fails part-way (link drop, out of range, app to the background, timeout) can leave the printer holding the start of a label. The next label could merge into it or vanish.
    - After any failed send, the printer is marked "needs a clear". The next thing sent to it (the next job, Retry, a test label, or Printer Setup's checks) first sends `~JX`, then the real bytes, under the same printer lock. The mark clears once `~JX` is delivered. Normal sends never carry it.
    - `~JX` is ZPL's "Cancel Current Partially Input Format": it drops only the label that was half received. Labels already received and queued still print. `~JA` (cancel all) is **not** used: in peel mode finished labels wait in the printer, already recorded as Labeled, and `~JA` would throw them away.
    - It applies to network and Bluetooth printers alike (the risk is the same; Bluetooth makes it likelier).
    - The `needsClear` mark lives in memory: a relaunch starts with none, and the Bluetooth link is closed when the app restarts anyway. Marks are kept per printer (network host or Bluetooth serial), so saving a different printer drops none (A to B to A keeps A's mark).
    - A cut **font** download is different (it announces a byte count): decision 8's restart-the-printer path covers it, and that stop is the one that is saved across a relaunch.
    - Proving it on the ZD421 is part of the build: a developer-only "Cut-send test" in Troubleshooting sends half a label, marks the failure, then sends a full label. Only the full label may print, with no merged or extra label.

## 5. What stays the same
- Labels are still generated ahead of time on the iPad; Bluetooth changes only how the bytes reach the printer.
- One job at a time, in scan order; Retry resends the exact same bytes; Reprint never records a scan.
- The app-wide printer lock serializes Print Labels and Printer Setup for both transports.
- No checks or polls before or after a label.

## 6. Constraints
- iOS 18 minimum, Swift 5, no third-party packages, Swift Testing.
- `IK/Core/` stays Foundation-only (`CorePurityTests`); CoreBluetooth code lives in `IK/Data/Printer/`.
- Unique file basenames across the target (synchronized folders).
- CoreBluetooth gets a thin protocol seam so the Bluetooth transport is tested with fakes: chunking and acknowledgements, reply assembly across indications, the drain before a query, timeouts, reconnect caps, CBError 14/15, Bluetooth off/denied, finding by identifier then by serial, serial confirmation.
- Saved printers from before this change must load unchanged (a test with today's JSON).
- Device install: the existing `xcodebuild` + `xcrun devicectl` recipe; verify on Jimmy's iPad Pro 13 with the office ZD421.

## 7. Left to the builder
- Type and file names, how the transport interface is shaped in Swift, and where the Bluetooth manager lives in `AppContainer`.
- Exact layout of the Bluetooth list and the Troubleshooting tab, using the app's existing cards, segmented controls and type styles.
- Retry spacing and scan durations within the bounds above.

## 8. Hardware checks still owed (after the build)
- How long the printer keeps an idle link (`bluetooth.disconnect_idle_link yes`), and how fast the iPad reconnects after the printer is power-cycled.
- A second iPad near a printer that is already connected to another iPad (expected: it can't connect; the message should say the printer may be in use by another device).
- A printer at security mode 2 or 3: the pairing prompt and the Forget This Device recovery.
- Range down an aisle in a data center.
- Whether a Bluetooth disconnect resets the printer's command parser mid-label or mid-font (if it does, a cut send needs no restart).
- Whether a connected ZD421 keeps advertising (Printer Setup now holds the link while it is open, so the saved printer may drop out of its own scan list).
- Whether the size `^HW` lists for a font equals the byte count its `~DY` announced (the damaged-font check relies on it).
- `~JX` on the ZD421, through the Cut-send test: only the full label prints.
- The first Bluetooth scan on an iPad that has never been asked for permission (the 30 s clock must start after the prompt is answered).

## Implementation notes (2026-10-22)

### Branch and commits
Branch `ios-ble-printing`, cut from main `ba97976f`. The numbered rulings below are the controller's calls during the build, as recorded in its ledger; decisions above that cite "Ruling N" mean these.

| Commit | What |
|---|---|
| `bbf25eac`, `848f817a` | This design and the six-task implementation plan |
| `4504cb84` | Task 1: saved printers know their connection (network or Bluetooth); Bluetooth limits and copy; font sizes from the listing |
| `df9657f8`, `338c7e14` | Task 2: one transport seam for printers; `~JX` after a failed send; damaged-font check; review fixes (clear before checks, marks keyed to the printer) |
| `dafc0755`, `20cdb891` | Task 3: the Bluetooth LE link and transport; review fixes (no retry for a failed first connect, send budget, close barrier) |
| `85a4b748`, `11a6cb4f` | Task 4: Bluetooth printers in Printer Setup and Print Labels; review fixes (Print Labels connects on open, no stranded link, clearer copy) |
| `0ab5c9fb` | Task 5: Settings › Troubleshooting for printers |
| `5c3eec9c` | Final fix wave: a cut font install's stop outlives a relaunch; saving another printer keeps the guard's marks |
| `a2f98851` | Final fix wave: pairing-lost steps name Settings › Bluetooth and offer Connect only |
| `8207dae1` | Final fix wave: the scan clock starts once Bluetooth is ready; Printer Setup links on open; a late sighting gets the full connect time |
| `76a78abc` | Final fix wave: Troubleshooting shows refusals with their buttons, logs the Bluetooth link, and proves every byte |

This documentation commit (`docs(ios): Bluetooth printing notes and README`) follows them. At `76a78abc` the unit tests pass (886, iPad Air 11-inch (M3), iOS 18.5), and the iPhone 16 and generic device builds succeed. `NetworkZebra`, `ZebraNetwork` and the `~JX` rule were not changed by the final wave, so network printing sends the same bytes as before apart from the clear step.

### Where it lives
All under `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`.
- `Core/Printer/ZebraBluetoothSpec.swift`: GATT UUIDs, the limits, and the copy (`pairingLostText`, `BLUETOOTH_OFF_TEXT`, `BLUETOOTH_DENIED_TEXT`, `FONT_INSTALL_CUT_TEXT`). `Core/Printer/PrinterTestLabels.swift`: the speed-test and sample labels. `Core/Labels/LabelSettings.swift`: `SavedPrinter`, `PrinterConnection`, `PrinterIdentity`.
- `Data/Printer/ZebraTransport.swift`: the one seam. `NetworkZebra.swift` and `BluetoothZebra.swift` implement it. `ZebraBluetooth.swift` is the link, the scan and the event log; `BluetoothCentralClient.swift` is the thin CoreBluetooth seam the tests fake. `PrinterGuard.swift` holds the `~JX` and font-cut marks; the saved stops are `PrinterStopsStore` in `Data/Prefs/KioskPrefs.swift` (key `ss.kiosk.printerStops`).
- `UI/Screens/Labels/PrinterSetup*.swift`, `PrintLabels*.swift`, `TestLabelSheet.swift`; `UI/Screens/Settings/Troubleshooting*.swift`.
- `Info.plist`: `NSBluetoothAlwaysUsageDescription` (checked by `BuildConfigTests`).

### Rulings made during the build
Each with what it costs if wrong.
1. The guard reset and the Bluetooth close on a saved-printer change are wired by the container observing the settings store, not inside `LabelSettingsStore.setPrinter`. Cost: none (same behavior). Ruling 16 later removed the guard reset and kept the close.
2. Process: one reviewer per task (spec and quality together); findings marked Critical or Important are checked by two reviewers before a fix. Cost: a few extra reviewer runs per task.
3. Process: the device install happens after Task 4 so Jimmy can test early, and Troubleshooting follows. Cost: none.
4. Decision 16 is binding for checks: while a printer needs a clear, the first query of a Printer Setup check run is preceded by `~JX`, which clears the mark. The task brief had left this out. Cost: one extra 3-byte command before a check after a failure.
5. A failed font install marks the font cut only if it had started sending (its header or bytes went out). A refused connection with nothing sent does not tell the crew to power-cycle a printer that never got a byte. Cost: a cut that fails before the first progress report counts as not cut; the next send's `~JX` still applies.
6. The Task 2 fix round also took three small items tied to Rulings 4 and 5: the probe of a printer being chosen can't lift the saved printer's stop, marks are keyed to the connection, and a failed clear reads as the printer being unreachable. Cost: a larger fix diff.
7. Guard marks (and the container's observer) are keyed to printer identity, the network host or the Bluetooth serial, not to the iPad's identifier for it. Cost if wrong: a pending clear dropped after re-saving the same printer.
8. D10's "3 tries" means 3 reconnects after the first attempt, and only for a link that connected and dropped before it was ready. A connect that never connects fails at the 10 s limit with no retries. Cost: a job waits up to about 49 s on a pairing-refusal loop instead of about 36 s.
9. During a job, a drop fails the write or query at once; it is not retried inside the same send, which is what the first draft of D4 said. A resent label after a cut needs `~JX` first, which the guard does on the next send or Retry. Cost: a crew taps Retry instead of the app resending by itself.
10. The three Task 3 minors (send budget disarm, queued calls after a close, the network branch of `transport(for:)`) went into its fix round, because two are timeout and close rules the design requires. Cost: a larger fix diff.
11. Opening Print Labels with a saved Bluetooth printer starts the link in the background (D4), never blocking and never a per-label check, so Bluetooth off, not allowed, or a forgotten pairing show on the screen at once. Cost: a Bluetooth connect each time Print Labels opens (about 1.2 s, off the print path).
12. The Task 4 fix round took the minors that would trip the device test: a link stranded after an abandoned or failed choice, pairing-lost copy pointing at a missing Connect button, "No Zebra printers found" after an interrupted scan, a refusal for a printer with no serial, one transport factory, and the multi-font progress label and estimate. Cost: a larger fix diff.
13. Network font installs also get the progress row and Cancel; the bytes sent are unchanged. Cost: a visible change on network installs.
14. The final fix wave also took the new minors a crew or a first-time user would hit: raw clear-failure text in Troubleshooting, the connect clock after a late serial sighting, the Open Settings button for a forgotten pairing, Printer Setup not starting the link on open, a divide-by-zero in the speed label, scan-cut-short wording, "Idle" shown while Bluetooth is off, and the scan clock starting before the permission prompt was answered. Cost: a larger fix wave.
15. A pairing-lost card drops its Open Settings button everywhere (Print Labels, Printer Setup, the test sheet, Troubleshooting) and keeps the steps and Connect, because iOS can't open Settings › Bluetooth from an app. Open Settings stays for "Bluetooth not allowed". The copy changed to the wording in D10. Cost: one sentence of copy.
16. The container no longer resets the guard when another printer is saved (marks are keyed by identity, so a reset only lost real marks, as in A to B to A). The Bluetooth close on that change stays. Cost: a stale mark can linger for a printer no longer used, which only adds a `~JX` or a restart message for that printer.

### Calls the builders made that are worth a look
- Settings › Developer › Reset app keeps the saved font-cut stops: they describe the physical printer, and the first answered check lifts them.
- The Troubleshooting tab is not shown signed out. Signed in, everyone sees it; admins and developers get the command box, and developers get the Cut-send test.
- Caps: the Bluetooth link keeps its last 500 events; the report's log keeps the last 5,000 lines.
- A command-box command that gets no reply reads "Sent, no reply." in neutral, since a `setvar` replies nothing by design; the ask buttons keep "No reply." as an error.
- The first speed-test label after a dropped link includes the reconnect time.

### Deferred items still open
- A label sent while Print Labels' open-time connect is in flight waits for it and then makes its own attempt, up to about 20 s with the printer off. Sharing the in-flight connect needs a change in the Bluetooth link.
- A label row that hits a lost pairing mid-session has Retry but no Connect; the screen's banner reflects only the connect made on open.
- Choosing a printer: the connect has no serial fallback when the serial is unknown, and a printer whose Bluetooth name was changed can't be found again by name. The final review's other leftover minors are in its workflow, `wf_837ee150-3d6`.
- The command box uses the query rules: a failed command write marks no clear, and it isn't refused while a font is cut.
- A silent reconnect inside the retry sequence fails the whole attempt at the 10 s limit instead of counting as one try (bounded).
- A send budget that expires right after the last acknowledgement leaves `lastDrop` reading "ran past its time limit" although the write succeeded (cosmetic).
- The rule for offering Open Settings is written in two places (Printer Setup and the shared `printerReachProblem(for:)`), and `bluetoothRefusal` is recomputed.
- On iPad, the speed-test confirmation popover is anchored to the whole panel, not the Print button.
- The report's file name and timestamps use the user's calendar; they should use Gregorian and POSIX, with the generated line in local time and its offset.
- `networkPrinterRoundTrips` doesn't pin the top-level legacy `host` (the nested `connection.host` also matches); it should decode with an old-shaped struct.
- `aClearAfterAFailedSendIsExactlyJXOnItsOwnConnection` compares a set, so the order of its commands isn't checked.
- Build warning noise in the test and device builds that predates this work (`FakeKioskApi.swift` NSLock, an `OutboxTests` macro, `ScanBus.swift`).
- Backlog from section 3's non-goals: Android Bluetooth printing, sending the connection type to the portal, and more than one saved printer.

### Device pass
Device pass 2026-10-22: Jimmy confirmed Bluetooth printing works on the iPad Pro 13 with the office ZD421 (production build from main cb43b577). The hardware questions listed above (advertising while connected, security modes 2 and 3, idle-drop time, power-cycle reconnect, the Cut-send test) are still open.

- [ ] Choose the printer over Bluetooth in Printer Setup; the checks go green.
- [ ] Both test labels print (alignment and sample).
- [ ] Scan 10 asset labels in Print Labels; all print, each recorded once as Labeled.
- [ ] Ask the printer for the font listing in Troubleshooting.
- [ ] Run a speed test; every label prints END, and the KB/s is near the 3.9 KB/s measured on 2026-10-22.
- [ ] Run the Cut-send test (developer); only the full label prints, with no merged or extra label.
- [ ] Leave the app idle, then print again (the link reconnects by itself).
- [ ] Power-cycle the printer, then print again.
- [ ] Put the app in the background, come back, and print again.
- [ ] The section 8 hardware checks that this pass can answer (a connected ZD421 still advertising, `^HW` sizes, `~JX`, the first-use scan clock).
