# iPad Bluetooth printing to Zebra printers — design

Date: 2026-10-22. Status: draft for Jimmy's review.
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
4. **The link stays open while the app is in use.** Connecting costs about 1.2 s, too much per label. The app connects when a Bluetooth printer is first needed (opening Print Labels or Printer Setup, or the first job) and keeps the link up. If the printer drops an idle link, the next job reconnects first (one ~1.2 s pause, no user action). The link closes when the app goes to the background, on sign-out, and when the saved printer changes. After the printer drops a link, the app does not reconnect until something needs the printer (a job, Printer Setup, Troubleshooting), so it never grabs the printer back the moment the printer lets go. During a job, a drop is retried within the send's time limit.
5. **Writes:** MTU-sized chunks (`maximumWriteValueLength(.withoutResponse)`, 244 bytes on the test iPad), each with response, the next only after the printer acknowledges the last. This is what printed 150 KB without losing a byte. Write-without-response is not used (the ZD421 doesn't offer it).
6. **Replies:** indications on "From Printer Data" are turned on before anything is sent. Before each query, stray bytes still arriving from an earlier command are drained (0.3 s of quiet, at most 1 s). A reply is complete by the same rules network replies use (ETX frames, quoted value), with quiet-time and total-time limits.
7. **Timeouts for Bluetooth:** connect and get ready 10 s; a query 5 s total; a send gets 15 s plus 1 s per 2 KB (allowing for half the measured speed), so a 170 KB font has about 100 s. Network timeouts don't change.
8. **Font installs over Bluetooth are allowed** with a progress bar and a time estimate (about 45 s for a 170 KB font; about 4½ minutes for a 1 MB one).
   - A font download (`~DY`) announces its size up front, and the printer treats everything after it as font data until that many bytes arrive. So the app never cuts a font on purpose: **Cancel finishes the font being sent and stops before the next one.**
   - If a font send is cut anyway (the link drops, the app goes to the background, a timeout), the app stops all traffic to that printer and says: "The font install was cut off. Turn the printer off and on, then tap Check again." Until a check succeeds, Print Labels shows the same message instead of sending.
   - **The font check compares sizes, not just names.** The printer's file listing shows each font's size; a font whose size doesn't match the library's is shown as damaged and offered for reinstall (sending `~DY` again overwrites it). This catches a half-written font without any extra commands to the printer. It applies to network printers too.
9. **Finding printers:** the Printer Setup scan lists devices whose name looks like a Zebra serial (12 letters and digits) or that advertise Zebra's service, strongest signal first, refreshing as it scans, with the FEED hint from the test. A 30 s scan, stoppable. Picking one connects, reads Device Information (must say "Zebra Technologies"), identifies it with `~HI` (model, DPI) and saves it, then runs the checks.
10. **Recovery:** if iOS reports the printer removed its pairing (CBError 14) or pairing timed out (CBError 15), the app stops retrying and shows the steps: "Open Settings › Bluetooth, tap ⓘ next to <serial>, choose Forget This Device, then come back and tap Connect." Reconnects after a drop before the link was ready are capped (3 tries, 3 s apart) so a refused pairing can't loop.
11. **Bluetooth off or not allowed:** Printer Setup and Print Labels say so plainly ("Turn on Bluetooth" / "Allow Bluetooth for ServerSherpa Kiosk in Settings", with an Open Settings button), the way Local Network denial is handled today. The Bluetooth permission prompt appears the first time someone picks Bluetooth, not at app launch.
12. **Wording names the printer, not an IP.** Messages that say "at 10.0.0.5" become transport-neutral: "Can't reach the printer D8J224508535 over Bluetooth" / "Can't reach the printer at 10.0.0.5". The Print Labels summary reads "ZD421 · Bluetooth D8J224508535 · 300 dpi".
13. **Troubleshooting tab:** visible to everyone signed in (crews troubleshoot on site). It works on the saved printer, network or Bluetooth:
    - Connection: type, address or serial, connected / idle, MTU and write size for Bluetooth, last disconnect and why.
    - Printer details: `~HI` model/firmware/DPI; for Bluetooth also the Device Information values.
    - Ask the printer: status, error report (`~HQES`), DPI, peeler, serial, font listing buttons, each showing the reply and how long it took.
    - Speed test: 10 / 25 / 50 KB labels that print END at the bottom, with seconds and KB/s.
    - Bluetooth scan: everything nearby with signal strength, Zebras flagged (for "why can't I find my printer?").
    - Report: Copy / Share a text report of all of the above with a log, like the test screen's.
    - A free-text "send a command" box only for admins and developers, because a raw command can change printer settings.
14. **The Bluetooth test card comes out of Printer Setup;** the spike's code is not merged (the branch stays as a reference).
15. **Info.plist:** `NSBluetoothAlwaysUsageDescription` = "Finds and prints to Zebra label printers over Bluetooth."
16. **The clear step after a failed send (Jimmy approved; the mechanics are my call).**
    - A send that fails part-way (link drop, out of range, app to the background, timeout) can leave the printer holding the start of a label. The next label could merge into it or vanish.
    - After any failed send, the printer is marked "needs a clear". The next thing sent to it (the next job, Retry, a test label, or Printer Setup's checks) first sends `~JX`, then the real bytes, under the same printer lock. The mark clears once `~JX` is delivered. Normal sends never carry it.
    - `~JX` is ZPL's "Cancel Current Partially Input Format": it drops only the label that was half received. Labels already received and queued still print. `~JA` (cancel all) is **not** used: in peel mode finished labels wait in the printer, already recorded as Labeled, and `~JA` would throw them away.
    - It applies to network and Bluetooth printers alike (the risk is the same; Bluetooth makes it likelier).
    - The mark lives in memory; the Bluetooth link is closed when the app restarts anyway.
    - A cut **font** download is different (it announces a byte count): decision 8's restart-the-printer path covers it.
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
