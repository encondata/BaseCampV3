# Choosing the RFD40's regulatory region

**Status:** approved 2026-09-16
**Builds on:** `2026-09-16-android-rfd40-rfid-design.md`

## Summary

The kiosk can set the regulatory region of a worldwide-model RFD40, so one app serves sites in the United States, Europe and everywhere else. The list of regions is read from the sled itself, never from a list we maintain, so a region-locked reader simply offers the one region it has and a worldwide reader offers all of its own.

The first pass left this read-only, with a line saying to use Zebra's tools. This replaces that.

## Why the reader is the source of truth

An RFD40 ships as a region-specific model. A United States unit is locked to its regulatory domain in firmware and cannot be moved to Europe; a worldwide unit carries several and expects to be told which one it is operating in. Reading the list from `ReaderCapabilities.SupportedRegions` means the kiosk is right about every model without knowing anything about SKUs, and a locked reader produces a single-entry list that the screen renders as a fact rather than a choice.

**This is a compliance setting, not a preference.** It must name the country the device is actually operating in. It is not a route around a locked unit, and the design deliberately makes it hard to change casually.

## Decisions

| Question | Decision |
|---|---|
| Where it lives | The Admin tab, beside the enroll checkpoint. Not on the RFID tab, which anyone signed in can reach. |
| Where the list comes from | The reader's own `SupportedRegions`. Never a hardcoded list. |
| When it is pushed | Only when an admin picks a region. It is NOT folded into the ordinary settings push. |
| While a sweep is running | Refused, with a reason. |
| Hopping and channels | Shown only when the chosen region says they are configurable. Channels are out of scope this pass. |

## The vendor API, verified against the shipped library

Confirmed with `javap` against `RFIDAPI3Library/API3_LIB-release.aar`:

- `ReaderCapabilities.SupportedRegions` is a public field of type `SupportedRegions`, which has `length()` and `getRegionInfo(int)`.
- `RegionInfo` has `getRegionCode()`, `getName()`, `isHoppingConfigurable()` and `getSupportedChannels()`.
- `Config.getRegulatoryConfig()` and `Config.setRegulatoryConfig(RegulatoryConfig)`, both throwing `InvalidUsageException` and `OperationFailureException`.
- `RegulatoryConfig` has `getRegion()` / `setRegion(String)`, `isHoppingon()` / `setIsHoppingOn(boolean)`, and `getEnabledchannels()` / `setEnabledChannels(String[])`. The lower-case spellings in `isHoppingon` and `getEnabledchannels` are the vendor's, not a typo here.

## Shape

**`core/rfid/RfidRegion.kt`**, pure Kotlin:

```kotlin
data class RfidRegion(val code: String, val name: String, val hoppingConfigurable: Boolean, val channels: List<String>)

data class RfidRegions(val supported: List<RfidRegion>, val active: String?)

sealed class RegionChoice {
    /** Nothing known: no reader connected, or it reported nothing. */
    data object Unknown : RegionChoice()
    /** Exactly one region. A fact to display, not a choice to offer. */
    data class Locked(val region: RfidRegion) : RegionChoice()
    data class Choosable(val regions: List<RfidRegion>, val active: RfidRegion?) : RegionChoice()
}

fun regionChoice(regions: RfidRegions): RegionChoice
fun regionLine(choice: RegionChoice): String
```

`regionChoice` is the whole rule: zero supported regions is `Unknown`, one is `Locked`, more is `Choosable` with the active one resolved by code. An active code that matches nothing in the list resolves to a null active rather than inventing an entry.

**The reader interface** gains two members, and nothing else changes:

```kotlin
suspend fun regions(): Result<RfidRegions>
suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit>
```

`ZebraRfidReader` reads the list from `ReaderCapabilities` and the active code from `getRegulatoryConfig()`, and writes through `setRegulatoryConfig`. `FakeRfidReader` gets a settable list so every test and the Developer tab work with no sled.

**The controller** gains `suspend fun loadRegions()` and `suspend fun setRegion(code, hopping)`. Setting is refused while a burst is in progress, because changing the radio's regulatory domain mid-sweep is not something to find out about experimentally. Neither call holds the controller's main mutex across the vendor round trip, following the discipline the class already documents.

**Settings** keep `region: String?` as the last known code, so the Admin row can say something useful while disconnected. The reader remains the source of truth whenever it is connected.

## The Admin row

A row titled "RFID region", blurb "The regulatory domain the reader transmits in. It must match the country this kiosk is operating in."

- **Unknown:** "Connect the reader to see its regions." No control.
- **Locked:** the region's name and code as text, with a line saying this reader supports only that one.
- **Choosable:** a `Segmented` of the supported regions, with the active one selected. Picking one pushes it and reports success or the reader's reason for refusing. When the chosen region reports hopping as configurable, a switch appears beneath it.

The RFID tab's existing region row becomes a read-only line naming the active region and pointing at the Admin tab.

## Errors

| Situation | Behavior |
|---|---|
| Not connected | The row says to connect the reader. No control, no attempt. |
| The reader refuses the region | The reader's reason is shown and the selection reverts to the active one. |
| A sweep is in progress | "Finish the current read before changing the region." |
| The list comes back empty | Treated as Unknown, not as an error. |

## Testing

- Pure: `regionChoice` across zero, one and several regions, an active code that matches nothing, and `regionLine` for each state.
- Controller, against the fake: the list loads; setting pushes to the reader; setting is refused mid-burst; a reader that refuses surfaces its reason.
- Compose, Robolectric: the Admin row renders each of the three states and writes the chosen code.
- Live, when a sled exists: that a worldwide unit lists more than one region, that picking one takes effect, and that a locked unit lists exactly one.

## Not in this pass

Choosing individual channels within a region, frequency hop tables, and any attempt to infer the region from the device's location or SIM. Region is set deliberately by a person who knows where the kiosk is.

## Implementation notes

Task 3 (the Admin row, the RFID tab pointer, and these docs) is done, on top of Tasks 1 and 2, which had already built `core/rfid/RfidRegion.kt` (`RfidRegion`, `RfidRegions`, `RegionChoice`, `regionChoice`, `regionLine`), the two new `RfidReader` members, `ZebraRfidReader`'s implementation of them, `FakeRfidReader`'s `reportedRegions`/`lastRegionSet`/`regionResult`, and `RfidController.loadRegions()`/`setRegion()`. Nothing about the vendor API this plan described turned out to be wrong — `javap` against `API3_LIB-release.aar` was run again while reviewing this pass and it still shows `ReaderCapabilities.SupportedRegions`, `RegionInfo.getRegionCode()`/`getName()`/`isHoppingConfigurable()`/`getSupportedChannels()`, `Config.getRegulatoryConfig()`/`setRegulatoryConfig(RegulatoryConfig)`, and `RegulatoryConfig.getRegion()`/`setRegion(String)`/`isHoppingon()`/`setIsHoppingOn(boolean)`/`getEnabledchannels()`/`setEnabledChannels(String[])` exactly as recorded above, lower-case spellings included. No vendor name or method this design named needed correcting.

A few things this task decided that the plan left open:

- **Persisting the picked region.** This design's "Settings keep `region: String?` as the last known code" is implemented literally: the Admin row's success path writes `container.prefs.setRfid(current.copy(region = code))` after `RfidController.setRegion()` succeeds, the same DataStore write path every other RFID setting uses. The known hazard is that `RfidController`'s settings collector compares the whole `RfidSettings` object and pushes a full settings block to the reader whenever anything changes — exactly the eight-round-trip `apply()` sequence `push()` runs. Folding `region` into that write would have made every region change also fire a pointless full settings push, since `apply()` never reads `region` at all. The fix mirrors the one already in place for `enabled` (`RfidController.kt`, the `settings.collect` block in `start()`): the diff that decides whether to push now also forces `s.region` to match `current.region` before comparing, so a region-only write is invisible to that comparison while `current` itself still ends up holding the new, true region. `RfidControllerTest.togglingOnlyRegionDoesNotPushSettingsToTheReader` is the regression test for this — it asserts that writing only `region` into the settings flow leaves `reader.applied` unchanged, and that a real settings change (`powerDbm`) still pushes.
- **The hopping switch's default.** The design says a switch appears "beneath it" when the chosen region reports hopping as configurable, but does not say what it defaults to or whether toggling it after a region is already picked should push again. The Admin row defaults it to on and re-calls `setRegion(activeCode, newValue)` on every toggle, so the switch is never just local state that silently disagrees with what the reader was last told.
- **Reloading after a successful pick.** The design doesn't say whether the row re-reads the reader after a successful `setRegion()`. The Admin row does — `regions = container.rfid.loadRegions().getOrNull() ?: regions` — so the `Segmented`'s active selection reflects what the reader actually reports as active, not just what the operator clicked, in case the reader's own `getRegulatoryConfig()` differs even slightly (e.g. it normalizes case).
- **The RFID tab's read-only line.** It shows the persisted `RfidSettings.region` code as plain text ("The active region is <code>.") rather than querying the reader for the region's display name, since that tab has no reason to hold a live region list and the design says no control belongs there.

**No physical RFD40 sled has verified any of this pass.** Every test — the pure `regionChoice`/`regionLine` cases from Tasks 1/2, the controller tests against `FakeRfidReader` (including the mid-sweep-refusal race and the push-suppression regression above), and this task's Compose tests against `FakeRfidReader` — runs against the fake reader or pure Kotlin. `ZebraRfidReader.regions()`/`setRegion()` build against the vendor `.aar` and were checked with `javap`, but nothing here has exercised them against real hardware: whether a worldwide unit actually lists more than one region, whether picking one actually takes effect, and whether a locked unit actually reports exactly one, are all still open per the design's own "Testing" section — "Live, when a sled exists" is not this pass.
