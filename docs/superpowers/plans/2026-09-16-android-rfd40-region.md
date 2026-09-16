# RFD40 regulatory region — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin set a worldwide-model RFD40's regulatory region from the kiosk, with the list of regions read from the sled itself.

**Architecture:** A pure `core/rfid/RfidRegion.kt` decides what the screen should offer given what the reader reports. The `RfidReader` interface gains two members, implemented for real against Zebra's `RegulatoryConfig` and for tests against the fake. The controller exposes both without holding its main lock across a vendor call. The control lives on the Admin tab.

**Tech Stack:** Kotlin, Jetpack Compose, Zebra RFIDAPI3, Robolectric.

## Global Constraints

Everything in `.superpowers/sdd/global-constraints.md` applies. In addition:

- The spec is `docs/superpowers/specs/2026-09-16-android-rfd40-region-design.md`. Read it before Task 1.
- `core/` must not import `android.*`, `androidx.*` or `com.zebra.*`. `CorePurityTest` enforces the first two and now the third.
- `ZebraRfidReader.kt` is the only production file that may import `com.zebra.*`.
- Region is a COMPLIANCE setting. It is pushed only when an admin explicitly picks one, never as part of the ordinary settings push, and never inferred from anything.
- The vendor spellings `isHoppingon()` and `getEnabledchannels()` are Zebra's own. Verify every SDK name with `javap` against `RFIDAPI3Library/API3_LIB-release.aar` before writing it.
- `RfidController` has been through six concurrency fix waves. Read its class documentation, keep its locking discipline, and do not hold its mutex across a vendor round trip.
- American English in every string, comment and doc.

---

### Task 1: What the screen should offer

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidRegion.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidRegionTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `RfidRegion(code, name, hoppingConfigurable, channels)`, `RfidRegions(supported, active)`, `sealed class RegionChoice` with `Unknown`, `Locked(region)`, `Choosable(regions, active)`, `fun regionChoice(regions: RfidRegions): RegionChoice`, `fun regionLine(choice: RegionChoice): String`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidRegionTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidRegionTest {
    private fun region(code: String, name: String, hopping: Boolean = false) =
        RfidRegion(code, name, hoppingConfigurable = hopping, channels = emptyList())

    private val usa = region("USA", "United States")
    private val eu = region("ETSI", "Europe", hopping = true)

    @Test fun nothingReportedIsUnknownRatherThanAnEmptyChoice() {
        assertEquals(RegionChoice.Unknown, regionChoice(RfidRegions(emptyList(), null)))
        assertEquals(RegionChoice.Unknown, regionChoice(RfidRegions(emptyList(), "USA")))
        assertEquals("Connect the reader to see its regions.", regionLine(RegionChoice.Unknown))
    }

    /** A region-locked reader states a fact; it does not offer a choice. */
    @Test fun oneRegionIsLocked() {
        val choice = regionChoice(RfidRegions(listOf(usa), "USA"))
        assertEquals(RegionChoice.Locked(usa), choice)
        assertEquals("This reader supports only United States (USA).", regionLine(choice))
    }

    @Test fun severalRegionsAreChoosableAndTheActiveOneIsResolved() {
        val choice = regionChoice(RfidRegions(listOf(usa, eu), "ETSI"))
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), eu), choice)
        assertEquals("Set to Europe (ETSI).", regionLine(choice))
    }

    /** A reader that names an active region we were not offered must not make
     *  one up; the row says nothing is set rather than inventing an entry. */
    @Test fun anActiveCodeThatMatchesNothingResolvesToNull() {
        val choice = regionChoice(RfidRegions(listOf(usa, eu), "NOWHERE"))
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), null), choice)
        assertEquals("No region set on this reader yet.", regionLine(choice))
    }

    @Test fun aNullActiveCodeIsAlsoNoRegionSet() {
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), null), regionChoice(RfidRegions(listOf(usa, eu), null)))
    }

    /** The code is matched exactly as the reader spells it, with surrounding
     *  space ignored — some readers pad the value. */
    @Test fun theActiveCodeIsMatchedIgnoringSurroundingSpace() {
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), usa), regionChoice(RfidRegions(listOf(usa, eu), "  USA ")))
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidRegionTest'
```

Expected: FAIL to compile, `Unresolved reference: RfidRegion`.

- [ ] **Step 3: Write the model**

Create `app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidRegion.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

/**
 * The regulatory region a reader transmits in.
 *
 * An RFD40 ships as a region-specific model: a United States unit is locked to
 * its domain in firmware, a worldwide unit carries several and expects to be
 * told which country it is in. So the list always comes from the reader, never
 * from a list we keep here — that way the kiosk is right about every model
 * without knowing anything about which one it is holding.
 */
data class RfidRegion(
    val code: String,
    val name: String,
    val hoppingConfigurable: Boolean,
    val channels: List<String>,
)

/** What a reader reports: the regions it allows, and the one in force. */
data class RfidRegions(val supported: List<RfidRegion>, val active: String?)

/** What the Admin row should put on screen. */
sealed class RegionChoice {
    /** No reader connected, or it reported no regions at all. */
    data object Unknown : RegionChoice()
    /** Exactly one region: a fact to state, not a choice to offer. */
    data class Locked(val region: RfidRegion) : RegionChoice()
    data class Choosable(val regions: List<RfidRegion>, val active: RfidRegion?) : RegionChoice()
}

fun regionChoice(regions: RfidRegions): RegionChoice {
    val supported = regions.supported
    if (supported.isEmpty()) return RegionChoice.Unknown
    val active = regions.active?.trim()?.let { code -> supported.firstOrNull { it.code == code } }
    if (supported.size == 1) return RegionChoice.Locked(supported.first())
    return RegionChoice.Choosable(supported, active)
}

fun regionLine(choice: RegionChoice): String = when (choice) {
    RegionChoice.Unknown -> "Connect the reader to see its regions."
    is RegionChoice.Locked -> "This reader supports only ${choice.region.name} (${choice.region.code})."
    is RegionChoice.Choosable ->
        choice.active?.let { "Set to ${it.name} (${it.code})." } ?: "No region set on this reader yet."
}
```

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidRegionTest'
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Build and commit**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): what the region row should offer, decided in pure Kotlin

The list always comes from the reader, so a locked unit states one region as a
fact and a worldwide unit offers its own. An active code the reader names but
does not list resolves to nothing set, rather than inventing an entry.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Reading and setting the region on a reader

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidReader.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/FakeRfidReader.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/ZebraRfidReader.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidController.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidRegionControllerTest.kt`

**Interfaces:**
- Consumes: `RfidRegion`, `RfidRegions` from Task 1.
- Produces: on `RfidReader`, `suspend fun regions(): Result<RfidRegions>` and `suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit>`; on `FakeRfidReader`, a settable `var reportedRegions: RfidRegions` and a readable `var lastRegionSet: Pair<String, Boolean?>?`; on `RfidController`, `suspend fun loadRegions(): Result<RfidRegions>` and `suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit>`.

- [ ] **Step 1: Verify the vendor names before writing any of them**

```bash
cd Android_Kiosk_App
unzip -p RFIDAPI3Library/API3_LIB-release.aar classes.jar > /tmp/api3-region.jar
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
"$JAVA_HOME/bin/javap" -classpath /tmp/api3-region.jar com.zebra.rfid.api3.RegulatoryConfig
"$JAVA_HOME/bin/javap" -classpath /tmp/api3-region.jar com.zebra.rfid.api3.RegionInfo
"$JAVA_HOME/bin/javap" -classpath /tmp/api3-region.jar com.zebra.rfid.api3.SupportedRegions
"$JAVA_HOME/bin/javap" -classpath /tmp/api3-region.jar com.zebra.rfid.api3.Config | grep -i regul
```

These were confirmed when the spec was written, and are expected to be: `RegulatoryConfig.getRegion()` / `setRegion(String)`, `isHoppingon()` / `setIsHoppingOn(boolean)`, `getEnabledchannels()` / `setEnabledChannels(String[])`; `RegionInfo.getRegionCode()`, `getName()`, `isHoppingConfigurable()`, `getSupportedChannels()`; `SupportedRegions.length()` and `getRegionInfo(int)`; `Config.getRegulatoryConfig()` and `setRegulatoryConfig(RegulatoryConfig)`. Record anything that differs in your report and use what `javap` actually prints.

- [ ] **Step 2: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidRegionControllerTest.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RfidRegionControllerTest {
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { runCurrent() } }

    private val usa = RfidRegion("USA", "United States", hoppingConfigurable = false, channels = emptyList())
    private val eu = RfidRegion("ETSI", "Europe", hoppingConfigurable = true, channels = emptyList())

    private class Rig(scope: kotlinx.coroutines.CoroutineScope) {
        val reader = FakeRfidReader()
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(reader, settings, scope) { 0L }
    }

    @Test fun theRegionListComesFromTheReader() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.controller.start(); settle()
        r.controller.connectNow(); settle()

        val got = r.controller.loadRegions().getOrThrow()
        assertEquals(listOf(usa, eu), got.supported)
        assertEquals("USA", got.active)
    }

    @Test fun pickingARegionReachesTheReader() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.controller.start(); settle()
        r.controller.connectNow(); settle()

        assertTrue(r.controller.setRegion("ETSI", hopping = true).isSuccess)
        assertEquals("ETSI" to true, r.reader.lastRegionSet)
    }

    /** Changing the radio's regulatory domain in the middle of a sweep is not
     *  something to find out about experimentally. */
    @Test fun theRegionCannotBeChangedWhileASweepIsRunning() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()

        val result = r.controller.setRegion("ETSI", hopping = null)
        assertTrue(result.isFailure)
        assertEquals("Finish the current read before changing the region.", result.exceptionOrNull()?.message)
        assertEquals(null, r.reader.lastRegionSet)
    }

    @Test fun aReaderThatRefusesTheRegionSaysWhy() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.reader.regionResult = Result.failure(IllegalStateException("Region is locked on this reader."))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()

        val result = r.controller.setRegion("ETSI", hopping = null)
        assertEquals("Region is locked on this reader.", result.exceptionOrNull()?.message)
    }

    @Test fun neitherCallWorksWhileDisconnected() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); settle()
        assertTrue(r.controller.loadRegions().isFailure)
        assertTrue(r.controller.setRegion("ETSI", hopping = null).isFailure)
    }
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.RfidRegionControllerTest'
```

Expected: FAIL to compile, `Unresolved reference: reportedRegions`.

- [ ] **Step 4: Extend the interface**

In `input/rfid/RfidReader.kt`, add these two members to the interface, with the imports they need:

```kotlin
    /** The regions this reader allows and the one in force. A reader that
     *  reports none yields an empty list rather than a failure. */
    suspend fun regions(): Result<RfidRegions>

    /** Set the regulatory domain. `hopping` is applied only when the chosen
     *  region says hopping is configurable; pass null to leave it alone. */
    suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit>
```

- [ ] **Step 5: Extend the fake**

In `input/rfid/FakeRfidReader.kt`, add:

```kotlin
    /** What this fake claims to support. Set it in a test before connecting. */
    var reportedRegions: RfidRegions = RfidRegions(emptyList(), null)

    /** The last region a caller set, for a test to assert on. */
    var lastRegionSet: Pair<String, Boolean?>? = null
        private set

    /** Set this to make the next setRegion fail. */
    var regionResult: Result<Unit> = Result.success(Unit)

    override suspend fun regions(): Result<RfidRegions> {
        if (_connection.value !is RfidConnection.Connected) {
            return Result.failure(IllegalStateException("The reader is not connected."))
        }
        return Result.success(reportedRegions)
    }

    override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> {
        if (_connection.value !is RfidConnection.Connected) {
            return Result.failure(IllegalStateException("The reader is not connected."))
        }
        return regionResult.onSuccess {
            lastRegionSet = code to hopping
            reportedRegions = reportedRegions.copy(active = code)
        }
    }
```

Keep the fake's existing strictness: it refuses anything that needs a connection while disconnected, and it throws when an emission has no collector. Do not weaken either.

- [ ] **Step 6: Implement it for real**

In `input/rfid/ZebraRfidReader.kt`, add the two overrides, following the file's existing conventions exactly: the vendor call runs inside the same cancellable wrapper the other operations use, nothing is done while holding a lock the callbacks need, and a failure comes back as a readable sentence rather than a vendor code. Build the region list from `ReaderCapabilities.SupportedRegions` and the active code from `Config.getRegulatoryConfig().getRegion()`; write with a `RegulatoryConfig` whose region is set, applying `setIsHoppingOn` only when `hopping` is non-null.

Read how `apply()` in this same file handles its vendor round trips and match it. Use the names `javap` printed in Step 1.

- [ ] **Step 7: Expose it on the controller**

In `input/rfid/RfidController.kt`, add `loadRegions()` and `setRegion(code, hopping)`. Both delegate to the reader. Neither may hold the controller's main mutex across the vendor call — read the class documentation and follow the discipline it states. `setRegion` must refuse while a burst is in progress, with exactly the message `"Finish the current read before changing the region."`, and must not reach the reader in that case.

- [ ] **Step 8: Run the tests and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL, the new tests passing and every existing RFID controller test still passing.

- [ ] **Step 9: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): read and set the RFD40's regulatory region

The reader reports which regions it allows, so a locked unit offers one and a
worldwide unit offers its own. Setting is refused mid-sweep, and neither call
holds the controller's lock across the vendor round trip.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The Admin row, the RFID tab pointer, and the docs

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/AdminPanel.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/RfidPanel.kt`
- Modify: `Android_Kiosk_App/README.md`
- Modify: `docs/superpowers/specs/2026-09-16-android-rfd40-region-design.md`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/AdminRegionTest.kt`

**Interfaces:**
- Consumes: `regionChoice`, `regionLine`, `RegionChoice`, `container.rfid.loadRegions()`, `container.rfid.setRegion(...)`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/AdminRegionTest.kt`. Follow the conventions in the existing `RfidPanelTest.kt` exactly: Robolectric, `@Config(sdk = [34], qualifiers = "w360dp-h800dp")`, `testContainer()`, content wrapped in `KioskTheme { }` and in the same scroll wrapper, `performScrollTo()` before touching a control low on the page, and no assertion wrapped in a try/catch.

Cover three cases, each asserting real text or a real write:

1. With no reader connected, the row reads "Connect the reader to see its regions." and offers no choice.
2. With a fake reporting exactly one region, the row states that one region and offers no choice.
3. With a fake reporting two, picking the other one reaches the reader: assert `lastRegionSet` on the fake.

`testContainer()` takes an optional reader parameter, added in an earlier task; use it to inject a `FakeRfidReader` with `reportedRegions` set.

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.settings.AdminRegionTest'
```

Expected: FAIL, the expected text is not on screen.

- [ ] **Step 3: Add the Admin row**

In `AdminPanel.kt`, add a row titled `"RFID region"` with the blurb `"The regulatory domain the reader transmits in. It must match the country this kiosk is operating in."`

Load the regions in a `LaunchedEffect` keyed on the reader's connection state, so the row fills in when a reader connects and empties when it goes away. Render from `regionChoice(...)`:

- `Unknown`: the line from `regionLine`, no control.
- `Locked`: the line from `regionLine`, no control.
- `Choosable`: the line from `regionLine`, then a `Segmented` of `code to name` with the active code selected. Picking one calls `container.rfid.setRegion(code, hopping)` and, on failure, shows the reader's message with `KioskToast(error = true)` and leaves the selection on the active region. When the chosen region's `hoppingConfigurable` is true, show a `Switch` labeled for frequency hopping beneath it.

This panel already fetches a list asynchronously and falls back when the fetch fails, for the enroll checkpoint. Match that structure rather than inventing a second one.

- [ ] **Step 4: Point the RFID tab at it**

In `RfidPanel.kt`, replace the existing region row's body so it names the active region when one is known and otherwise says the reader's own setting applies, and add to the row's blurb that the region is set on the Admin tab. Do not put a control here.

- [ ] **Step 5: Write the docs**

In `Android_Kiosk_App/README.md`, add a sentence to the RFID section saying the regulatory region is set on the Admin tab, that the list comes from the sled itself, and that a region-locked model offers only its own region.

In `docs/superpowers/specs/2026-09-16-android-rfd40-region-design.md`, add an "Implementation notes" section at the end recording anything that turned out differently from this plan, including any vendor name that `javap` contradicted, and stating plainly that no physical sled has verified any of it.

- [ ] **Step 6: Run everything and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App docs/superpowers/specs/2026-09-16-android-rfd40-region-design.md
git commit -m "feat(android): an admin can set the RFD40's regulatory region

The row lives on the Admin tab because region is a compliance setting, not a
preference. Its list comes from the sled, so a locked model states its one
region and a worldwide model offers all of its own.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
