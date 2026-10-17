# Kiosk settings in the portal — design

Date: 2026-10-17. Approved direction from Jimmy, the same day.

## 1. Intent

Today every kiosk setting (flash colors, sounds, checkpoints, the alarm…)
lives only on the kiosk, so the office can't see how a kiosk is set up or fix
it remotely. This stores each kiosk's settings in the portal and gives every
kiosk a full **details page** there. A super admin can edit any setting the
kiosk uses, and the kiosk picks up the change at its next check-in.

## 2. Jimmy's decisions

- **Details page:** one page per kiosk, using layout **A**, with tabs across the top.
  - It opens from a kiosk row on Hardware › Kiosk Devices, at `/hardware/kiosks/<id>`.
  - Tabs: **Overview, Settings, Devices, Setup & move, History.**
  - The Settings tab is grouped the same way as the kiosk's own Settings page.
  - Each settings section has its own **Edit** button and shows where its last change came from: "changed on the portal by Jimmy · 2 h ago" or "changed on the kiosk · yesterday".
- **Who can edit:** **super admin or above** (rank 80+). Anyone with hardware view access can see the page.
- **One config, not per setting:** each kiosk has **one config document**. Any change on either side (kiosk or portal) stamps the whole config. At each check-in, the **newer whole config replaces the older one**.
  - Jimmy rejected the per-setting rule because a setting could be missed in the future.
- **Reporting:** the kiosk sends its full config **when it registers** and **every 60 minutes**.
- **Check-in:** at every kiosk/portal check-in (each minute), the portal and the kiosk compare versions, and the newer config is applied.
- **Platforms:** **all four** kiosks: web, laptop, Android and iOS.
- **Uploaded sounds:** stored in the **Spaces bucket**. A config can name any uploaded sound, and kiosks download the files they need. That includes **Android and iOS**: their phases add downloading, caching and playing uploaded sounds (they only have built-ins today).
- **Sync while signed in (option A):** settings sync on the check-ins kiosks already make. Those are the person check-in while someone is signed in, and the laptop RFID Station's own check-in under its station key. A kiosk sitting signed out at its sign-in screen syncs once someone signs in. No new signed-out channel is built.
- **Kiosk Setup stays on the kiosk:**
  - The move, site and station type can't be changed from the portal; the Setup & move tab shows them read-only.
  - The **scan type can be changed from the portal**, limited to the scan types that move and station allow (on an RFID Station, only scan types whose label contains "RFID", as Kiosk Setup already does).

## 3. What the config holds

One JSON document per kiosk, with `schema: 1` and these sections. Every field
has the kiosk's current default.

| Section | Fields | Applies to |
|---|---|---|
| `appearance` | good_scan, not_found_scan, duplicate_scan (each `{h,s,l}`), flash_ms | all |
| `sound` | good, not_found, duplicate (`none` / built-in id / uploaded sound id), alarm (`siren` / built-in / uploaded), volume 0–1 | all |
| `checkpoints` | enroll, container_pack, container_unpack, truck_load, truck_unload (scan-status keys) | all |
| `developer` | dev_mode | all |
| `alarm` | mode (`until_dismissed` / `timed`), timed_seconds 3–600 | laptop RFID Station |
| `android_rfid` | the RFID sled settings Android keeps today (power, session, trigger, beeper, etc.). **Region** is shown read-only: it is a legal setting tied to the sled. Power stays within the app's existing limits *(my call)* | Android |
| `ios` | camera_position | iOS |

**Not in the config:**
- the kiosk's identity (serial, name);
- its server addresses (API/portal URLs);
- the Kiosk Setup choices, except scan type, which keeps living on the device row as today.

**A section a platform doesn't use** is kept and passed through untouched. A kiosk never drops another platform's section.

The portal validates every config it stores. A value out of range, or an unknown sound id, is refused with a clear error. A kiosk report carrying one has that value replaced with its default, and the report is still kept *(my call)*.

## 4. Sync rules

- **The portal stores** the config plus:
  - a **version** number, increased on every accepted change;
  - **changed_at**: when the change was made;
  - **source** (`kiosk` / `portal`);
  - **changed_by**: the person, for a portal edit.
- **The portal is the clock.** Every check-in reply carries the portal's current time, and each kiosk keeps the offset. When a kiosk changes a setting, it stamps the config with its corrected time. So a kiosk with a wrong clock can't win by accident. A change made while offline counts from when it was made.
- **Sending on check-in.** A kiosk with a local change sends its whole config, with its changed_at and the version it started from, on its next check-in. It does this at once, not waiting for the 60-minute report. The 60-minute report and the registration report send the whole config the same way. Any report that differs from what the portal holds is treated as a change.
- **The portal's rule:**
  - If the kiosk's config is newer than the portal's (later changed_at), the portal stores it as the new version, with source `kiosk`.
  - Otherwise the portal keeps its own config.
  - Either way, the reply tells the kiosk the current version.
- **When the kiosk is behind:** if the version the kiosk has applied is older than the portal's, the reply carries the whole config. The kiosk applies all of it, records the version, and confirms on its next check-in.
- **A kiosk that has never reported** shows "Waiting for first report" on its page.
  - A super admin can still edit it; the portal starts from the defaults.
  - **First contact** *(my call)*: a kiosk already in use has settings but no change stamp. Its first report is stored as is, **unless a super admin edited it in the portal before that first report**. In that case the portal edit wins, because it was deliberate. Nobody's settings are silently wiped.
  - Before its first report, a web or laptop kiosk uploads the sounds it already holds locally, so those choices keep working under portal ids *(my call)*.
- **Scan type changes** from the portal reach the kiosk at its next check-in. The kiosk updates its local setup's scan type and label without rerunning Setup.

## 5. Uploaded sounds

- **Storage:** sounds live in the Spaces bucket, with a portal record for each (id, file name, type, size, who uploaded it, when). Limits match the kiosk today: audio only, 2 MB max.
- **Uploading:**
  - A sound uploaded on a kiosk is sent to the portal and gets a portal id. The config always names sounds by portal id.
  - Super admins can also upload sounds on the portal page.
- **Downloading:** a kiosk downloads any sound its config names that it doesn't already have, and keeps a local copy so it plays offline. A missing or failed download plays the default sound for that slot until it succeeds.
- **Deleting:** a sound can be deleted only when no kiosk config uses it *(my call)*.

## 6. The details page

- **Overview:**
  - status (online/offline from last check-in), type, station type, version;
  - registration state, the signed-in person, last check-in, last full report;
  - a **Settings sync** line: In sync / Pending on kiosk (with how long) / Waiting for first report.
- **Settings:** one card per section in §3, showing only the sections that apply to this kiosk's platform and station.
  - Each card shows its values (color swatches, sound names with a Play button, and so on), with **Edit** for super admins.
  - Edit opens the same controls the kiosk uses, in a modal sized to its content (the existing portal modal pattern).
  - Saving stamps a new portal version.
  - A **Reset to defaults** action is available for super admins.
- **Devices:** the reader and printer details the kiosk reports. Read-only.
- **Setup & move:** move, site and station type read-only. Scan type editable for super admins, as in §2.
- **History:** every accepted config change: when, source (kiosk/portal), who (for portal edits), and what changed, as a field-by-field diff. It comes from the audit log.

The Kiosk Devices list stays as it is, but each row's name links to the details page.

## 7. Delivery

The work splits into phases that each ship on their own *(my call)*:
1. Portal storage, sync on check-in, sounds in Spaces, the details page, and the web and laptop kiosks.
2. Android.
3. iOS.

Until a platform's phase ships, its kiosks show "Settings not reported by this app version yet" on the page, and editing is disabled for them.

## 8. Non-goals

- Settings for groups of kiosks, or templates. One kiosk at a time for now.
- Changing the move, site or station type from the portal.
- Pushing server addresses or identity.

## 9. Left to the builder

- Table and column names, and the exact request and reply fields on the check-ins: the person check-in, plus the laptop's station check-in where it applies.
- How each app stores the applied version and offset.
- How the laptop's several browsers share one config. They are one device, so the config is per device.
- Signed URLs vs streaming for sound downloads.
