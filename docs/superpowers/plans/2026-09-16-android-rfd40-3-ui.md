# RFD40 RFID — Part 3: the live panel, the Settings tab, and the developer burst

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the operator what the sweep is finding, queue it when the trigger comes up, and put every reader setting somewhere sensible.

**Architecture:** `ScanViewModel` collects the controller's bursts and queues them through the outbox path it already owns, so an RFID row differs from a typed row only in its `scan_type`. The Scanning screen arms the controller while it is composed, the same way it collects the scan bus. A seventh Settings tab holds the reader.

**Tech Stack:** Jetpack Compose, Robolectric Compose tests, kotlinx coroutines.

## Global Constraints

Everything in `.superpowers/sdd/global-constraints.md` applies, plus the constraints listed in Parts 1 and 2. In addition:

- Parts 1 and 2 must be complete.
- The scan-screen rules in the global constraints apply to RFID too: the SCREEN arms the controller in a `LaunchedEffect`, the ViewModel never does. Every outbox write is wrapped with the `CancellationException` rethrow and the `storageError` fallback.
- Touch targets stay at or above 48 dp and nothing may assume a width above 360 dp.

---

### Task 9: Queue a burst from the Scanning screen's ViewModel

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/scan/ScanViewModel.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/scan/ScanViewModelRfidTest.kt`

**Interfaces:**
- Consumes: `RfidController.bursts` from Part 2.
- Produces: on `ScanViewModel`, `fun onBurst(values: List<String>)`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/ui/screens/scan/ScanViewModelRfidTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.scan

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.RoomOutboxStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanViewModelRfidTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Copied from ScanViewModelTest: Room's DAO calls hop onto a real
     *  executor thread, so each round needs a short real sleep. */
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { Thread.sleep(50); runCurrent() } }

    private suspend fun kotlinx.coroutines.test.TestScope.build(): ScanViewModel {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Tagged rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "rfid.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val outbox = Outbox(RoomOutboxStore(db.outbox()), api, Identity(prefs), backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope)
        settle()
        return vm
    }

    @Test fun everyTagInABurstIsQueuedAsAnRfidScan() = runTest {
        val vm = build()
        vm.onBurst(listOf("000000000000000000100348", "100999")); settle()

        val rows = vm.outboxSnapshot.value.rows
        assertEquals(2, rows.size)
        assertEquals(listOf("rfid", "rfid"), rows.map { it.scanType })
        // The known tag matched; the unknown one is a No match, exactly as a
        // typed value would be.
        val byValue = rows.associateBy { it.scannedValue }
        assertEquals("Tagged rack", byValue["000000000000000000100348"]?.asset?.name)
        assertEquals(OutboxStatus.NOMATCH, byValue["100999"]?.status)
    }

    @Test fun anEmptyBurstQueuesNothingAndSaysNothing() = runTest {
        val vm = build()
        vm.onBurst(emptyList()); settle()
        assertEquals(0, vm.outboxSnapshot.value.rows.size)
        assertEquals(null, vm.state.value.error)
    }

    @Test fun aBurstBeforeKioskSetupIsFinishedSaysSoRatherThanDroppingIt() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "empty.preferences_pb") })
        val api = FakeKioskApi()
        val outbox = Outbox(RoomOutboxStore(db.outbox()), api, Identity(prefs), backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope)
        settle()
        vm.onBurst(listOf("100348")); settle()
        assertEquals(NO_MOVE_DATA, vm.state.value.error)
        assertEquals(0, vm.outboxSnapshot.value.rows.size)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.scan.ScanViewModelRfidTest'
```

Expected: FAIL to compile, `Unresolved reference: onBurst`.

- [ ] **Step 3: Add the burst commit**

In `app/src/main/java/com/serversherpa/kiosk/ui/screens/scan/ScanViewModel.kt`, add this method immediately after `fun onScan(raw: String)`:

```kotlin
    /**
     * A finished RFID sweep. The controller has already reduced it to each tag
     * once, so this does what `onScan` does, in a single pass: match locally,
     * queue, and give one piece of feedback for the whole burst rather than one
     * per tag. Fifty flashes and fifty beeps is not feedback, it is a strobe.
     */
    fun onBurst(values: List<String>) {
        if (values.isEmpty()) return
        val idx = index
        val sel = setup
        val a = appearance
        if (idx == null || sel == null || _state.value.rosterSize == 0) {
            flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND)
            _state.update { it.copy(error = NO_MOVE_DATA) }
            return
        }
        scope.launch {
            var matched = 0
            try {
                for (value in values) {
                    val hit = matchScan(idx, value)
                    if (hit != null) matched++
                    outbox.enqueue(EnqueueInput(
                        scannedValue = value, scanType = "rfid",
                        asset = hit?.asset?.toOutboxAsset(), siteId = sel.siteId,
                        initiativeId = sel.initiativeId, scanStatus = sel.scanStatus,
                    ))
                }
                _state.update { it.copy(storageError = null) }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) { _state.update { it.copy(storageError = STORAGE_ERROR) } }
            if (matched > 0) {
                flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD)
            } else {
                flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND)
            }
        }
    }
```

Note: `scanType` is the literal `"rfid"` rather than `scanTypeFor(hit.kind)`, because an unmatched tag has no `hit` to ask and it is still an RFID read.

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.scan.ScanViewModelRfidTest'
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): a finished RFID sweep queues through the outbox path scanning already owns

Each tag is matched locally and queued with scan_type rfid, matched or not, so
an RFID row differs from a typed row only in its type. One flash and one sound
for the whole burst: fifty of each is a strobe, not feedback.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The live panel on the Scanning screen

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/scan/RfidReadPanel.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/scan/ScanScreen.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/scan/RfidReadPanelTest.kt`

**Interfaces:**
- Consumes: `RfidReadSession`, `RepeatSweepPolicy`, `RfidController`.
- Produces: `@Composable fun RfidReadPanel(session: RfidReadSession, showSkipped: Boolean, onStop: () -> Unit)`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/ui/screens/scan/RfidReadPanelTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.onTagRead
import com.serversherpa.kiosk.core.rfid.startSession
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class RfidReadPanelTest {
    @get:Rule val compose = createComposeRule()

    private fun session(vararg epcs: String, queued: Set<String> = emptySet(), policy: RepeatSweepPolicy = RepeatSweepPolicy.ALWAYS_QUEUE) =
        epcs.fold(startSession(0)) { s, e -> onTagRead(s, e, queued, policy) }

    @Test fun showsUniqueAndTotalAndTheTagsItHasSeen() {
        compose.setContent {
            KioskTheme { RfidReadPanel(session("100348", "100349", "100348"), showSkipped = false, onStop = {}) }
        }
        compose.onNodeWithText("2").assertIsDisplayed()          // unique
        compose.onNodeWithText("3 reads").assertIsDisplayed()    // total
        compose.onNodeWithText("100349").assertIsDisplayed()     // newest first
    }

    @Test fun countsSkippedRepeatsOnlyWhenThePolicyAsksForIt() {
        val s = session("100348", "100350", queued = setOf("100348"), policy = RepeatSweepPolicy.SKIP_AND_COUNT)
        assertEquals(1, s.skippedRepeats)
        compose.setContent { KioskTheme { RfidReadPanel(s, showSkipped = true, onStop = {}) } }
        compose.onNodeWithText("1 already sent").assertIsDisplayed()
    }

    @Test fun theStopButtonReportsBack() {
        var stopped = 0
        compose.setContent { KioskTheme { RfidReadPanel(session("100348"), showSkipped = false, onStop = { stopped++ }) } }
        compose.onNodeWithText("Stop").performClick()
        assertEquals(1, stopped)
    }

    @Test fun aBurstThatHasFoundNothingYetStillReadsAsReading() {
        compose.setContent { KioskTheme { RfidReadPanel(startSession(0), showSkipped = false, onStop = {}) } }
        compose.onNodeWithText("Reading…").assertIsDisplayed()
        compose.onNodeWithText("0").assertIsDisplayed()
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.scan.RfidReadPanelTest'
```

Expected: FAIL to compile, `Unresolved reference: RfidReadPanel`.

- [ ] **Step 3: Write the panel**

Create `app/src/main/java/com/serversherpa/kiosk/ui/screens/scan/RfidReadPanel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.core.rfid.RfidReadSession
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** How many tag chips the strip shows. The rest are counted, not listed. */
private const val CHIPS = 12

/**
 * What a sweep looks like while it is happening: the unique count large enough
 * to read at arm's length, the total beside it so a chatty read is obvious, and
 * the newest tags streaming past. It sits where the scan box sits, so the
 * outbox list below never moves and the queued rows appear where the operator
 * is already looking.
 */
@Composable
fun RfidReadPanel(session: RfidReadSession, showSkipped: Boolean, onStop: () -> Unit) {
    val c = LocalKioskColors.current
    Column(
        Modifier.fillMaxWidth()
            .background(c.paper, RoundedCornerShape(14.dp))
            .border(2.dp, c.accent, RoundedCornerShape(14.dp))
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                session.uniqueCount.toString(),
                fontSize = 44.sp, fontWeight = FontWeight.Bold, color = c.accent,
            )
            Column(Modifier.weight(1f)) {
                Text("Reading…", style = MaterialTheme.typography.titleMedium, color = c.textDark)
                Text(
                    buildString {
                        append("${session.totalReads} reads")
                        if (showSkipped && session.skippedRepeats > 0) append(" · ${session.skippedRepeats} already sent")
                    },
                    fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute,
                )
            }
            MiniButton("Stop", onStop)
        }
        if (session.tags.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (tag in session.tags.asReversed().take(CHIPS)) {
                    Text(
                        displayRfid(tag.epc),
                        fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textDark,
                        modifier = Modifier.background(c.paper2, RoundedCornerShape(999.dp))
                            .border(1.dp, c.paperLine, RoundedCornerShape(999.dp))
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}
```

- [ ] **Step 4: Run the panel test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.scan.RfidReadPanelTest'
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into the screen**

In `app/src/main/java/com/serversherpa/kiosk/ui/screens/scan/ScanScreen.kt`, add these imports:

```kotlin
import androidx.compose.runtime.DisposableEffect
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
```

Inside `ScanScreen`, after the existing `val setup by ...` line, add:

```kotlin
    val rfidSession by container.rfid.session.collectAsStateWithLifecycle()
    val rfidSettings by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
```

After the existing `LaunchedEffect(Unit) { container.scanBus.events.collect { vm.onScan(it.value) } }`, add these two effects:

```kotlin
    // A finished sweep queues here, beside the typed and barcode commits.
    LaunchedEffect(Unit) { container.rfid.bursts.collect { vm.onBurst(it) } }

    // The sled reads only while this screen is on top, the same rule the scan
    // bus follows. Leaving stops a read in progress.
    DisposableEffect(Unit) {
        container.rfid.arm()
        onDispose { container.rfid.disarm() }
    }
```

Replace the `ScanInput(...)` call and its `trailingIcon` block with a conditional, so the panel takes the scan box's place while a burst runs:

```kotlin
        val burst = rfidSession
        if (burst != null) {
            RfidReadPanel(
                session = burst,
                showSkipped = rfidSettings.repeatPolicy == RepeatSweepPolicy.SKIP_AND_COUNT,
                onStop = { container.rfid.stopBurst() },
            )
        } else {
            ScanInput(
                ui.value, vm::setValue, onSubmit = { vm.onScan(it) },
                placeholder = "Scan or type an asset ID, serial, or tag", enabled = !disabled, keepFocus = !camera,
                trailingIcon = if (container.hasCamera) ({ CameraFieldButton(!disabled) { camera = true } }) else null,
            )
        }
```

- [ ] **Step 6: Run everything and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): the live RFID read panel on the Scanning screen

While the trigger is down, the unique count sits where the scan box sits, big
enough to read at arm's length, with the total beside it and the newest tags
streaming past. The outbox list below never moves, so queued rows appear where
the operator is already looking. The sled reads only while this screen is on
top, the same rule the scan bus follows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The RFID tab in Settings

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/settings/SettingsTabs.kt`
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/RfidPanel.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/SettingsScreen.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/DevicesPanel.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/RfidPanelTest.kt`
- Test: modify `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/core/settings/SettingsTabsTest.kt` if it asserts an exact tab list

**Interfaces:**
- Consumes: `RfidSettings`, `connectionLine`, `RfidPermissions`, `container.rfid`.
- Produces: `SettingsTabId.RFID`, `@Composable fun RfidPanel()`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/RfidPanelTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.settings.SETTINGS_TABS
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.core.settings.visibleTabs
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class RfidPanelTest {
    @get:Rule val compose = createComposeRule()

    @Test fun theTabExistsForAnyoneSignedInAndNotWhenSignedOut() {
        assertTrue(SETTINGS_TABS.any { it.id == SettingsTabId.RFID })
        assertTrue(visibleTabs(isAdmin = false, isDeveloper = false, signedIn = true).any { it.id == SettingsTabId.RFID })
        assertTrue(visibleTabs(isAdmin = false, isDeveloper = false, signedIn = false).none { it.id == SettingsTabId.RFID })
    }

    @Test fun theReaderIsOffUntilSomeoneTurnsItOn() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { RfidPanel() } } }
        compose.onNodeWithText("Off. Turn the reader on to use the sled.").assertIsDisplayed()
    }

    @Test fun pickingATriggerModeWritesIt() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { RfidPanel() } } }
        compose.onNodeWithText("Click to start and stop").performClick()
        compose.waitForIdle()
        assertEquals(RfidTriggerMode.TOGGLE, runBlocking { c.prefs.rfid.first() }.triggerMode)
    }

    @Test fun restoreDefaultsPutsEverythingBack() {
        val c = testContainer()
        runBlocking { c.prefs.setRfid(com.serversherpa.kiosk.core.rfid.RfidSettings(enabled = true, powerDbm = 9)) }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { RfidPanel() } } }
        compose.onNodeWithText("Restore defaults").performClick()
        compose.waitForIdle()
        assertEquals(27, runBlocking { c.prefs.rfid.first() }.powerDbm)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.settings.RfidPanelTest'
```

Expected: FAIL to compile, `Unresolved reference: RFID`.

- [ ] **Step 3: Add the tab**

In `app/src/main/java/com/serversherpa/kiosk/core/settings/SettingsTabs.kt`, add `RFID("rfid")` to the enum after `DEVICES("devices")`:

```kotlin
enum class SettingsTabId(val wire: String) {
    APPEARANCE("appearance"), SOUND("sound"), DEVICES("devices"), RFID("rfid"), THIS_KIOSK("this-kiosk"),
    ADMIN("admin"), DEVELOPER("developer");

    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}
```

and the tab itself to `SETTINGS_TABS`, after the Devices entry:

```kotlin
    SettingsTab(SettingsTabId.RFID, "RFID", "The RFID reader attached to this kiosk."),
```

- [ ] **Step 4: Write the panel**

Create `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/RfidPanel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RFID_POPULATION_MAX
import com.serversherpa.kiosk.core.rfid.RFID_POPULATION_MIN
import com.serversherpa.kiosk.core.rfid.RFID_POWER_MAX
import com.serversherpa.kiosk.core.rfid.RFID_POWER_MIN
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.connectionLine
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.launch

/** The RFD40: whether it is on, how its trigger behaves, and how its radio is set. */
@Composable
fun RfidPanel() {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val s by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
    val connection by container.rfid.connection.collectAsStateWithLifecycle()
    val applyError by container.rfid.applyError.collectAsStateWithLifecycle()
    fun save(next: RfidSettings) { scope.launch { container.prefs.setRfid(next) } }

    Column {
        SettingsRow("RFID reader", "A Zebra RFD40 paired to this device over Bluetooth.") {
            Column {
                Row {
                    Switch(checked = s.enabled, onCheckedChange = { on ->
                        save(s.copy(enabled = on))
                        if (!on) scope.launch { container.rfid.disconnectNow() }
                    })
                }
                Text(if (s.enabled) connectionLine(connection) else connectionLine(RfidConnection.Disabled), color = c.textMute)
                if (s.enabled && RfidPermissions.missing(context).isNotEmpty()) {
                    Text("Android needs Bluetooth and location permission before the sled can connect. Grant them in this app's settings.", color = c.textMute)
                }
                // A setting the radio refused: say so rather than leaving a number
                // on screen that the reader never took.
                applyError?.let { Text("The reader refused a setting: $it", color = ChipTone.RED.text) }
                if (s.enabled) Row(Modifier.padding(top = 8.dp)) {
                    if (connection is RfidConnection.Connected) MiniButton("Disconnect", { scope.launch { container.rfid.disconnectNow() } })
                    else MiniButton("Connect", { scope.launch { container.rfid.connectNow() } })
                }
            }
        }
        SettingsRow("Trigger", s.triggerMode.hint) {
            Segmented(RfidTriggerMode.entries.map { it.wire to it.label }, s.triggerMode.wire) { w ->
                RfidTriggerMode.fromWire(w)?.let { save(s.copy(triggerMode = it)) }
            }
        }
        SettingsRow("Repeat sweeps", s.repeatPolicy.hint) {
            Segmented(RepeatSweepPolicy.entries.map { it.wire to it.label }, s.repeatPolicy.wire) { w ->
                RepeatSweepPolicy.fromWire(w)?.let { save(s.copy(repeatPolicy = it)) }
            }
        }
        SettingsRow("Sled beeper", "The reader's own beep on each tag. Off is its quiet setting.") {
            Segmented(SledBeeper.entries.map { it.wire to it.label }, s.beeper.wire) { w ->
                SledBeeper.fromWire(w)?.let { save(s.copy(beeper = it)) }
            }
        }
        SettingsRow("Transmit power", "How far the reader reaches. Lower it if a sweep is picking up the next rack.") {
            Column {
                Text("${s.powerDbm} dBm", fontFamily = FragmentMono)
                Slider(
                    value = s.powerDbm.toFloat(),
                    onValueChange = { save(s.copy(powerDbm = it.toInt())) },
                    valueRange = RFID_POWER_MIN.toFloat()..RFID_POWER_MAX.toFloat(),
                    steps = RFID_POWER_MAX - RFID_POWER_MIN - 1,
                )
            }
        }
        SettingsRow("Session", "Higher sessions keep a tag quiet longer after it answers.") {
            Segmented(RfidSession.entries.map { it.wire to it.label }, s.session.wire) { w ->
                RfidSession.fromWire(w)?.let { save(s.copy(session = it)) }
            }
        }
        SettingsRow("Tag population", "Roughly how many tags are in front of the reader at once.") {
            Column {
                Text("${s.tagPopulation}", fontFamily = FragmentMono)
                Slider(
                    value = s.tagPopulation.toFloat(),
                    onValueChange = { save(s.copy(tagPopulation = it.toInt())) },
                    valueRange = RFID_POPULATION_MIN.toFloat()..RFID_POPULATION_MAX.toFloat(),
                )
            }
        }
        SettingsRow("Report each tag once", "The reader reports a tag once per sweep instead of repeatedly.") {
            Switch(checked = s.uniqueTagReport, onCheckedChange = { save(s.copy(uniqueTagReport = it)) })
        }
        SettingsRow("Blink on read", "The sled's light blinks when it reads a tag.") {
            Switch(checked = s.ledOnRead, onCheckedChange = { save(s.copy(ledOnRead = it)) })
        }
        SettingsRow("Dynamic power optimization", "Saves battery during a long sweep.") {
            Switch(checked = s.dpo, onCheckedChange = { save(s.copy(dpo = it)) })
        }
        SettingsRow("Region", "Left as the reader has it. Set the region with Zebra's own tools.") {
            Text(s.region ?: "The reader's own setting", color = c.textMute)
        }
        MiniButton("Restore defaults", { save(DEFAULT_RFID_SETTINGS.copy(enabled = s.enabled)) })
    }
}
```

- [ ] **Step 5: Render the tab and add the Devices row**

In `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/SettingsScreen.kt`, add to the `when (active.id)` block, after the `DEVICES` line:

```kotlin
            SettingsTabId.RFID -> RfidPanel()
```

In `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/DevicesPanel.kt`, add these imports:

```kotlin
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.connectionLine
```

and inside the `Column`, after the DataWedge row:

```kotlin
        val rfidSettings by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
        val rfid by container.rfid.connection.collectAsStateWithLifecycle()
        SettingsRow("RFID reader", "A Zebra RFD40 sled. Its settings live on the RFID tab.") {
            Text(if (rfidSettings.enabled) connectionLine(rfid) else connectionLine(RfidConnection.Disabled))
        }
```

- [ ] **Step 6: Run everything and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL. If an existing settings test asserts an exact tab count or list, update it to include RFID rather than loosening the assertion.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): an RFID tab in Settings for the RFD40

Connection and battery, the three trigger modes, the repeat-sweep policy, the
sled beeper, and the radio settings, with Restore defaults. Devices keeps its
read-only character and gains one row pointing here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: A synthetic burst for the Developer tab, and the docs

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/DeveloperPanel.kt`
- Modify: `Android_Kiosk_App/README.md`
- Modify: `docs/superpowers/specs/2026-09-16-android-rfd40-rfid-design.md`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/DeveloperRfidBurstTest.kt`

**Interfaces:**
- Consumes: `FakeRfidReader`, `container.rfidReader`, `container.rfid`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/DeveloperRfidBurstTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class DeveloperRfidBurstTest {
    @get:Rule val compose = createComposeRule()

    /** The point of the control: prove the RFID path on a phone with no sled. */
    @Test fun theSyntheticBurstRunsAnInventoryOnTheFakeReader() {
        val c = testContainer()
        runBlocking { c.prefs.setDevMode(true) }
        c.rfid.start(); c.rfid.arm()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { DeveloperPanel() } } }
        compose.onNodeWithText("Simulate an RFID sweep").performClick()
        compose.waitForIdle()
        Thread.sleep(200)
        val fake = c.rfidReader as FakeRfidReader
        assertTrue("the fake should have been driven", fake.connectCalls > 0)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.settings.DeveloperRfidBurstTest'
```

Expected: FAIL, the node "Simulate an RFID sweep" does not exist.

- [ ] **Step 3: Add the control**

In `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/DeveloperPanel.kt`, add the imports:

```kotlin
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import kotlinx.coroutines.delay
```

and add this row inside the `if (devMode)` section, alongside the other developer tools:

```kotlin
        val fakeReader = container.rfidReader as? FakeRfidReader
        if (fakeReader != null) {
            SettingsRow("Simulate an RFID sweep", "Fires a burst of tags through the reader path so the Scanning screen's panel and its queueing can be checked with no sled attached.") {
                MiniButton("Simulate an RFID sweep", {
                    scope.launch {
                        fakeReader.connect()
                        fakeReader.emitTrigger(TriggerEvent.PRESSED)
                        for (tag in listOf("100348", "100349", "100350", "100348")) {
                            fakeReader.emitTag(tag)
                            delay(120)
                        }
                        fakeReader.emitTrigger(TriggerEvent.RELEASED)
                    }
                })
            }
        }
```

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.settings.DeveloperRfidBurstTest'
```

Expected: PASS.

- [ ] **Step 5: Write the docs**

In `Android_Kiosk_App/README.md`, add to the scan-input section, after the Zebra DataWedge bullet:

```markdown
- **Zebra RFD40 (UHF RFID):** pair the sled in Android's Bluetooth settings, then turn the reader on under Settings › RFID. Pulling the trigger sweeps; the Scanning screen shows unique and total counts while it reads, and every unique tag queues to the outbox when the trigger comes up. The trigger mode, the repeat-sweep policy, the sled's beeper and the radio settings are all on that tab. RFID reading works on the Scanning screen only.
- **Zebra RFID library:** `RFIDAPI3Library/API3_LIB-release.aar` is a hand-placed Zebra artifact, not a Gradle dependency. The committed copy is 2.0.2.82 from Zebra's public sample repo. Replace it with the current release from Zebra's RFID SDK for Android download page, keeping the same file name, before trusting the sled on a floor.
```

In `docs/superpowers/specs/2026-09-16-android-rfd40-rfid-design.md`, append a section at the end:

```markdown
## Implementation notes (2026-09-16)

- Leaving the Scanning screen mid-sweep stops the inventory and DISCARDS the partial burst, rather than queueing it: the screen that commits the tags is gone. A reader that disconnects mid-sweep still queues what it read, because the operator is still standing there.
- `RfidBurst.kt` needs no filtering of its own: the repeat-sweep policy is applied as tags arrive, so a finished burst is simply its tags in first-seen order.
- The sled beeper is one control with four choices rather than a switch plus a volume slider, because Zebra models it that way and its quiet setting is the off state.
- `scan_type` is the literal `"rfid"` for every tag in a burst, matched or not: an unmatched tag has no match to ask for its kind and is still an RFID read.
- Region is read-only this pass. The spec described a chooser fed by the reader's own `getRegionInfo()`; the tab instead reports that the reader's own regulatory setting is left alone, and Zebra's tools set it. A wrong region is a legal problem, not a convenience one, and it does not belong behind a kiosk dropdown until someone asks for it.
- A settings push the reader refuses surfaces as a line on the RFID tab. The spec said the row would revert to the reader's value; reading every value back after each push costs a radio round trip per control, so the tab reports the refusal and leaves the operator to change it.
- A reader the operator turned on reconnects when the app comes to the foreground, so nobody visits Settings to start a shift.
```

- [ ] **Step 6: Run the whole suite and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App docs/superpowers/specs/2026-09-16-android-rfd40-rfid-design.md
git commit -m "feat(android): a synthetic RFID sweep for the Developer tab, and the docs

The whole RFID path can be exercised on a phone with no sled: the button drives
the fake reader through a real burst, so the live panel and the outbox commit
are checkable anywhere. README says how to pair a sled and how to replace the
vendor library.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the plan

Live verification on the Pixel with the RFD40 attached, which no test can stand in for:

1. Pair the sled in Android's Bluetooth settings, turn the reader on under Settings › RFID, and confirm it connects and shows a battery level.
2. Sweep a rack. Confirm the unique count and the total move, and that the counts differ when tags answer repeatedly.
3. Release and confirm the queued rows appear in the outbox list and reach the portal.
4. Try each trigger mode, including the latch boundary.
5. Lower the transmit power and confirm the read field narrows.
6. Walk off the Scanning screen mid-sweep and confirm the reader stops.
