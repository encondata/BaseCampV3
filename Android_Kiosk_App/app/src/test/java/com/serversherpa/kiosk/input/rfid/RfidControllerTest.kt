package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
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

                // Drain whatever burst is still open so its tags (if any) are
                // accounted for before we compare.
                controller.arm()
                controller.stopBurst()
                delay(50)
            }

            collector.cancel()
            assertEquals(
                "no tag value should ever be emitted in two different bursts",
                seen.size,
                seen.toSet().size,
            )
        } finally {
            scope.cancel()
        }
    }
}
