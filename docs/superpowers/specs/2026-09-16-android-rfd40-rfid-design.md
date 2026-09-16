# Zebra RFD40 UHF RFID support in the Android kiosk

**Status:** approved 2026-09-16
**Builds on:** `2026-09-15-android-kiosk-design.md`

## Summary

The Android kiosk gains UHF RFID reading through a Zebra RFD40 sled paired over Bluetooth to the phone. Pulling the sled's trigger starts an inventory; the Scanning screen shows a live count of unique tags and total reads while the sweep runs; releasing the trigger queues every unique tag to the existing outbox exactly as a barcode scan would be. A new RFID tab in Settings carries the reader's connection, trigger behavior, and radio configuration.

RFID reading is confined to the Scanning screen in this pass. Containers will follow. RFID Enroll keeps its typed and barcode entry and does not use the sled.

## Decisions

| Question | Decision |
|---|---|
| Host | RFD40 paired over Bluetooth to the Pixel. A Zebra mobile computer host is not a target this pass. |
| What happens to a burst's tags | Every unique tag is queued to the outbox when the trigger is released. |
| Trigger behavior | A setting with three modes. Default: hold to read, release commits. |
| Settings placement | A new RFID tab in Settings, beside Devices. |
| Live display | A panel in place of the scan box while reading. The outbox list stays visible below it. |
| Repeat sweeps | A setting. Default: every burst queues what it read. |
| Sled beeper | A setting, off through high volume. |
| SDK | Zebra RFIDAPI3, hand-placed `.aar`. Bootstrapped from Zebra's public sample repo at 2.0.2.82; to be replaced with 2.0.5.292 from Zebra's download page. |

## Architecture

Three layers, so that the vendor SDK touches as little as possible and everything above it is testable with no hardware.

```
core/rfid/                 pure Kotlin, no android.* or com.zebra.*
  RfidSettings.kt          the settings model, its defaults, and its wire mapping
  RfidTrigger.kt           trigger modes as a pure state machine
  RfidReadSession.kt       the live burst: unique tags, total reads, skipped repeats
  RfidBurst.kt             burst -> the scans to enqueue, under the repeat policy

input/rfid/                Android, but the SDK behind one interface
  RfidReader.kt            the interface: connect, configure, inventory, event flows
  ZebraRfidReader.kt       the only file that imports com.zebra.rfid.api3
  FakeRfidReader.kt        a scriptable stand-in, used by tests and the Developer tab
  RfidController.kt        owns a reader, applies settings, exposes session state

ui/screens/scan/           the live panel and the burst commit
ui/screens/settings/       RfidPanel.kt
```

`core/rfid/` is covered by the existing `CorePurityTest`, so the iOS app can transliterate it.

### The pure core

**`RfidSettings`** is a data class persisted to DataStore alongside the other preferences.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | Boolean | false | Off until someone turns the reader on in Settings. Nothing connects, and no permission is requested, while this is false. |
| `triggerMode` | `HOLD`, `HOLD_OR_LATCH`, `TOGGLE` | `HOLD` | See below. |
| `repeatPolicy` | `ALWAYS_QUEUE`, `SKIP_SILENT`, `SKIP_AND_COUNT` | `ALWAYS_QUEUE` | Applies across bursts within one visit to the Scanning screen. |
| `beeper` | `OFF`, `LOW`, `MEDIUM`, `HIGH` | `MEDIUM` | One control covers both "does it beep" and "how loud"; `OFF` is Zebra's `QUIET_BEEP`. |
| `powerDbm` | Int, 5 to 30 | 27 | The setting most likely to need tuning on site: lower it to stop a sweep pulling in the next rack. |
| `session` | `S0`, `S1`, `S2`, `S3` | `S1` | |
| `tagPopulation` | Int, 1 to 1000 | 30 | An estimate of how many tags are in the field. |
| `uniqueTagReport` | Boolean | true | The reader reports a tag once per inventory rather than repeatedly. |
| `ledOnRead` | Boolean | true | |
| `dpo` | Boolean | true | Dynamic power optimization; saves battery during inventory. |
| `region` | String? | null | Null means leave the reader's own regulatory setting alone. |

**`RfidTrigger`** turns a trigger event into an action, as a pure function of the mode, the current reading state, and how long the trigger was held:

```
nextAction(mode, event, reading, heldMs): Start | Stop | None
```

- `HOLD`: press starts, release stops.
- `HOLD_OR_LATCH`: press starts. A release inside `LATCH_MS` (500) leaves it reading, latched; the next press stops. A release after `LATCH_MS` stops.
- `TOGGLE`: press toggles, release is ignored.

**`RfidReadSession`** accumulates a burst: `totalReads` counts every report including repeats of the same tag, `uniqueTags` is an ordered set, and `skippedRepeats` counts tags the repeat policy dropped. Tags are keyed with the existing `rfidKey` (zero-padding stripped, upper-cased), so the live count and the roster match agree on what "the same tag" means.

**`RfidBurst`** converts a finished session into the list of values to enqueue, consulting the set of tags already queued this visit and the repeat policy.

### The reader interface

```kotlin
interface RfidReader {
    val connection: StateFlow<RfidConnection>   // Disconnected | Connecting | Connected(name, batteryPct) | Failed(reason)
    val tags: Flow<String>                      // EPCs, already on our dispatcher
    val triggers: Flow<TriggerEvent>            // Pressed | Released
    suspend fun connect(): Result<Unit>
    suspend fun disconnect()
    suspend fun apply(settings: RfidSettings): Result<Unit>
    suspend fun startInventory(): Result<Unit>
    suspend fun stopInventory(): Result<Unit>
}
```

`ZebraRfidReader` wraps `Readers(context, ENUM_TRANSPORT.ALL)`, connects the first available `ReaderDevice`, and registers a `RfidEventsListener`. Its callbacks arrive on an SDK background thread, so it does nothing but push onto flows that the controller collects on our own dispatcher. Trigger events come from `eventStatusNotify` with `HANDHELD_TRIGGER_EVENT`, enabled by `Events.setHandheldEvent(true)` and `Config.setTriggerMode(RFID_MODE, true)`.

The app drives inventory itself rather than handing start and stop triggers to the reader, because the latch and toggle modes cannot be expressed in the reader's own trigger configuration.

`FakeRfidReader` implements the same interface with methods to push trigger events and tag reads on demand. It drives every unit test and backs a Developer-tab control that fires a synthetic burst, so the panel, the counts, and the outbox commit can be exercised with no sled attached.

### The controller

`RfidController` lives in `AppContainer`, owns one `RfidReader`, and exposes:

- `connection: StateFlow<RfidConnection>` for the Settings tab and the Devices row.
- `session: StateFlow<RfidReadSession?>`, non-null only while a burst is in progress.
- `bursts: Flow<List<String>>`, one emission per completed burst.

It collects the reader's trigger flow, runs `RfidTrigger.nextAction` against the current mode, and starts or stops the inventory. It re-applies settings on connect and whenever they change. It holds no Android UI types, and it knows nothing about assets, the roster, or the outbox: it produces tag values and stops there.

**Arming.** The controller acts on a trigger only while armed, and only the Scanning screen arms it, in the same screen-level `LaunchedEffect` that collects the scan bus. Leaving the screen disarms it and stops any inventory in progress. This is the same rule the rest of the app already follows: a read cannot land on a screen that is not on top.

**Who turns a burst into scans.** `ScanViewModel` collects `bursts`, and for each value runs the existing `matchScan` against its roster index and enqueues through the existing outbox path. The commit rules therefore live next to the barcode commit rules, and an RFID row differs from a typed row only in its `scan_type`.

Connection is attempted when the reader is enabled in settings and the app is in the foreground, and it disconnects in `onStop` alongside the DataWedge receiver. A failed connect surfaces as `Failed(reason)` and is retried on the next foreground, never in a tight loop.

## The Scanning screen

While `session` is null, the screen is exactly what it is today.

While a burst is running, a panel replaces the scan box:

- The unique tag count, large, in the accent color.
- Total reads beside it, smaller and muted, so an operator can tell a slow read from a repeat-heavy one.
- The most recent tags as horizontally scrolling chips, newest first, the same chip used by the camera sheet's tally strip.
- When the repeat policy is `SKIP_AND_COUNT`, a third figure for tags already sent.
- A Stop button, so a latched or toggled read can be ended without the trigger.

The outbox list below does not move, so the queued rows appear where the operator is already looking.

On release, every unique tag the policy allows is matched with the existing `matchScan` and enqueued with `scan_type = "rfid"`, matched or not, exactly as a typed or barcode value is today. Feedback is one result for the whole burst rather than one per tag: a good flash and sound if anything matched, the not-found flash if nothing did, and nothing at all if the burst read no tags. The sled's own beeper handles per-tag feedback when it is turned on.

The sled does nothing on any other screen. The controller only starts an inventory while the Scanning screen is the one collecting.

## Settings: the RFID tab

A seventh tab, `SettingsTabId.RFID`, labeled "RFID", blurb "The RFID reader attached to this kiosk." Visible signed in, no role requirement.

- **Reader.** An enable switch, the connection state, the reader's name, battery percentage when connected, and a Connect or Disconnect button. A failed connection shows its reason.
- **Trigger.** The three modes as a segmented control, each with a one-line explanation.
- **Repeat sweeps.** The three policies as a segmented control.
- **Sled beeper.** Off, Low, Medium, High.
- **Read settings.** Transmit power as a slider in dBm with its value shown, session as a segmented control, tag population as a slider, and switches for duplicate elimination, LED on read, and dynamic power optimization.
- **Region.** A chooser fed by the reader's own `getRegionInfo()` when connected; otherwise a line saying the reader's current setting is left alone.
- **Restore defaults.** Puts every field back to the table above and re-applies.

The Devices tab keeps its read-only character and gains one row: "RFID reader", showing connected with battery, or not connected, or "No reader configured", pointing at the RFID tab.

## Permissions

`BLUETOOTH_CONNECT` and `BLUETOOTH_SCAN` for Android 12 and up, the legacy `BLUETOOTH` and `BLUETOOTH_ADMIN` capped at API 30, and `ACCESS_FINE_LOCATION`, which Zebra's own guidance says the library needs for its Bluetooth configuration on Google reference platforms. Permissions are requested when the reader is first enabled in Settings, not at launch, and a refusal leaves a clear line in the RFID tab rather than a silent failure.

## Errors

Every failure is a line the operator can act on, never a crash and never silence.

| Situation | Behavior |
|---|---|
| SDK not present at runtime | The RFID tab says the reader library is missing; nothing else changes. |
| No reader found | "No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first." |
| Connect fails | The reason from the SDK, with a Retry button. |
| Connection drops mid-burst | The burst ends where it stopped, its tags are queued, and the panel closes with "The reader disconnected." |
| A setting the reader rejects | The row reverts to the reader's value and says so. |
| Permission refused | The tab explains which permission and offers a button to Android's app settings. |

## Testing

- **Pure core, plain JUnit:** the trigger state machine across all three modes including the latch boundary, session accumulation and unique keying, and burst-to-scans under each repeat policy.
- **Controller, with `FakeRfidReader`:** trigger press and release drives inventory start and stop; a burst's tags reach the outbox; a settings change re-applies; a disconnect mid-burst still commits.
- **Compose, Robolectric:** the live panel shows the counts it is given, the Stop button ends a burst, and the RFID settings tab renders and writes each control.
- **`CorePurityTest`** keeps `core/rfid/` free of Android and Zebra imports.
- **Live verification** on the Pixel with the RFD40: pair, connect, sweep a rack, confirm the counts move, confirm the queued rows reach the portal, and try each trigger mode.

## Risks

- **Duplicate classes at build time.** The `.aar` bundles slf4j, Apache Commons, jdom, antlr and others. If any collide with ours the build fails and needs a packaging exclusion. Nothing in the app currently uses those, so the risk is real but small.
- **The Pixel is not a documented configuration.** Zebra's product page and a forum answer say a third-party phone works; there is no support matrix. If the sled will not pair or connect, the fallback is a Zebra host, which this design does not otherwise change.
- **The bootstrap SDK is 2.0.2.82, from February 2022.** Zebra's Bluetooth guidance for Google phones points at newer firmware and a newer SDK, so replacing it with 2.0.5.292 is expected before this is trusted on the floor.
- **Licensing.** The Zebra EULA permits incorporating the library into your own program but is written around supporting Zebra hardware, and forbids combining it with copyleft-licensed software. The repository is private, which is the comfortable case.

## Not in this pass

Containers, RFID Enroll from the sled, tag locationing and Geiger mode, writing or locking tags, the RFD40's own barcode imager, a Zebra mobile computer host, USB attachment, DataWedge's RFID input plugin, pre-filters and post-filters, and multiple saved reader profiles.
