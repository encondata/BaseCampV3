# Kiosk Settings › Devices tab — design

Date: 2026-10-17. Replaces the "This section is not available yet." placeholder.

## 1. Intent

Someone opens Settings › Devices to **check that the station's devices are
connected and working** (Jimmy). The tab answers that at a glance, and gives
each device one button that proves it works. Jimmy handed the content
decisions to me; the approved mockup is
`.superpowers/brainstorm/52010-1792253187/content/devices-tab-v2.html`.

## 2. Layout (approved)

- **One card per device type:** RFID reader, Label printer, Barcode
  scanner.
- **Grid:** two columns on wide screens, one column on narrow ones. The
  scanner card spans the full width.
- **Every card is laid out the same way:**
  - title and a status pill;
  - a details list;
  - optional notes;
  - a **button row pinned to the bottom of the card**, so buttons on side-by-side cards line up even when one card has empty space (Jimmy's one change).
- The tab refreshes on its own while it is open.

## 3. RFID reader card

**Status pill:**
- **Reading** (green);
- **Standby**: reachable, not reading (slate);
- **Offline**: unreachable (red);
- **Not paired** (slate);
- **Checking…** while the edge is busy with another reader call. "Busy" is never shown as Offline.

**Details:** each row is shown only when the edge knows the value.
- Model, Serial, Address (IP), Firmware.
- Antennas: "N of M connected (ports)".
- Last tag read: an age, like "12 seconds ago", with the full time on hover.
- Tags in the last 24 h.
- Up for: the reader's uptime as an age.
- Paired: an age.

**Buttons:**
- **Check reader** runs the existing `/edge/rfid/checks/reader` and shows the result on the card.
- **Open RFID dashboard** goes to `/rfid_status`, and only on an RFID Station.

**Off a laptop** (web mode), the card reads "RFID readers connect to a laptop
RFID Station." There is no pill and no buttons.

**Data:**
- `GET /edge/rfid/status` every 5 s, as the dashboard already does.
- A new small edge route, `GET /edge/rfid/device`, returning:
  - the reader snapshot the edge already builds every minute (firmware, MAC, uptime, antennas total, tags_24h);
  - the pairing's `paired_at`;
  - the newest `raw_tag_reads.received_at` for the paired reader.

  It is polled every 30 s *(my call)*. It needs an edge session, like the rest of `/edge/rfid`.

## 4. Label printer card

The kiosk talks to Zebra printers over **WebUSB** (`useZebraPrinter`).

**Status pill:**
- **Ready** (green).
- **Paper out / Ribbon out / Head open / Paused / Too hot / Too cold**, from `~HS` (amber; the first problem wins, and all problems also show as chips via the existing `healthChips`).
- **Not connected** (slate).
- When the browser has no WebUSB, the card reads "Use Chrome or Edge to connect a Zebra printer.", with no buttons except a disabled Connect.

**Details** from `~HI` / `~HS`: Model, Firmware, Resolution (dpi), Connection ("USB"), Labels queued.

**Buttons:**
- When connected: **Print test label**, **Refresh**, **Disconnect**, and **Printer tools**. The Printer tools link is shown only where the Label Printing pages are reachable on this kiosk.
- When not connected: **Connect printer**, which opens the browser picker.

**Other printers:** a note above the buttons lists the other Zebra printers this browser is already allowed to use, so you can tap to switch (`knownDevices()`).

**On opening the tab:** if exactly one printer is already allowed, it connects to it automatically *(my call)*. With several, the first is chosen. Then `~HI` and `~HS` run.

**Refreshing:** status refreshes every 10 s while the tab is open *(my call)*.

**Test label** *(my call)*: a small ZPL label that fits any common label size. It reads "ServerSherpa test label", the kiosk name, and the date and time, with a border, sized from the printer's dpi. No modal.

The printer is released when the tab closes, so the Printer tools page can claim it.

## 5. Barcode scanner card

Scanners type like a keyboard, so the kiosk can't detect one until it scans.

- The card has a test area: while the Devices tab is open, a scan anywhere is caught here and shown as "Last scan: <value> · <age>".
- The scan is not typed into any other field, and it never triggers a kiosk scan action.
- A scan is a burst of keys ending in Enter, faster than a person types *(my call: under 50 ms between keys)*.
- **Status pill:** "Scan to test" (slate) until the first scan, then "Working" (green).
- **Clear** resets it.
- A note explains why the kiosk can't detect a scanner up front.

## 6. Non-goals

- Changing printer settings, alignment or fonts. Printer tools already does that; the Devices tab links to it.
- Network (IP) printers, and printers on Android/iOS.
- Any portal-side change.

## 7. Left to the builder

Exact copy beyond what is quoted here, and component structure. Reuse kiosk
idioms (the `settings`/`local-kv`/`chip`/`mini-btn` classes,
`healthChips`, `readerState`/`antennasLabel` from RfidStatus) rather than
new look-alikes.
