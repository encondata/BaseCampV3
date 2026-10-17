# "Asset Not Part Of Move" alarm — design

Date: 2026-10-17. Builds on `2026-10-16-rfid-scan-processing-design.md`
(off-move sightings, the client-wide asset download).

## 1. Intent

A worker pushes a cart through an RFID Station doorway. If one of the client's
servers that is **not** on the selected move goes through, the station must
stop them right there, so the asset is pulled before it travels with the wrong
move. Today the laptop already detects and uploads these reads as flagged
off-move sightings, but nobody at the door finds out. This adds the alarm the
worker sees and hears.

Later, the barcode-scanning and label-printing kiosks will reuse the same
alarm. That is a separate project and not part of this one.

## 2. Jimmy's decisions (2026-10-17)

- **What trips it:** a tag read that matches an asset of the selected move's
  **client** that is **not on the selected move**. Unknown tags, other clients'
  assets, and this move's own assets never alarm.
- **Which client assets count:** every asset of the client that isn't on
  the selected move. That includes assets on the client's **finished**
  (Completed) moves and assets on **no move at all** (`assets.client_id` is the
  client).
- **Where:** the takeover shows on **any page** of the RFID Station laptop, not
  only the RFID Reader dashboard.
- **Look:** the whole screen flashes red. It
  shows **"Asset Not Part Of Move"**, the move name, and a table of every
  off-move asset from that pass with columns **Make / Model, Name, Serial,
  RFID** (mockup A, the full-screen takeover).
- **Sound:** a loud alarm plays with the flash.
- **Two modes, set on the laptop's Settings page:**
  - **Until dismissed** (the default): flash and sound until someone taps
    Dismiss or presses the **space bar**.
  - **Timed:** flash and sound for **X seconds**, then the dashboard comes back
    on its own. X defaults to **10**. Tap or space still dismisses early.
- **Several assets:** all of them are listed, and each asset alarms once.
- **Repeats:** an asset that was already alarmed alarms again only when it is
  read **more than 1 hour** after its last alarm.
- **Test alarm:** the Settings page gets a **Test alarm** button, so whoever
  sets up the station can check the sound is loud enough. The page can't
  control the laptop's system volume.

## 3. Behavior

1. **Detection on the laptop.** The edge already marks off-move matches in
   `pending_rfid_scans` (`off_move = 1`, with the asset's own move). The alarm
   is driven from those rows on the laptop itself, so it works with no
   internet. Uploading is unchanged: each read is still sent as the flagged
   off-move sighting it already is.
2. **The 1-hour rule** lives on the edge, keyed by asset, and survives a
   restart. An off-move match for an asset whose last alarm was less than an
   hour ago is uploaded as usual but raises no alarm.
3. **Assets on no move.** The client-wide download today lists only assets on
   the client's other non-archived moves. It must also list the client's
   assets that are on no move (`Asset.client_id` = the client, not archived,
   not on the selected move), with no move id or name. The edge matches them
   as off-move like the rest, and the upload sends the sighting with no move.
   The builder checks the portal's off-move sighting path accepts that.
4. **Make and Model.** The client-wide asset download (`/kiosk/sync/client-assets`
   and its station twin) gains the asset's make and model, so the table can
   show them. A portal that doesn't send them yet shows "—".
5. **While the alarm is up:**
   - a newly alarmed asset is added to the table and the sound keeps going;
   - in timed mode the countdown restarts;
   - in timed mode the button shows the remaining seconds.
6. **Dismiss** clears the table. An asset dismissed in this pass is still
   covered by the 1-hour rule.
7. **Reaching the screen fast.** The dashboard polls every 5 s today. The
   alarm must reach the screen within about 2 s of the read *(my call)*.
8. **Settings.** The mode and X live on the edge, so they belong to the
   station rather than to a browser *(my call)*. They sit on the existing
   laptop Settings page next to the other kiosk settings.
9. **System Events.** Each alarm adds one System Events entry, written by the
   edge, naming up to 5 assets plus "and N more" *(my call)*.
10. **Only fresh reads alarm** *(my call)*. Rows matched after the fact (the
    re-check once the client list downloads, or a backlog after a sync) are
    uploaded as usual but never alarm and don't start the 1-hour clock. "Fresh"
    means the read is at most 30 s old when it is matched.
11. **The open alarm lives on the edge** *(my call)*. A reloaded page brings
    it back, Dismiss clears it for every open page, and the 1-hour clock
    counts from the asset's last alarm (a re-read inside the hour doesn't
    extend it).
12. **Test alarm** is a local preview with one sample row *(my call)*: sound
    and takeover only, no System Events entry, and no effect on the 1-hour
    state.
13. **Station only.** The Settings section and the takeover exist only on a
    laptop set up as an RFID Station *(my call)*.

## 4. Non-goals

- Barcode and label kiosks (a later project).
- Any portal-side alarm, notification or status rule. The portal side already
  records off-move sightings; Jimmy plans a status rule for them separately.
- Choosing the alarm sound per station or adjusting volume in the app.

## 5. Left to the builder

- The sound itself. A generated siren (Web Audio) avoids shipping an audio
  file *(my call)*.
- Browsers block sound until the page has had a click or key press. The
  dashboard is normally opened by pressing Start Reader, which counts (see
  the notice below).
- How the dashboard learns about new alarms quickly: a faster poll of a small
  edge endpoint, or the existing poll sped up.
- X is validated to 3–600 seconds *(my call)*.
- If sound is blocked after a reload with no interaction, show a small "Tap to
  enable sound" notice on the takeover *(my call)*.
