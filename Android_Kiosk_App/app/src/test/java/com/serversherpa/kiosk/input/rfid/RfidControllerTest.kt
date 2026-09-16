package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `FakeRfidReader` refuses `startInventory()`/`apply()` unless it is
 * `Connected`, and throws from `emitTrigger`/`emitTag` if nothing is
 * collecting yet — the same as a real sled, which delivers no trigger events
 * at all before it is connected. So every test that drives a trigger connects
 * the fake first (`r.controller.connectNow()`), and always after
 * `r.controller.start()` has been settled, so the controller's collectors are
 * already subscribed when the emission lands.
 */
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
        r.controller.connectNow(); settle()

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
     *  not on top. Only the Scanning screen arms this. Disarmed, the trigger
     *  is short-circuited before the controller ever calls the reader, so no
     *  connection is needed for this one — the point is that nothing happens
     *  at all. */
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
        r.controller.connectNow(); settle()
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
        r.controller.connectNow(); settle()

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
        r.controller.connectNow(); settle()

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
        r.controller.connectNow(); settle()
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

    /**
     * Regression test for a controller whose reader is already `Connected`
     * before `start()` ever runs — a reused `RfidReader` instance, or a
     * `start()` called late. The connection collector used to seed its
     * "was connected" memory from `reader.connection.value` itself, so that
     * already-Connected state read as "no transition happened" and nothing
     * was pushed; the radio was left on firmware defaults until an unrelated
     * setting happened to change.
     *
     * `settings` is deliberately identical to the controller's own initial
     * `current` (`DEFAULT_RFID_SETTINGS`), so the settings collector's own
     * change-detection — which pushes independently whenever the *first*
     * collected value differs from `current` — never fires. Any push
     * observed here can only have come from the connection collector's
     * "just connected" transition, which is the exact path this test pins.
     */
    @Test fun aControllerStartedAgainstAnAlreadyConnectedReaderPushesSettingsWithoutWaitingForAChange() = runTest {
        val reader = FakeRfidReader()
        reader.connect()
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS)
        val controller = RfidController(reader, settings, backgroundScope)

        controller.start(); settle()

        assertEquals(
            "a reader already connected when start() runs must still get its settings pushed",
            DEFAULT_RFID_SETTINGS,
            reader.applied,
        )
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

    /** A failure with no detail message must not read as success: `applyError`
     *  falls back to a fixed sentence instead of staying null. */
    @Test fun aRefusalWithNoMessageStillReportsSomething() = runTest {
        val r = Rig(backgroundScope)
        r.reader.applyResult = Result.failure(IllegalStateException())
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals("The reader refused the settings.", r.controller.applyError.value)
    }

    @Test fun applyErrorClearsAfterALaterSuccessfulPush() = runTest {
        val r = Rig(backgroundScope)
        r.reader.applyResult = Result.failure(IllegalStateException("Power out of range."))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals("Power out of range.", r.controller.applyError.value)

        r.reader.applyResult = Result.success(Unit)
        r.settings.value = r.settings.value.copy(powerDbm = 15); settle()
        assertNull("a later push that succeeds clears the earlier complaint", r.controller.applyError.value)
    }

    @Test fun disconnectNowQueuesWhatWasReadAndStopsTheReader() = runTest {
        val r = Rig(backgroundScope)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100400"); settle()

        r.controller.disconnectNow(); settle()

        assertEquals(false, r.reader.inventoryRunning)
        assertNull(r.controller.session.value)
        assertEquals(RfidConnection.Disconnected, r.reader.connection.value)
        // An explicit disconnect follows the same rule as an involuntary drop:
        // what was already read still gets queued, not thrown away.
        assertEquals(listOf(listOf("100400")), bursts)
    }

    @Test fun disconnectNowWithNoBurstOpenJustDisconnects() = runTest {
        val r = Rig(backgroundScope)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); settle()
        r.controller.connectNow(); settle()

        r.controller.disconnectNow(); settle()

        assertEquals(RfidConnection.Disconnected, r.reader.connection.value)
        assertTrue("nothing was open, so nothing should have been emitted", bursts.isEmpty())
    }

    /** Exercises `pressedAtMs`/`heldMs` end to end: a quick click latches a
     *  HOLD_OR_LATCH read instead of stopping it, and a later press (not a
     *  release) is what ends it. An implementation that always passed
     *  `heldMs = 0` would still pass every other test in this file. */
    @Test fun holdOrLatchLatchesOnAQuickClickAndStopsOnALaterPress() = runTest {
        val r = Rig(backgroundScope)
        r.settings.value = DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerMode = RfidTriggerMode.HOLD_OR_LATCH)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()

        r.now = 0
        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue("a press with nothing reading starts an inventory", r.reader.inventoryRunning)

        r.now = 100 // well under LATCH_MS: a click, not a hold
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertTrue("a quick click latches: the read keeps going", r.reader.inventoryRunning)
        assertTrue("the panel is still open", r.controller.session.value != null)

        r.reader.emitTag("100500"); settle()

        r.now = 4_000 // long after the click; irrelevant to a PRESSED event
        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertNull("a press while latched-reading always ends it", r.controller.session.value)
        assertEquals(listOf(listOf("100500")), bursts)
    }

    /**
     * A reader whose `stopInventory()` signals [stopStarted] and then hangs
     * on [proceedStop] until the test releases it — a seam `FakeRfidReader`
     * has no need for, so it lives here rather than weakening that class.
     * `connect`/`disconnect`/`apply`/`startInventory` and `triggers` all
     * delegate to a real `FakeRfidReader`; `tags` is this class's own flow so
     * the test can slip a tag in at an exact moment without going through
     * `FakeRfidReader`'s "nothing was collecting" guard timing.
     */
    private class SlowStopReader(private val inner: FakeRfidReader) : RfidReader {
        override val connection: StateFlow<RfidConnection> get() = inner.connection
        private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 16)
        override val tags: Flow<String> = _tags
        override val triggers: Flow<TriggerEvent> get() = inner.triggers

        /** Completes the instant `stopInventory()` is called. */
        val stopStarted = CompletableDeferred<Unit>()

        /** The test completes this once it wants `stopInventory()` to
         *  actually return. */
        val proceedStop = CompletableDeferred<Unit>()

        /** How many times `startInventory()` has been called — `inner`'s own
         *  `inventoryRunning` can't tell a fresh start from one already in
         *  progress apart (it is still `true` for the whole window a stop is
         *  in flight, since `inner.stopInventory()` is only reached after
         *  `proceedStop` completes), so a test that needs to know whether a
         *  *new* read started mid-stop needs this instead. */
        var startInventoryCalls = 0
            private set

        override suspend fun connect() = inner.connect()
        override suspend fun disconnect() = inner.disconnect()
        override suspend fun apply(settings: RfidSettings) = inner.apply(settings)
        override suspend fun startInventory(): Result<Unit> {
            startInventoryCalls++
            return inner.startInventory()
        }
        override suspend fun stopInventory(): Result<Unit> {
            stopStarted.complete(Unit)
            proceedStop.await()
            return inner.stopInventory()
        }

        fun emitTag(epc: String) {
            check(_tags.tryEmit(epc)) { "Dropped tag $epc: nothing was collecting." }
        }
    }

    /**
     * Regression test for the reorder that used to be inert: `endBurst` called
     * `reader.stopInventory()` before claiming the session, but the caller
     * held `mutex` across that call, and `onTag` takes the same mutex — so a
     * tag arriving mid-stop just blocked until the session was already
     * claimed and nulled, and was folded into nothing. The fix releases the
     * lock before calling `stopInventory()`, so `onTag` stays free to keep
     * folding tags into the still-open session for the whole vendor round
     * trip.
     */
    @Test fun aTagArrivingWhileStopInventoryIsInFlightIsStillIncludedInTheBurst() = runTest {
        val inner = FakeRfidReader()
        val slowStop = SlowStopReader(inner)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(slowStop, settings, backgroundScope) { 0L }
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { controller.bursts.collect { bursts += it } }
        controller.start(); controller.arm(); settle()
        controller.connectNow(); settle()

        inner.emitTrigger(TriggerEvent.PRESSED); settle()
        slowStop.emitTag("100600"); settle()
        assertEquals(1, controller.session.value?.totalReads)

        controller.stopBurst(); settle()
        assertTrue("stopInventory() should have been called", slowStop.stopStarted.isCompleted)
        assertTrue(
            "the burst must still be open while the stop is in flight — a caller " +
                "that claimed it before stopping would already have nulled it here",
            controller.session.value != null,
        )

        // The tag lands while stopInventory() is still suspended on
        // proceedStop. Before the fix, onTag would be stuck waiting on the
        // same mutex the stopping caller held across the stop, and would
        // fold this tag into a session that no longer existed by the time it
        // finally ran.
        slowStop.emitTag("100601"); settle()

        slowStop.proceedStop.complete(Unit); settle()

        assertEquals(listOf(listOf("100600", "100601")), bursts)
    }

    /**
     * Regression test for a trigger pull landing in the same window as the
     * tag-during-stop test above, but on the *trigger* collector instead of
     * the tag collector. `endBurst` releases `mutex` across
     * `reader.stopInventory()`, and before this fix `onTrigger` read state
     * during that gap: the session was still open, so a PRESSED arriving
     * mid-stop was read (in HOLD mode) as `NONE` — nothing happened, and
     * once the stop actually finished nothing restarted the read. The
     * operator's second pull did nothing.
     *
     * The fix makes `onTrigger` wait on `stopGate` until the in-flight stop
     * has fully finished before it evaluates anything, so the same PRESSED
     * event is instead evaluated against `reading = false` once the stop
     * completes, and correctly reads as `START`.
     */
    @Test fun aTriggerPullArrivingWhileAStopIsInFlightStartsANewReadOnceTheStopCompletes() = runTest {
        val inner = FakeRfidReader()
        val slowStop = SlowStopReader(inner)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(slowStop, settings, backgroundScope) { 0L }
        controller.start(); controller.arm(); settle()
        controller.connectNow(); settle()

        inner.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals("the first pull should have started one inventory", 1, slowStop.startInventoryCalls)

        controller.stopBurst(); settle()
        assertTrue("stopInventory() should have been called", slowStop.stopStarted.isCompleted)
        assertTrue(
            "the burst must still be open while the stop is in flight",
            controller.session.value != null,
        )

        // A second trigger pull lands while stopInventory() is still
        // suspended on proceedStop — the exact window the tag-during-stop
        // test above exercises for onTag. Before the fix, onTrigger would
        // see the still-open session here and read this PRESSED as NONE,
        // permanently losing the pull. `inner.inventoryRunning` can't tell
        // this apart from the first read still nominally being "on" (it
        // only flips once `inner.stopInventory()` itself runs, which is
        // gated behind `proceedStop`), so this checks the call count
        // instead: it must still be 1 — no new read has started yet.
        inner.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals(
            "a trigger arriving mid-stop must not start a read before the stop has finished",
            1,
            slowStop.startInventoryCalls,
        )

        slowStop.proceedStop.complete(Unit); settle()

        assertEquals(
            "the trigger that arrived mid-stop should start a new read once the stop completes",
            2,
            slowStop.startInventoryCalls,
        )
        assertTrue("the new read should be running", inner.inventoryRunning)
    }

    /**
     * Regression test for the leak this fix closes: if the coroutine running
     * `endBurst` is cancelled while suspended in `reader.stopInventory()` —
     * e.g. `disconnectNow()` called from a screen's `viewModelScope` that
     * then gets cleared because the screen navigated away — the stopping
     * marker and the open session must not be left behind forever. Before
     * the fix, cancellation unwound straight past the claim at the bottom of
     * `endBurst`, leaving `stoppingBurst` stuck true and `_session` stuck
     * non-null: every later `endBurst` returned early, the live panel never
     * closed, the radio kept inventorying, `bursts` never emitted again, and
     * a following trigger press read as NONE because a session still looked
     * open — wedged until the process restarted.
     *
     * `disconnectNow()` is a plain `suspend fun` (unlike `arm`/`disarm`/
     * `stopBurst`, which only enqueue onto [commands]), so cancelling the
     * coroutine that is running it cancels `endBurst` itself directly while
     * it is suspended inside `stopInventory()` — exactly the window the
     * finding describes.
     */
    @Test fun aStopCancelledWhileSuspendedInStopInventoryLeavesTheControllerCleanForTheNextTrigger() = runTest {
        val inner = FakeRfidReader()
        val slowStop = SlowStopReader(inner)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(slowStop, settings, backgroundScope) { 0L }
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { controller.bursts.collect { bursts += it } }
        controller.start(); controller.arm(); settle()
        controller.connectNow(); settle()

        inner.emitTrigger(TriggerEvent.PRESSED); settle()
        slowStop.emitTag("100700"); settle()
        assertEquals(1, controller.session.value?.totalReads)

        val disconnector = backgroundScope.launch { controller.disconnectNow() }
        settle()
        assertTrue("stopInventory() should have been called", slowStop.stopStarted.isCompleted)
        assertTrue(
            "the burst should still look open while the stop is in flight",
            controller.session.value != null,
        )

        disconnector.cancel()
        settle()

        assertNull(
            "a cancelled stop must still claim the session, not leave it stuck open",
            controller.session.value,
        )
        // The caller wanted the tags queued (disconnectNow's normal rule),
        // and they were genuinely read: the cancellation must not discard
        // them.
        assertEquals(listOf(listOf("100700")), bursts)

        // Let the underlying vendor call unblock for any *future* stop —
        // it was abandoned, not answered, by the cancelled caller above; this
        // only prevents a later stopInventory() call from hanging on the same
        // single-use CompletableDeferred.
        slowStop.proceedStop.complete(Unit)

        // The next trigger pull must behave normally: reading = false, so
        // this PRESSED must start a fresh inventory rather than being read
        // as NONE because a session still looks open.
        inner.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals(
            "a trigger after the cancelled stop should start a new read",
            2,
            slowStop.startInventoryCalls,
        )
        assertTrue("the new read should be running", inner.inventoryRunning)

        // The stopping marker must not be stuck either: a later stopBurst()
        // must actually stop this new read, not silently no-op the way it
        // would if `stoppingBurst` had leaked true.
        slowStop.emitTag("100701"); settle()
        controller.stopBurst(); settle()
        assertEquals(false, inner.inventoryRunning)
        assertEquals(listOf(listOf("100700"), listOf("100701")), bursts)
    }

    /**
     * A reader whose `connect()` signals [connectStarted] and then hangs on
     * [proceedConnect] until the test releases it — [SlowStopReader]'s
     * mirror for the connect side, so it lives here for the same reason:
     * `FakeRfidReader` has no need for this seam. `disconnect`/`apply`/
     * `startInventory`/`stopInventory` and `triggers`/`tags` all delegate to
     * a real `FakeRfidReader`.
     */
    private class SlowConnectReader(private val inner: FakeRfidReader) : RfidReader {
        override val connection: StateFlow<RfidConnection> get() = inner.connection
        override val tags: Flow<String> get() = inner.tags
        override val triggers: Flow<TriggerEvent> get() = inner.triggers

        /** Completes the instant `connect()` is called. */
        val connectStarted = CompletableDeferred<Unit>()

        /** The test completes this once it wants `connect()` to actually
         *  return. */
        val proceedConnect = CompletableDeferred<Unit>()

        override suspend fun connect(): Result<Unit> {
            connectStarted.complete(Unit)
            proceedConnect.await()
            return inner.connect()
        }
        override suspend fun disconnect() = inner.disconnect()
        override suspend fun apply(settings: RfidSettings) = inner.apply(settings)
        override suspend fun startInventory() = inner.startInventory()
        override suspend fun stopInventory() = inner.stopInventory()
    }

    /**
     * A reader whose `apply()` signals [applyStarted] and then hangs on
     * [proceedApply] until the test releases it — [SlowStopReader]'s mirror
     * for the settings-push side, so it lives here for the same reason:
     * `FakeRfidReader` has no need for this seam. `connect`/`disconnect`/
     * `startInventory`/`stopInventory` and `triggers`/`tags` all delegate to
     * a real `FakeRfidReader`.
     */
    private class SlowApplyReader(private val inner: FakeRfidReader) : RfidReader {
        override val connection: StateFlow<RfidConnection> get() = inner.connection
        override val tags: Flow<String> get() = inner.tags
        override val triggers: Flow<TriggerEvent> get() = inner.triggers

        /** Completes the instant `apply()` is called. */
        val applyStarted = CompletableDeferred<Unit>()

        /** The test completes this once it wants `apply()` to actually
         *  return. */
        val proceedApply = CompletableDeferred<Unit>()

        override suspend fun connect() = inner.connect()
        override suspend fun disconnect() = inner.disconnect()
        override suspend fun apply(settings: RfidSettings): Result<Unit> {
            applyStarted.complete(Unit)
            proceedApply.await()
            return inner.apply(settings)
        }
        override suspend fun startInventory() = inner.startInventory()
        override suspend fun stopInventory() = inner.stopInventory()
    }

    /**
     * The core regression proof for C1: before the fix, the connection
     * collector pushed settings as `mutex.withLock { push(current) }`, so a
     * settings push stuck on the vendor link (`reader.apply()`, which used to
     * have no timeout at all) held `mutex` forever. `onTrigger` takes the
     * same `mutex` to evaluate a trigger event, so a stuck push froze every
     * trigger pull too — not just the settings screen, the whole Scanning
     * screen. This drives exactly that: `connectNow()` fires the "just
     * connected" push, which sticks on `proceedApply`, and a trigger PRESSED
     * event fired afterward must still open the burst — proving `mutex` was
     * never held across the stuck `apply()` call.
     *
     * Against the pre-fix code (`mutex.withLock { push(current) }`), the
     * connection collector never releases `mutex`, `onTrigger`'s own
     * `mutex.withLock` never acquires it, and `controller.session.value`
     * stays null forever within this test's scheduling — this test fails
     * before the fix and passes after it (see the fix-wave report for both
     * runs).
     */
    @Test fun aTriggerPullOpensTheBurstWhileASettingsPushIsStuckOnTheVendorLink() = runTest {
        val inner = FakeRfidReader()
        val slowApply = SlowApplyReader(inner)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(slowApply, settings, backgroundScope) { 0L }
        controller.start(); controller.arm(); settle()
        controller.connectNow(); settle()
        assertTrue(
            "apply() should have been called on the just-connected transition",
            slowApply.applyStarted.isCompleted,
        )

        // apply() is stuck on proceedApply here — before the fix this holds
        // `mutex` for as long as the vendor stack takes, blocking every
        // other mutex.withLock caller, onTrigger included.
        inner.emitTrigger(TriggerEvent.PRESSED); settle()

        assertTrue(
            "a trigger pull must open the burst even while a settings push is " +
                "stuck on the vendor link — mutex must never be held across apply()",
            controller.session.value != null,
        )

        // Let the stuck apply() finish so it doesn't leak past the test.
        slowApply.proceedApply.complete(Unit); settle()
    }

    /**
     * The timeout-reporting proof for C1: `push()` wraps `reader.apply()` in
     * `withTimeoutOrNull(VENDOR_TIMEOUT_MS)`, the same defense
     * `connectWithTimeout`/`disconnectWithTimeout` already use, so a soft-hung
     * vendor stack is reported rather than silently wedging `applyGate`
     * forever. `VENDOR_TIMEOUT_MS` is `private` on `RfidController`'s
     * companion object, so its value (15s) is duplicated here rather than
     * referenced — the same tradeoff other constants in this codebase make
     * where the source deliberately keeps them private.
     */
    @Test fun aStuckSettingsPushReportsATimeoutAfterVendorTimeoutMsElapses() = runTest {
        val inner = FakeRfidReader()
        val slowApply = SlowApplyReader(inner)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(slowApply, settings, backgroundScope) { 0L }
        controller.start(); settle()
        controller.connectNow(); settle()
        assertTrue(
            "apply() should have been called on the just-connected transition",
            slowApply.applyStarted.isCompleted,
        )
        assertNull("nothing has timed out yet", controller.applyError.value)

        advanceTimeBy(15_000L + 1); settle()

        assertEquals(
            "Pushing settings to the reader timed out.",
            controller.applyError.value,
        )

        // Let the stuck apply() finish so it doesn't leak past the test.
        slowApply.proceedApply.complete(Unit); settle()
    }

    /**
     * The regression test for the finding this fix wave closes: before the
     * fix, `connectForLifecycle()`/`disconnectForLifecycle()` and
     * `arm()`/`disarm()`/`stopBurst()` all funneled through the same single
     * `commands` channel, drained by one consumer. A lifecycle connect that
     * blocks inside `reader.connect()` — on real hardware, a Bluetooth
     * vendor call that can take seconds when the sled is out of range, the
     * radio is busy, or the stack soft-hangs — sat at the front of that
     * queue and starved everything queued behind it. The Scanning screen's
     * `arm()`, issued a moment later, would then wait on the same stuck
     * consumer: `armed` stayed false, and every trigger pull was a silent
     * no-op with nothing on screen explaining it.
     *
     * The fix gives connect/disconnect their own queue and consumer, so
     * `arm()` (on the original `commands` queue) is drained by its own
     * dedicated consumer and never has to wait behind a stuck connect.
     * This proves it directly: `connectForLifecycle()` is issued against a
     * reader whose `connect()` never returns within the test, `arm()`
     * follows immediately after, and a trigger fired right after that must
     * open the live panel — the one observable proof that `armed` actually
     * flipped true — without ever waiting for the stuck connect to finish.
     *
     * Against the pre-fix single-queue code, `armNow()` sits behind the
     * blocked `Command.Connect` in the same channel and never runs before
     * the assertion below, so `armed` stays false and the trigger fired
     * here is silently dropped — `session.value` stays null and this test
     * fails.
     */
    @Test fun aSlowLifecycleConnectDoesNotStarveArm() = runTest {
        val inner = FakeRfidReader()
        val slowConnect = SlowConnectReader(inner)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(slowConnect, settings, backgroundScope) { 0L }
        controller.start(); settle()

        controller.connectForLifecycle { true }; settle()
        assertTrue("connect() should have been called", slowConnect.connectStarted.isCompleted)
        assertEquals(
            "the reader must still look mid-connect: connect() hasn't returned yet",
            false,
            inner.connection.value is RfidConnection.Connected,
        )

        // arm() lands on the separate arm/disarm/stop queue. Before the fix,
        // this sat behind the still-blocked Command.Connect in the one
        // shared queue and never ran.
        controller.arm(); settle()

        // A trigger pull is the observable proof that arm() actually took
        // effect: onTrigger only opens the live panel when `armed` is true.
        // The reader is not Connected yet (SlowConnectReader is still stuck
        // on proceedConnect), so reader.startInventory() will fail inside
        // onTrigger's try/catch — that's expected and irrelevant here; the
        // session still opens before that call is even attempted.
        inner.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue(
            "arm() must take effect promptly and not wait for the stuck " +
                "lifecycle connect to finish",
            controller.session.value != null,
        )

        // Let the stuck connect() finish so it doesn't leak past the test.
        slowConnect.proceedConnect.complete(Unit)
    }

    /**
     * `TestScope` is single-threaded, so it cannot reproduce the races fixed
     * in `RfidController`: they need two collectors, or a collector and a
     * UI-thread call, genuinely running at once. This drives the controller
     * on a scope backed by `Dispatchers.Default` — the same kind of scope
     * `AppContainer` builds it with in production — and hammers `stopBurst()`,
     * `disarm()`/`arm()`, and `disconnectNow()`/`connectNow()` from separate
     * coroutines while a driver thread runs trigger/tag events through it.
     *
     * Every driven tag value is unique, so the invariant that would have
     * caught finding 1 (a double emit, or a resurrected session re-emitting
     * tags a previous burst already emitted) is simple: no tag value ever
     * shows up in two different emitted bursts.
     *
     * That duplicate-freedom check alone is guaranteed by the atomic claim
     * (`_session.getAndUpdate { null }`) on its own — it says nothing about
     * whether the mutex is doing anything. Two more assertions exercise the
     * mutex specifically: `seen` must be non-empty (a controller that
     * dropped every burst would vacuously pass the no-duplicates check), and
     * the radio must not be left running once the storm has settled and the
     * screen is disarmed. That second one is the one the atomic claim can't
     * explain: `stoppingBurst`/`queueOnStop` — which caller owns ending the
     * open burst, and whether the result should be kept — are a plain
     * check-then-act pair with no atomic primitive backing them. Only the
     * mutex keeps that check-then-act correct; a controller that raced on it
     * could easily be left with `stoppingBurst` stuck true (so a later
     * legitimate stop never happens) or the radio started again after the
     * disarming stop already ran.
     */
    @Test fun concurrentStopDisarmAndDisconnectNeverDoubleEmitATag() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val reader = FakeRfidReader()
            val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
            val controller = RfidController(reader, settings, scope)
            val seen = CopyOnWriteArrayList<String>()

            val collector = scope.launch { controller.bursts.collect { seen.addAll(it) } }

            controller.start()
            controller.arm()

            runBlocking {
                controller.connectNow()
                // Dispatchers.Default dispatches almost immediately, but
                // start()'s four collectors still need one real hop to
                // subscribe before FakeRfidReader will accept an emission.
                delay(50)

                val iterations = 150
                val driver = launch(Dispatchers.Default) {
                    repeat(iterations) { i ->
                        // FakeRfidReader's trigger/tag flows buffer only 16
                        // events, and every one of them has to fight the same
                        // three coroutines below for `mutex` to be drained. A
                        // real sled fires these orders of magnitude slower than
                        // a tight loop ever would, so a real delay here (not
                        // just a yield) is what keeps this stress test from
                        // tripping FakeRfidReader's own "nothing was
                        // collecting" guard on buffer pressure alone, while
                        // still leaving the mutex genuinely contended.
                        reader.emitTrigger(TriggerEvent.PRESSED)
                        reader.emitTag("RACE-$i")
                        reader.emitTrigger(TriggerEvent.RELEASED)
                        delay(2)
                    }
                }
                val stopper = launch(Dispatchers.Default) {
                    repeat(iterations) { controller.stopBurst(); yield() }
                }
                val disarmer = launch(Dispatchers.Default) {
                    repeat(iterations / 5) { controller.disarm(); controller.arm(); yield() }
                }
                val disconnector = launch(Dispatchers.Default) {
                    repeat(iterations / 10) { controller.disconnectNow(); controller.connectNow(); yield() }
                }
                driver.join(); stopper.join(); disarmer.join(); disconnector.join()

                // One deterministic, uncontested burst, so that "bursts
                // actually happened" below is a real assertion rather than a
                // coincidence of how the storm happened to interleave. The
                // storm itself can legitimately emit nothing at all: a
                // disarm() landing during any in-flight stop discards that
                // burst by design (finding 2's own requirement), and with 30
                // disarms racing 150 stops over 150 trigger cycles, disarm
                // can empirically win every single one. That is not new here
                // — the pre-fix controller starves the same way on some
                // runs, since nothing in this fix changes how often disarm
                // wins the race, only what happens once it does.
                //
                // disarmer/stopper joining only means their loops finished
                // *issuing* fire-and-forget disarm()/arm()/stopBurst() calls
                // — scope.launch returns immediately, so some of what they
                // queued can still be running for a little while after. A
                // fixed delay here would be a guess at how long that takes
                // under whatever load happens to be on the machine, so
                // retry instead of guessing: each attempt is harmless even
                // if a straggler from the storm (or a previous attempt)
                // still lands on it, and the loop only needs one attempt to
                // land in an actually-quiet window to succeed.
                var proofAttempts = 0
                // Each attempt uses its own tag value: if a straggler from
                // an earlier attempt (or the storm) finally lands *after*
                // this loop already decided to retry, a repeated tag value
                // would look like the exact double-emit finding 1 fixed —
                // a false failure, not a real one.
                while (seen.none { it.startsWith("FINAL-PROOF") } && proofAttempts < 20) {
                    controller.arm()
                    // arm() is itself fire-and-forget, so give its launch a
                    // moment to actually flip `armed` before firing a
                    // trigger.
                    delay(50)
                    reader.emitTrigger(TriggerEvent.PRESSED)
                    reader.emitTag("FINAL-PROOF-$proofAttempts")
                    reader.emitTrigger(TriggerEvent.RELEASED)
                    delay(100)
                    proofAttempts++
                }

                // Drain whatever burst the storm itself left open so its
                // tags (if any) are accounted for before we compare.
                controller.stopBurst()
                delay(50)

                // Now that nothing else is racing, a plain disarm must leave
                // the radio stopped. If the storm left `stoppingBurst` or
                // `queueOnStop` corrupted, this is where it would show up —
                // either as the radio still spinning, or as this disarm's
                // own stop never actually running because `stoppingBurst`
                // was stuck true from an earlier, unsynchronized caller.
                controller.disarm()
                delay(50)
            }

            collector.cancel()
            assertTrue("bursts should have been emitted during the stress run", seen.isNotEmpty())
            assertEquals(
                "no tag value should ever be emitted in two different bursts",
                seen.size,
                seen.toSet().size,
            )
            assertEquals(
                "the radio must not be left running once the storm has settled and the screen is disarmed",
                false,
                reader.inventoryRunning,
            )
        } finally {
            scope.cancel()
        }
    }

    /**
     * Regression test for `arm()`/`disarm()` losing their ordering: each used
     * to be its own `scope.launch`, which gives no guarantee that two
     * launches run in the order they were submitted. A fast appear-then-
     * disappear pair (a quick resume then pause) could run disarm's body
     * first, leaving `armed` true after the screen is gone.
     *
     * `TestScope` is single-threaded and cooperatively scheduled, so it
     * cannot reproduce a reordering race — it always runs launched
     * coroutines in submission order. This drives the controller on a real
     * `Dispatchers.Default` scope (as `AppContainer` does in production),
     * calls `arm()` immediately followed by `disarm()` with nothing in
     * between to force a particular schedule, and repeats it many times: the
     * outcome must be disarmed every single time, not just on average.
     */
    @Test fun armImmediatelyFollowedByDisarmAlwaysEndsDisarmedRegardlessOfScheduling() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val reader = FakeRfidReader()
            val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
            val controller = RfidController(reader, settings, scope)
            runBlocking {
                controller.start()
                controller.connectNow()
                delay(50)

                val iterations = 50
                repeat(iterations) { i ->
                    controller.arm()
                    controller.disarm()
                    delay(30)

                    reader.emitTrigger(TriggerEvent.PRESSED)
                    delay(30)
                    assertEquals(
                        "iteration $i: arm() then disarm() must leave the controller disarmed, " +
                            "no matter which dispatched command happened to run first",
                        false,
                        reader.inventoryRunning,
                    )
                    if (reader.inventoryRunning) {
                        // Leave a clean slate for the next iteration even if
                        // this one failed.
                        controller.stopBurst()
                        delay(30)
                    }
                }
            }
        } finally {
            scope.cancel()
        }
    }

    /**
     * Regression test for `AppContainer`'s `ProcessLifecycleOwner` observer:
     * `onStart` and `onStop` used to each fire an *independent*
     * `scope.launch` calling `connectNow()`/`disconnectNow()`, with nothing
     * ordering one launch against the other -- and `onStart`'s launch
     * suspended first, on a prefs read, before ever reaching `connectNow()`.
     * A fast background/foreground/background flurry (an incoming call, the
     * notification shade, a screen lock) could let an earlier `onStop`'s
     * disconnect land *after* a later `onStart`'s connect, or the reverse: a
     * sled left connected and drawing power in the background, or a
     * foreground kiosk silently missing its reader. (Confirmed: this test,
     * run with `connectNow()`/`disconnectNow()` fired from independent
     * `scope.launch` blocks the way `AppContainer` used to, fails within the
     * first few dozen iterations -- see the fix-wave report.)
     *
     * [RfidController.connectForLifecycle] and
     * [RfidController.disconnectForLifecycle] fix this by enqueueing onto
     * the same command channel `arm()`/`disarm()`/`stopBurst()` use, so this
     * drives them the way `AppContainer` now actually calls them: directly,
     * never from inside their own `scope.launch`, on a real
     * `Dispatchers.Default` scope. `connectForLifecycle`'s `gate` is given a
     * jittered `delay()` standing in for the real prefs/permission read
     * `AppContainer` performs -- since that gate runs on the consumer, after
     * the command is already queued, its suspension must not be able to
     * reorder anything. The reader's final state must match whichever call
     * was issued last, every time, across many iterations of both orderings.
     */
    @Test fun lifecycleStyleConnectAndDisconnectLandInTheOrderIssued() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val reader = FakeRfidReader()
            val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
            val controller = RfidController(reader, settings, scope)
            runBlocking {
                controller.start()
                delay(50)

                val iterations = 300
                repeat(iterations) { i ->
                    // Alternate which call is issued last so both orderings
                    // -- connect-after-disconnect and disconnect-after-connect
                    // -- get exercised, not just one.
                    val connectLast = i % 2 == 0
                    val jitterMs = (i % 7).toLong() // 0..6ms: onStart's prefs
                    // read sometimes resolves near-instantly and sometimes
                    // takes a beat; the fix must hold either way.
                    if (connectLast) {
                        controller.disconnectForLifecycle()
                        controller.connectForLifecycle { delay(jitterMs); true }
                    } else {
                        controller.connectForLifecycle { delay(jitterMs); true }
                        controller.disconnectForLifecycle()
                    }
                    delay(30)
                    assertEquals(
                        "iteration $i: the reader's final state must match whichever of " +
                            "connect/disconnect was issued last (lifecycle order), not " +
                            "whichever happened to finish last",
                        connectLast,
                        reader.connection.value is RfidConnection.Connected,
                    )
                }
            }
        } finally {
            scope.cancel()
        }
    }

    /** The mirror image of the test above: `disarm()` immediately followed
     *  by `arm()` must leave the controller armed every time. */
    @Test fun disarmImmediatelyFollowedByArmAlwaysEndsArmedRegardlessOfScheduling() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val reader = FakeRfidReader()
            val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
            val controller = RfidController(reader, settings, scope)
            runBlocking {
                controller.start()
                controller.connectNow()
                delay(50)

                val iterations = 50
                repeat(iterations) { i ->
                    controller.disarm()
                    controller.arm()
                    delay(30)

                    reader.emitTrigger(TriggerEvent.PRESSED)
                    delay(30)
                    assertEquals(
                        "iteration $i: disarm() then arm() must leave the controller armed, " +
                            "no matter which dispatched command happened to run first",
                        true,
                        reader.inventoryRunning,
                    )
                    // Reset for the next iteration regardless of outcome: end
                    // whatever read is open and disarm, the way a real
                    // screen visit ending would.
                    controller.stopBurst()
                    controller.disarm()
                    delay(30)
                }
            }
        } finally {
            scope.cancel()
        }
    }

    /**
     * I6 (controller half): a tag whose write to the outbox fails must not be
     * silently treated as already-sent on the next sweep. `forgetQueued`
     * removes it from `queued` after the fact, translating the raw EPCs
     * `bursts` emits into the normalized keys `queued` stores internally.
     * Burst two tags under SKIP_AND_COUNT, forget one, then sweep the same
     * two tags again: the forgotten one must queue again while the other
     * still skips as a repeat.
     */
    @Test fun forgetQueuedLetsAForgottenTagQueueAgainWhileTheOtherStillSkips() = runTest {
        val r = Rig(backgroundScope)
        r.settings.value = DEFAULT_RFID_SETTINGS.copy(enabled = true, repeatPolicy = RepeatSweepPolicy.SKIP_AND_COUNT)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED)
        r.reader.emitTag("100800"); r.reader.emitTag("100801"); settle()
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(listOf(listOf("100800", "100801")), bursts)

        r.controller.forgetQueued(listOf("100800")); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED)
        r.reader.emitTag("100800"); r.reader.emitTag("100801"); settle()
        assertEquals(
            "100800 was forgotten and must not read as a repeat; 100801 still should",
            1,
            r.controller.session.value?.skippedRepeats,
        )
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()

        assertEquals(
            listOf(listOf("100800", "100801"), listOf("100800")),
            bursts,
        )
    }

    /**
     * M1: under the default ALWAYS_QUEUE policy, `queued` is read nowhere
     * (`onTagRead` ignores `alreadyQueued` for that policy), so `endBurst`
     * must not grow it. Proven indirectly: burst a tag under ALWAYS_QUEUE,
     * then flip to SKIP_AND_COUNT (a legitimate settings change, no re-arm)
     * and sweep the same tag again — if the first burst had added to
     * `queued`, this second sweep would wrongly skip it as a repeat.
     */
    @Test fun queuedDoesNotGrowUnderTheDefaultAlwaysQueuePolicy() = runTest {
        val r = Rig(backgroundScope) // DEFAULT_RFID_SETTINGS.repeatPolicy == ALWAYS_QUEUE
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100900"); settle()
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()

        r.settings.value = r.settings.value.copy(repeatPolicy = RepeatSweepPolicy.SKIP_AND_COUNT); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100900"); settle()
        assertEquals(
            "the ALWAYS_QUEUE burst above must not have added to `queued`, or " +
                "this identical tag would now read as a skipped repeat",
            0,
            r.controller.session.value?.skippedRepeats,
        )
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
    }

    /**
     * M6: toggling only `enabled` must not push a full settings block to the
     * reader — `apply()` never reads `enabled`, and the RFID panel pairs this
     * with a `disconnectNow()` call, so pushing here is pure waste. A real
     * change (e.g. `powerDbm`) must still push, `enabled` value notwithstanding.
     */
    @Test fun togglingOnlyEnabledDoesNotPushSettingsToTheReader() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        val appliedAfterConnect = r.reader.applied
        assertEquals(27, appliedAfterConnect?.powerDbm)

        r.settings.value = r.settings.value.copy(enabled = false); settle()
        assertEquals(
            "flipping only `enabled` must not push a new settings block",
            appliedAfterConnect,
            r.reader.applied,
        )

        r.settings.value = r.settings.value.copy(powerDbm = 12); settle()
        assertEquals(
            "a real settings change must still push",
            12,
            r.reader.applied?.powerDbm,
        )
    }
}
