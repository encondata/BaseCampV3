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

        override suspend fun connect() = inner.connect()
        override suspend fun disconnect() = inner.disconnect()
        override suspend fun apply(settings: RfidSettings) = inner.apply(settings)
        override suspend fun startInventory() = inner.startInventory()
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
}
