# RFD40 RFID — Part 2: the reader, the controller, and the Zebra adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One interface for "a reader", a fake that drives every test, a controller that turns trigger events into inventories and bursts, and the single file that talks to Zebra.

**Architecture:** `RfidReader` is the only thing the app knows about a reader. `ZebraRfidReader` is the only file that imports `com.zebra.*`; its SDK callbacks arrive on a vendor background thread and do nothing but push onto flows. `RfidController` owns a reader, applies settings, and is armed only by the screen that is allowed to read.

**Tech Stack:** Kotlin coroutines and flows, Zebra RFIDAPI3, Robolectric for the Android-touching tests.

## Global Constraints

Everything in `.superpowers/sdd/global-constraints.md` applies, plus the constraints listed in Part 1 of this plan. In addition:

- Part 1 must be complete. This part consumes `RfidSettings`, `nextTriggerAction`, `RfidReadSession`, `burstToScans` and `queuedAfter`.
- `ZebraRfidReader.kt` is the ONLY file in the repository allowed to import `com.zebra.*`. If you find yourself wanting a Zebra type anywhere else, put a plain Kotlin type on the interface instead.
- The controller holds no Android types and no reference to assets, the roster, or the outbox. It produces tag values and stops there.

---

### Task 5: The reader interface, the connection model, and the fake

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidConnection.kt`
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidReader.kt`
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/FakeRfidReader.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidConnectionTest.kt`

**Interfaces:**
- Consumes: `RfidSettings`, `TriggerEvent` from Part 1.
- Produces: `sealed class RfidConnection` with `Disabled`, `Disconnected`, `Connecting`, `Connected(name, batteryPct)`, `Failed(reason)`; `fun connectionLine(c: RfidConnection): String`; `interface RfidReader`; `class FakeRfidReader : RfidReader` with `emitTrigger`, `emitTag`, `setConnection`, and the readable properties `applied`, `inventoryRunning`, `connectCalls`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidConnectionTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidConnectionTest {
    @Test fun eachStateReadsAsASentenceAnOperatorCanAct0n() {
        assertEquals("Off. Turn the reader on to use the sled.", connectionLine(RfidConnection.Disabled))
        assertEquals("Not connected.", connectionLine(RfidConnection.Disconnected))
        assertEquals("Connecting…", connectionLine(RfidConnection.Connecting))
        assertEquals("Connected to RFD4030 · battery 74%", connectionLine(RfidConnection.Connected("RFD4030", 74)))
        assertEquals("Connected to RFD4030", connectionLine(RfidConnection.Connected("RFD4030", null)))
        assertEquals("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.",
            connectionLine(RfidConnection.Failed("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.")))
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidConnectionTest'
```

Expected: FAIL to compile, `Unresolved reference: RfidConnection`.

- [ ] **Step 3: Write the connection model**

Create `app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidConnection.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

/** Where the reader stands, in the one shape the whole app reads. */
sealed class RfidConnection {
    /** The operator has not turned the reader on. Nothing connects, and no
     *  permission is asked for, while this is the state. */
    data object Disabled : RfidConnection()
    data object Disconnected : RfidConnection()
    data object Connecting : RfidConnection()
    data class Connected(val name: String, val batteryPct: Int?) : RfidConnection()
    /** Carries a sentence the operator can act on, not an SDK code. */
    data class Failed(val reason: String) : RfidConnection()
}

fun connectionLine(c: RfidConnection): String = when (c) {
    RfidConnection.Disabled -> "Off. Turn the reader on to use the sled."
    RfidConnection.Disconnected -> "Not connected."
    RfidConnection.Connecting -> "Connecting…"
    is RfidConnection.Connected -> if (c.batteryPct == null) "Connected to ${c.name}" else "Connected to ${c.name} · battery ${c.batteryPct}%"
    is RfidConnection.Failed -> c.reason
}
```

- [ ] **Step 4: Write the interface**

Create `app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidReader.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Everything the app knows about an RFID reader. One implementation talks to
 * Zebra; the other is a fake. Nothing above this interface knows which it has,
 * which is what lets the whole feature be tested with no sled attached.
 *
 * Implementations must deliver `tags` and `triggers` on a normal coroutine
 * dispatcher, never on a vendor callback thread.
 */
interface RfidReader {
    val connection: StateFlow<RfidConnection>
    /** EPCs, as the reader reported them. */
    val tags: Flow<String>
    val triggers: Flow<TriggerEvent>

    suspend fun connect(): Result<Unit>
    suspend fun disconnect()
    suspend fun apply(settings: RfidSettings): Result<Unit>
    suspend fun startInventory(): Result<Unit>
    suspend fun stopInventory(): Result<Unit>
}
```

- [ ] **Step 5: Write the fake**

Create `app/src/main/java/com/serversherpa/kiosk/input/rfid/FakeRfidReader.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * A reader with no hardware behind it. It drives every test, and the Developer
 * tab uses it to fire a synthetic burst so the live panel and the outbox commit
 * can be exercised on a phone with no sled.
 *
 * It ships in `main`, not `test`, for exactly that reason.
 */
class FakeRfidReader(name: String = "Fake RFD40") : RfidReader {
    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 256)
    override val tags: SharedFlow<String> = _tags

    private val _triggers = MutableSharedFlow<TriggerEvent>(extraBufferCapacity = 16)
    override val triggers: SharedFlow<TriggerEvent> = _triggers

    private val readerName = name

    /** The settings last handed to the reader, for a test to assert on. */
    var applied: RfidSettings? = null
        private set
    var inventoryRunning: Boolean = false
        private set
    var connectCalls: Int = 0
        private set

    /** Set these to make the next connect or apply fail. */
    var connectResult: Result<Unit> = Result.success(Unit)
    var applyResult: Result<Unit> = Result.success(Unit)

    override suspend fun connect(): Result<Unit> {
        connectCalls++
        _connection.value = RfidConnection.Connecting
        return connectResult.onSuccess { _connection.value = RfidConnection.Connected(readerName, 80) }
            .onFailure { _connection.value = RfidConnection.Failed(it.message ?: "Couldn't connect to the reader.") }
    }

    override suspend fun disconnect() {
        inventoryRunning = false
        _connection.value = RfidConnection.Disconnected
    }

    override suspend fun apply(settings: RfidSettings): Result<Unit> {
        applied = settings
        return applyResult
    }

    override suspend fun startInventory(): Result<Unit> {
        inventoryRunning = true
        return Result.success(Unit)
    }

    override suspend fun stopInventory(): Result<Unit> {
        inventoryRunning = false
        return Result.success(Unit)
    }

    // ── what a test or the Developer tab drives ──
    fun emitTrigger(event: TriggerEvent) { _triggers.tryEmit(event) }
    fun emitTag(epc: String) { _tags.tryEmit(epc) }
    fun setConnection(c: RfidConnection) { _connection.value = c }
}
```

- [ ] **Step 6: Run the test and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL. `CorePurityTest` must still pass: `RfidConnection.kt` is in `core/` and imports nothing from Android.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): one RfidReader interface, a connection model, and a fake reader

The app knows a reader only through this interface, so the whole RFID feature
can be built and tested with no sled attached. The fake ships in main because
the Developer tab uses it to fire a synthetic burst.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The controller

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidController.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidControllerTest.kt`

**Interfaces:**
- Consumes: `RfidReader`, `FakeRfidReader`, `RfidSettings`, `nextTriggerAction`, `startSession`, `onTagRead`, `burstToScans`, `queuedAfter`.
- Produces: `class RfidController(reader, settings: Flow<RfidSettings>, scope: CoroutineScope, clock: () -> Long = System::currentTimeMillis)` with `val connection: StateFlow<RfidConnection>`, `val session: StateFlow<RfidReadSession?>`, `val bursts: SharedFlow<List<String>>`, `val applyError: StateFlow<String?>`, `fun start()`, `fun arm()`, `fun disarm()`, `fun stopBurst()`, `suspend fun connectNow(): Result<Unit>`, `suspend fun disconnectNow()`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidControllerTest.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RfidControllerTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { runCurrent() } }

    private class Rig(val scope: kotlinx.coroutines.CoroutineScope) {
        val reader = FakeRfidReader()
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        var now = 0L
        val controller = RfidController(reader, settings, scope) { now }
    }

    @Test fun aHeldTriggerRunsAnInventoryAndQueuesItsTagsOnRelease() = runTest {
        val r = Rig(backgroundScope)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue("inventory should be running", r.reader.inventoryRunning)
        assertEquals(0, r.controller.session.value?.uniqueCount)

        r.reader.emitTag("100348"); r.reader.emitTag("100349"); r.reader.emitTag("100348"); settle()
        assertEquals(3, r.controller.session.value?.totalReads)
        assertEquals(2, r.controller.session.value?.uniqueCount)

        r.now = 1_200
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertNull("the panel closes when the burst ends", r.controller.session.value)
        assertEquals(listOf(listOf("100348", "100349")), bursts)
    }

    /** The rule the whole app follows: a read never lands on a screen that is
     *  not on top. Only the Scanning screen arms this. */
    @Test fun aTriggerDoesNothingWhileDisarmed() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertNull(r.controller.session.value)
    }

    @Test fun leavingTheScreenStopsAReadInProgress() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); r.controller.arm(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); settle()
        r.controller.disarm(); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertNull(r.controller.session.value)
    }

    @Test fun theStopButtonEndsALatchedReadAndStillQueues() = runTest {
        val r = Rig(backgroundScope)
        r.settings.value = DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerMode = RfidTriggerMode.TOGGLE)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        r.reader.emitTag("100350"); settle()
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertTrue("toggle keeps reading after the trigger comes up", r.reader.inventoryRunning)

        r.controller.stopBurst(); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertEquals(listOf(listOf("100350")), bursts)
    }

    @Test fun aSecondSweepSkipsTagsAlreadySentWhenThePolicySaysSo() = runTest {
        val r = Rig(backgroundScope)
        r.settings.value = DEFAULT_RFID_SETTINGS.copy(enabled = true, repeatPolicy = RepeatSweepPolicy.SKIP_AND_COUNT)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); settle()
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); r.reader.emitTag("100351"); settle()
        assertEquals(1, r.controller.session.value?.skippedRepeats)
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()

        assertEquals(listOf(listOf("100348"), listOf("100351")), bursts)
    }

    @Test fun aDisconnectMidBurstStillQueuesWhatWasRead() = runTest {
        val r = Rig(backgroundScope)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); settle()

        r.reader.setConnection(RfidConnection.Failed("The reader disconnected.")); settle()
        assertNull(r.controller.session.value)
        assertEquals(listOf(listOf("100348")), bursts)
    }

    @Test fun settingsReachTheReaderOnConnectAndOnEveryChange() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals(27, r.reader.applied?.powerDbm)

        r.settings.value = RfidSettings(enabled = true, powerDbm = 12); settle()
        assertEquals(12, r.reader.applied?.powerDbm)
        assertNull("a setting the reader took leaves no complaint", r.controller.applyError.value)
    }

    /** A reader that refuses a setting must say so rather than leaving the
     *  operator looking at a number the radio never took. */
    @Test fun aSettingTheReaderRefusesIsReported() = runTest {
        val r = Rig(backgroundScope)
        r.reader.applyResult = Result.failure(IllegalStateException("Power out of range."))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals("Power out of range.", r.controller.applyError.value)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.RfidControllerTest'
```

Expected: FAIL to compile, `Unresolved reference: RfidController`.

- [ ] **Step 3: Write the controller**

Create `app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidController.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidReadSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerAction
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.burstToScans
import com.serversherpa.kiosk.core.rfid.nextTriggerAction
import com.serversherpa.kiosk.core.rfid.onTagRead
import com.serversherpa.kiosk.core.rfid.queuedAfter
import com.serversherpa.kiosk.core.rfid.startSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Owns one reader. Turns trigger events into inventories using whichever
 * trigger mode is set, accumulates the burst, and emits the tags to queue when
 * it ends.
 *
 * It knows nothing about assets, the roster, or the outbox: it produces tag
 * values and stops there. `ScanViewModel` does the matching and the queueing,
 * so the RFID commit rules sit beside the barcode commit rules.
 */
class RfidController(
    private val reader: RfidReader,
    private val settings: Flow<RfidSettings>,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    val connection: StateFlow<RfidConnection> = reader.connection

    private val _session = MutableStateFlow<RfidReadSession?>(null)
    /** Non-null only while a burst is running. The Scanning screen's live panel. */
    val session: StateFlow<RfidReadSession?> = _session

    private val _bursts = MutableSharedFlow<List<String>>(extraBufferCapacity = 16)
    /** One emission per finished burst: the tags to queue, in read order. */
    val bursts: SharedFlow<List<String>> = _bursts

    private val _applyError = MutableStateFlow<String?>(null)
    /** Why the reader refused the last settings push, for the RFID tab to show.
     *  Null once a push succeeds. */
    val applyError: StateFlow<String?> = _applyError

    @Volatile private var current: RfidSettings = DEFAULT_RFID_SETTINGS
    @Volatile private var armed: Boolean = false
    private var queued: Set<String> = emptySet()
    private var pressedAtMs: Long = 0L

    fun start() {
        scope.launch {
            settings.collect { s ->
                val changed = s != current
                current = s
                if (changed && reader.connection.value is RfidConnection.Connected) push(s)
            }
        }
        scope.launch { reader.triggers.collect { onTrigger(it) } }
        scope.launch { reader.tags.collect { onTag(it) } }
        scope.launch {
            reader.connection.collect { c ->
                // A burst cannot survive the reader going away: end it where it
                // stopped and queue what was read rather than losing it.
                if (c !is RfidConnection.Connected && _session.value != null) endBurst(stopReader = false)
            }
        }
    }

    /** Only the Scanning screen calls this, while it is composed. */
    fun arm() { armed = true }

    /** Leaving the screen ends any read in progress. Its tags are dropped: the
     *  screen that would queue them is gone. */
    fun disarm() {
        armed = false
        if (_session.value != null) {
            _session.value = null
            scope.launch { runCatching { reader.stopInventory() } }
        }
    }

    /** The Stop button, for a latched or toggled read. */
    fun stopBurst() { if (_session.value != null) scope.launch { endBurst(stopReader = true) } }

    suspend fun connectNow(): Result<Unit> {
        val result = reader.connect()
        if (result.isSuccess) push(current)
        return result
    }

    private suspend fun push(s: RfidSettings) {
        _applyError.value = reader.apply(s).exceptionOrNull()?.message?.takeIf { it.isNotBlank() }
    }

    suspend fun disconnectNow() {
        _session.value = null
        reader.disconnect()
    }

    private suspend fun onTrigger(event: TriggerEvent) {
        if (!armed) return
        val reading = _session.value != null
        val heldMs = if (event == TriggerEvent.RELEASED) clock() - pressedAtMs else 0L
        if (event == TriggerEvent.PRESSED) pressedAtMs = clock()
        when (nextTriggerAction(current.triggerMode, event, reading, heldMs)) {
            TriggerAction.START -> {
                _session.value = startSession(clock())
                runCatching { reader.startInventory() }
            }
            TriggerAction.STOP -> endBurst(stopReader = true)
            TriggerAction.NONE -> Unit
        }
    }

    private fun onTag(epc: String) {
        val open = _session.value ?: return
        _session.value = onTagRead(open, epc, queued, current.repeatPolicy)
    }

    private suspend fun endBurst(stopReader: Boolean) {
        val done = _session.value ?: return
        _session.value = null
        if (stopReader) {
            try { reader.stopInventory() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { /* the reader is already gone; the tags still count */ }
        }
        queued = queuedAfter(queued, done)
        _bursts.tryEmit(burstToScans(done))
    }
}
```

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.RfidControllerTest'
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): the RFID controller — trigger to inventory to burst

It runs the trigger state machine against whichever mode is set, accumulates
the burst, and emits the tags to queue when the read ends. It is armed only by
the screen allowed to read, so a trigger pull elsewhere does nothing, and a
reader that disappears mid-burst still yields what it read.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Permissions and the container

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/AndroidManifest.xml`
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidPermissions.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/AppContainer.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidPermissionsTest.kt`

**Interfaces:**
- Consumes: `RfidController`, `FakeRfidReader`.
- Produces: `object RfidPermissions` with `val REQUIRED: List<String>`, `fun granted(context: Context): Boolean`, `fun missing(context: Context): List<String>`; on `AppContainer`: `val rfidReader: RfidReader` and `val rfid: RfidController`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidPermissionsTest.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RfidPermissionsTest {
    @Test fun theManifestDeclaresEveryPermissionTheSledNeeds() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val declared = context.packageManager
            .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions?.toSet().orEmpty()
        for (p in RfidPermissions.REQUIRED) {
            assertTrue("manifest is missing $p", declared.contains(p))
        }
        // Zebra's library needs location for its Bluetooth configuration on
        // Google reference platforms, which is not obvious from the API.
        assertTrue(declared.contains("android.permission.ACCESS_FINE_LOCATION"))
    }

    @Test fun nothingIsGrantedInAFreshTestApp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assertTrue(RfidPermissions.missing(context).isNotEmpty())
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.RfidPermissionsTest'
```

Expected: FAIL to compile, `Unresolved reference: RfidPermissions`.

- [ ] **Step 3: Declare the permissions**

In `app/src/main/AndroidManifest.xml`, add after the existing `uses-feature` line, before `<application`:

```xml
    <!-- The RFD40 pairs over Bluetooth. The legacy pair is capped at API 30
         because 31+ replaced them; ACCESS_FINE_LOCATION is what Zebra's library
         wants for its Bluetooth configuration on Google reference platforms. -->
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-feature android:name="android.hardware.bluetooth" android:required="false" />
```

- [ ] **Step 4: Write the permission helper**

Create `app/src/main/java/com/serversherpa/kiosk/input/rfid/RfidPermissions.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * What the sled needs before it can be connected. Asked for when the operator
 * turns the reader on in Settings, never at launch: a kiosk that will never see
 * a sled should never see a Bluetooth prompt.
 */
object RfidPermissions {
    val REQUIRED: List<String> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_CONNECT)
            add(Manifest.permission.BLUETOOTH_SCAN)
        }
        add(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    fun missing(context: Context): List<String> = REQUIRED.filter {
        ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
    }

    fun granted(context: Context): Boolean = missing(context).isEmpty()
}
```

- [ ] **Step 5: Wire the container**

In `app/src/main/java/com/serversherpa/kiosk/AppContainer.kt`, add to the imports:

```kotlin
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidController
import com.serversherpa.kiosk.input.rfid.RfidReader
```

Add a constructor parameter so tests can inject a fake, alongside the existing `secrets` and `dataStore` parameters (keep the existing parameters and their order; append this one with a default):

```kotlin
    rfidReaderOverride: RfidReader? = null,
```

Add after `val dataWedgeReceiver = DataWedgeReceiver(scanBus)`:

```kotlin
    // The Zebra adapter arrives in the next task; until then, and in every test,
    // this is the fake. Nothing above the interface can tell the difference.
    val rfidReader: RfidReader = rfidReaderOverride ?: FakeRfidReader()
    val rfid = RfidController(rfidReader, prefs.rfid, scope)
```

In `fun start()`, add after `DataWedge.configure(app)`:

```kotlin
        rfid.start()
```

In the `ProcessLifecycleOwner` observer's `onStart`, add after `outbox.start()` — a reader the operator turned on reconnects itself when the app comes forward, so nobody has to visit Settings to start a shift:

```kotlin
                scope.launch { if (prefs.rfid.first().enabled) rfid.connectNow() }
```

In the same observer's `onStop`, add before `outbox.stop()`:

```kotlin
                scope.launch { rfid.disconnectNow() }
```

Add the import `kotlinx.coroutines.flow.first` if it is not already there.

- [ ] **Step 6: Run the tests and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): Bluetooth permissions for the sled and the reader in the container

Permissions are declared but asked for only when the operator turns the reader
on, so a kiosk that will never see a sled never sees a Bluetooth prompt. The
container holds the controller and hands it the fake reader until the Zebra
adapter lands.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The Zebra adapter

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/rfid/ZebraRfidReader.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/AppContainer.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/input/rfid/ZebraRfidReaderTest.kt`

**Interfaces:**
- Consumes: `RfidReader`, `RfidConnection`, `RfidSettings`, `powerToTenths`.
- Produces: `class ZebraRfidReader(context: Context, scope: CoroutineScope) : RfidReader`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/input/rfid/ZebraRfidReaderTest.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.RfidConnection
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * There is no sled under a Robolectric test, so what is being proved here is
 * the contract the rest of the app leans on: with no reader present, nothing
 * throws, and the failure is a sentence rather than a stack trace.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ZebraRfidReaderTest {
    private fun reader(scope: kotlinx.coroutines.CoroutineScope) =
        ZebraRfidReader(ApplicationProvider.getApplicationContext(), scope)

    @Test fun startsDisconnected() = runTest {
        assertTrue(reader(backgroundScope).connection.value is RfidConnection.Disconnected)
    }

    @Test fun connectingWithNoReaderPresentFailsWithSomethingReadable() = runTest {
        val r = reader(backgroundScope)
        val result = r.connect()
        assertTrue("connect must not throw, it must report", result.isFailure)
        val state = r.connection.value
        assertTrue("expected a Failed state, got $state", state is RfidConnection.Failed)
        val reason = (state as RfidConnection.Failed).reason
        assertTrue("the reason must be a sentence, got: $reason", reason.endsWith(".") && reason.length > 12)
    }

    @Test fun everyOperationOnADisconnectedReaderReportsRatherThanThrows() = runTest {
        val r = reader(backgroundScope)
        assertTrue(r.startInventory().isFailure)
        assertTrue(r.stopInventory().isFailure)
        assertTrue(r.apply(com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS).isFailure)
        r.disconnect()   // must not throw
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.ZebraRfidReaderTest'
```

Expected: FAIL to compile, `Unresolved reference: ZebraRfidReader`.

- [ ] **Step 3: Write the adapter**

Create `app/src/main/java/com/serversherpa/kiosk/input/rfid/ZebraRfidReader.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import android.content.Context
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.powerToTenths
import com.zebra.rfid.api3.BEEPER_VOLUME
import com.zebra.rfid.api3.ENUM_TRANSPORT
import com.zebra.rfid.api3.ENUM_TRIGGER_MODE
import com.zebra.rfid.api3.HANDHELD_TRIGGER_EVENT_TYPE
import com.zebra.rfid.api3.RFIDReader
import com.zebra.rfid.api3.Readers
import com.zebra.rfid.api3.RfidEventsListener
import com.zebra.rfid.api3.RfidReadEvents
import com.zebra.rfid.api3.RfidStatusEvents
import com.zebra.rfid.api3.SESSION
import com.zebra.rfid.api3.STATUS_EVENT_TYPE
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext

/**
 * The only file in this app that knows Zebra exists.
 *
 * The SDK calls back on its own thread, so every callback does one thing: push
 * onto a flow. All outbound SDK calls run on Dispatchers.IO, because several of
 * them block on the radio.
 */
class ZebraRfidReader(private val context: Context, private val scope: CoroutineScope) : RfidReader {
    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 512)
    override val tags: SharedFlow<String> = _tags

    private val _triggers = MutableSharedFlow<TriggerEvent>(extraBufferCapacity = 16)
    override val triggers: SharedFlow<TriggerEvent> = _triggers

    private var readers: Readers? = null
    private var reader: RFIDReader? = null
    private var name: String = "RFID reader"

    private val listener = object : RfidEventsListener {
        override fun eventReadNotify(event: RfidReadEvents) {
            // Never touch the reader from in here; just hand the value on.
            event.readEventData?.tagData?.tagID?.let { _tags.tryEmit(it) }
        }

        override fun eventStatusNotify(event: RfidStatusEvents) {
            val data = event.StatusEventData ?: return
            when (data.statusEventType) {
                STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT -> {
                    when (data.HandheldTriggerEventData?.handheldEvent) {
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED -> _triggers.tryEmit(TriggerEvent.PRESSED)
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> _triggers.tryEmit(TriggerEvent.RELEASED)
                        else -> Unit
                    }
                }
                STATUS_EVENT_TYPE.BATTERY_EVENT -> {
                    val level = data.BatteryData?.level
                    val was = _connection.value
                    if (was is RfidConnection.Connected && level != null) {
                        _connection.value = was.copy(batteryPct = level)
                    }
                }
                STATUS_EVENT_TYPE.DISCONNECTION_EVENT -> {
                    _connection.value = RfidConnection.Failed("The reader disconnected.")
                }
                else -> Unit
            }
        }
    }

    override suspend fun connect(): Result<Unit> = withContext(Dispatchers.IO) {
        _connection.value = RfidConnection.Connecting
        runCatching {
            val all = Readers(context, ENUM_TRANSPORT.ALL)
            readers = all
            val device = all.GetAvailableRFIDReaderList()?.firstOrNull()
                ?: error("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.")
            val rfid = device.rfidReader
            rfid.connect()
            rfid.Events.addEventsListener(listener)
            rfid.Events.setHandheldEvent(true)
            rfid.Events.setTagReadEvent(true)
            rfid.Events.setBatteryEvent(true)
            // RFID_MODE with updateScannerPlugin = true puts the physical trigger
            // on the radio rather than the barcode imager.
            rfid.Config.setTriggerMode(ENUM_TRIGGER_MODE.RFID_MODE, true)
            reader = rfid
            name = device.name ?: "RFID reader"
            _connection.value = RfidConnection.Connected(name, null)
        }.onFailure { e ->
            _connection.value = RfidConnection.Failed(readable(e))
            runCatching { disconnectQuietly() }
        }
    }

    override suspend fun disconnect() { withContext(Dispatchers.IO) { disconnectQuietly() } }

    private fun disconnectQuietly() {
        runCatching { reader?.Events?.removeEventsListener(listener) }
        runCatching { reader?.disconnect() }
        runCatching { readers?.Dispose() }
        reader = null
        readers = null
        _connection.value = RfidConnection.Disconnected
    }

    override suspend fun apply(settings: RfidSettings): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val rfid = reader ?: error("The reader is not connected.")
            val antenna = rfid.Config.Antennas.getAntennaRfConfig(1)
            antenna.transmitPowerIndex = powerToTenths(settings.powerDbm)
            rfid.Config.Antennas.setAntennaRfConfig(1, antenna)

            val singulation = rfid.Config.Antennas.getSingulationControl(1)
            singulation.session = when (settings.session) {
                com.serversherpa.kiosk.core.rfid.RfidSession.S0 -> SESSION.SESSION_S0
                com.serversherpa.kiosk.core.rfid.RfidSession.S1 -> SESSION.SESSION_S1
                com.serversherpa.kiosk.core.rfid.RfidSession.S2 -> SESSION.SESSION_S2
                com.serversherpa.kiosk.core.rfid.RfidSession.S3 -> SESSION.SESSION_S3
            }
            singulation.tagPopulation = settings.tagPopulation.toShort()
            rfid.Config.Antennas.setSingulationControl(1, singulation)

            rfid.Config.setBeeperVolume(
                when (settings.beeper) {
                    SledBeeper.OFF -> BEEPER_VOLUME.QUIET_BEEP
                    SledBeeper.LOW -> BEEPER_VOLUME.LOW_BEEP
                    SledBeeper.MEDIUM -> BEEPER_VOLUME.MEDIUM_BEEP
                    SledBeeper.HIGH -> BEEPER_VOLUME.HIGH_BEEP
                }
            )
            rfid.Config.setLedBlinkEnable(settings.ledOnRead)
            rfid.Config.setUniqueTagReport(settings.uniqueTagReport)
            rfid.Config.dpoState = if (settings.dpo) com.zebra.rfid.api3.DYNAMIC_POWER_OPTIMIZATION.ENABLE
                else com.zebra.rfid.api3.DYNAMIC_POWER_OPTIMIZATION.DISABLE
            Unit
        }
    }

    override suspend fun startInventory(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val rfid = reader ?: error("The reader is not connected.")
            rfid.Actions.Inventory.perform()
        }
    }

    override suspend fun stopInventory(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val rfid = reader ?: error("The reader is not connected.")
            rfid.Actions.Inventory.stop()
        }
    }

    /** SDK exceptions carry codes, not sentences. Give the operator a sentence. */
    private fun readable(e: Throwable): String {
        val raw = e.message?.trim().orEmpty()
        if (raw.endsWith(".") && raw.length > 12) return raw
        return if (raw.isEmpty()) "Couldn't connect to the reader." else "Couldn't connect to the reader ($raw)."
    }
}
```

**Note on the SDK's names:** two kinds of name in this file were written from Zebra's documentation rather than from the `.aar` on disk, so expect to correct some of them.

1. *Properties.* The Kotlin compiler maps Zebra's Java getters and setters to properties where it can (`antenna.transmitPowerIndex`, `singulation.session`, `rfid.Config.dpoState`). If one does not resolve, use the explicit Java accessor the compiler reports (`antenna.setTransmitPowerIndex(...)`).
2. *Enum constants.* `BEEPER_VOLUME.QUIET_BEEP` and `HIGH_BEEP` are confirmed; `LOW_BEEP` and `MEDIUM_BEEP` are not. Same for `STATUS_EVENT_TYPE.DISCONNECTION_EVENT`. Before guessing, list what the library actually declares:

```bash
cd Android_Kiosk_App
unzip -p RFIDAPI3Library/API3_LIB-release.aar classes.jar > /tmp/api3.jar
unzip -l /tmp/api3.jar | grep -E "BEEPER_VOLUME|STATUS_EVENT_TYPE|HANDHELD_TRIGGER"
javap -classpath /tmp/api3.jar com.zebra.rfid.api3.BEEPER_VOLUME
javap -classpath /tmp/api3.jar com.zebra.rfid.api3.STATUS_EVENT_TYPE
```

Use exactly what `javap` prints. Note every correction in the task notes, and never change behavior to dodge a name.

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.ZebraRfidReaderTest'
```

Expected: PASS, 3 tests. If `Readers(...)` throws under Robolectric rather than returning an empty list, the `runCatching` in `connect()` already turns that into a `Failed` state, which is what the test asserts.

- [ ] **Step 5: Use the real reader in the app**

In `app/src/main/java/com/serversherpa/kiosk/AppContainer.kt`, replace the fake with the Zebra reader, keeping the override for tests:

```kotlin
    val rfidReader: RfidReader = rfidReaderOverride ?: ZebraRfidReader(app, scope)
```

Add the import:

```kotlin
import com.serversherpa.kiosk.input.rfid.ZebraRfidReader
```

Remove the now-unused `FakeRfidReader` import from `AppContainer.kt` if nothing else there uses it.

In `app/src/test/java/com/serversherpa/kiosk/TestContainer.kt` (the file defining `testContainer()`), pass a fake so no test ever constructs the Zebra reader:

```kotlin
    rfidReaderOverride = FakeRfidReader(),
```

with the import `import com.serversherpa.kiosk.input.rfid.FakeRfidReader`.

- [ ] **Step 6: Run everything and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): the Zebra adapter, the one file that knows the SDK exists

Its callbacks arrive on a vendor thread and do nothing but push onto flows;
every outbound call runs on IO because several block on the radio. A missing
reader is a sentence an operator can act on, never a stack trace.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
