package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.SledKey
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledTriggerReadback
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.readbackOf
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The controller's sweeps (spec, Controller › Sweeps; rulings 27, 29 and 45):
 * when a trigger pull starts a read, how a start that fails or never answers
 * is closed, how a stop that fails is retried and remembered, and a sweep the
 * sled ended by itself. Spec tests 4, 9, 11 (second half), 12, 13 and 14
 * (second half); rows 4, 5 and 6. Every rig runs in `backgroundScope` on
 * virtual time, so the controller's clock is the test scheduler's unless a
 * test sets [Rig.now].
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidSweepTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    /** Moves virtual time to [ms] (absolute) and runs what is due then. */
    private fun TestScope.at(ms: Long) { advanceTimeBy(ms - currentTime); settle() }

    /** Records the start and stop calls a sweep makes, in order. With
     *  [throwOnStart] the next start throws an `Error` instead of answering. */
    private class Recorder(private val inner: FakeRfidReader) : RfidReader by inner {
        val calls = CopyOnWriteArrayList<String>()
        @Volatile var throwOnStart = false

        override suspend fun startInventory(): Result<Unit> {
            calls += "start"
            if (throwOnStart) {
                throwOnStart = false
                throw OutOfMemoryError("simulated vendor Error")
            }
            return inner.startInventory()
        }

        override suspend fun stopInventory(): Result<Unit> {
            calls += "stop"
            return inner.stopInventory()
        }
    }

    private class Rig(t: TestScope, initial: RfidSettings = DEFAULT_RFID_SETTINGS.copy(enabled = true)) {
        val fake = FakeRfidReader()
        val reader = Recorder(fake)
        val settings = MutableStateFlow(initial)
        /** When set, the controller's clock; otherwise virtual time. */
        @Volatile var now: Long? = null
        val controller = RfidController(reader, settings, t.backgroundScope) { now ?: t.testScheduler.currentTime }
        val bursts = CopyOnWriteArrayList<List<String>>()

        init {
            t.backgroundScope.launch { controller.bursts.collect { bursts += it } }
        }
    }

    /** Starts and arms [r], connects it through the controller (the connect's
     *  push and layout write included), and forgets those calls. */
    private fun TestScope.connectedAndArmed(r: Rig) {
        r.controller.start(); r.controller.arm(); settle()
        backgroundScope.launch { r.controller.connectNow() }; settle()
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        r.reader.calls.clear()
    }

    /** Spec test 14, second half, and row 4: a pull while `Connecting` or in
     *  `NeedsRegion`, or while disarmed, opens no sweep and asks the sled for
     *  nothing; once `Connected` and armed, it reads. */
    @Test fun aPullStartsAReadOnlyWhileConnectedAndArmed() = runTest {
        val r = Rig(this)
        r.controller.start(); r.controller.arm(); settle()
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        backgroundScope.launch { r.controller.connectNow() }; settle()
        assertEquals(RfidConnection.Connecting, r.fake.connection.value)

        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNull("Connecting: no sweep", r.controller.session.value)
        assertEquals(emptyList<String>(), r.reader.calls)
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()

        hold.complete(Unit); settle()
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNotNull("Connected and armed: a sweep", r.controller.session.value)
        assertTrue(r.fake.inventoryRunning)
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()

        val n = Rig(this)
        n.fake.needsRegion = true
        n.controller.start(); n.controller.arm(); settle()
        backgroundScope.launch { n.controller.connectNow() }; settle()
        assertEquals(RfidConnection.NeedsRegion("Fake RFD40"), n.fake.connection.value)
        n.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNull("NeedsRegion: no sweep", n.controller.session.value)
        assertEquals(emptyList<String>(), n.reader.calls)

        val d = Rig(this)
        d.controller.start(); settle()
        backgroundScope.launch { d.controller.connectNow() }; settle()
        d.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNull("disarmed: no sweep", d.controller.session.value)
        assertEquals(emptyList<String>(), d.reader.calls)
    }

    /** Whether a pull opens a sweep on a sled connected with [setting], whose
     *  layout writes answer [layoutResult], and whose `info.hasScanner` is
     *  then set to [hasScanner] when it is not null. */
    private fun TestScope.sweepsWith(
        setting: SledTriggerLayout,
        layoutResult: Result<SledTriggerReadback>?,
        hasScanner: Boolean? = null,
    ): Boolean {
        val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = setting))
        r.fake.layoutResult = layoutResult
        connectedAndArmed(r)
        if (hasScanner != null) {
            r.fake.setInfo(r.fake.info.value!!.copy(hasScanner = hasScanner)); settle()
        }
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        val swept = r.controller.session.value != null
        assertEquals("a pull either reads or asks the sled for nothing", swept, r.reader.calls == listOf("start"))
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        return swept
    }

    /** Spec test 11, second half (ruling 27): the trigger gate follows the
     *  layout in force: the accepted read-back when there is one, else the
     *  effective layout of the last request. */
    @Test fun theTriggerGateFollowsTheLayoutInForce() = runTest {
        val notChecked = Result.failure<SledTriggerReadback>(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        assertTrue(
            "a read-back of RFID with a setting of Barcode still sweeps",
            sweepsWith(SledTriggerLayout.BARCODE, Result.success(readbackOf(SledKey.RFID, SledKey.RFID, 4))),
        )
        assertFalse("a read-back of Barcode does not sweep", sweepsWith(SledTriggerLayout.BARCODE, layoutResult = null))
        assertFalse("no read-back, with Barcode requested, does not sweep", sweepsWith(SledTriggerLayout.BARCODE, notChecked))
        assertTrue(
            "a sled with no scanner on a Barcode kiosk sweeps",
            sweepsWith(SledTriggerLayout.BARCODE, notChecked, hasScanner = false),
        )
        assertTrue("no read-back, with RFID requested, sweeps", sweepsWith(SledTriggerLayout.RFID, notChecked))
        assertTrue("a read-back of Both sweeps", sweepsWith(SledTriggerLayout.SPLIT, layoutResult = null))

        // A link that came up without a controller connect: the setting decides.
        for ((setting, sweeps) in listOf(SledTriggerLayout.BARCODE to false, SledTriggerLayout.RFID to true)) {
            val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = setting))
            r.fake.layoutResult = notChecked
            r.controller.start(); r.controller.arm(); settle()
            r.fake.setConnection(RfidConnection.Connected("Fake RFD40", 80)); settle()
            r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
            assertEquals("no controller connect, setting $setting", sweeps, r.controller.session.value != null)
        }
    }

    /** A pull's latch window is measured from the stamp the reader put on it,
     *  not from when the controller got to it; an unstamped pull uses the clock. */
    @Test fun theLatchWindowIsMeasuredFromThePullStamp() = runTest {
        val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerMode = RfidTriggerMode.HOLD_OR_LATCH))
        connectedAndArmed(r)

        r.now = 10_000
        r.fake.emitTrigger(TriggerEvent.PRESSED, atMs = 1_000); settle()
        assertTrue(r.fake.inventoryRunning)
        r.now = 20_000 // delivered late: by the clock the trigger was down for 10 s
        r.fake.emitTrigger(TriggerEvent.RELEASED, atMs = 1_200); settle()
        assertTrue("a 200 ms click by its stamps latches the read", r.fake.inventoryRunning)
        assertNotNull(r.controller.session.value)
        r.fake.emitTrigger(TriggerEvent.PRESSED, atMs = 5_000); settle()
        assertNull("a press ends the latched read", r.controller.session.value)

        r.now = 30_000
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue(r.fake.inventoryRunning)
        r.now = 30_100
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertTrue("an unstamped 100 ms click latches by the clock", r.fake.inventoryRunning)
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        r.now = 40_000
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        r.now = 41_000
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertNull("an unstamped 1 s hold ends by the clock", r.controller.session.value)
    }

    /** Spec test 9 (ruling 29): a start that gives no answer within the start
     *  wait is followed by one stop; the sweep closes with the reason. */
    @Test fun aStartThatTimesOutIsFollowedByOneStop() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        val t0 = currentTime

        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNotNull("the panel opens while the start waits", r.controller.session.value)
        at(t0 + RfidController.START_WAIT_MS - 1)
        assertEquals(listOf("start"), r.reader.calls)
        assertNotNull(r.controller.session.value)
        assertNull(r.controller.readError.value)

        at(t0 + RfidController.START_WAIT_MS)
        assertEquals(listOf("start", "stop"), r.reader.calls)
        assertNull(r.controller.session.value)
        assertEquals(SledWords.READ_DID_NOT_START, r.controller.readError.value)
        assertEquals(emptyList<String>(), r.fake.violations)
        hold.complete(Unit); settle()
        assertEquals(listOf("start", "stop"), r.reader.calls)
    }

    /** Spec test 13 (T4): a start the sled refuses is followed by one stop and
     *  closes with the sled's reason; the next press starts a read. */
    @Test fun aFailedStartIsFollowedByOneStopAndClosesWithTheReason() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.startResult = Result.failure(IllegalStateException(SledWords.CHARGING))

        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals(listOf("start", "stop"), r.reader.calls)
        assertNull(r.controller.session.value)
        assertEquals(SledWords.CHARGING, r.controller.readError.value)
        assertTrue("nothing was read", r.bursts.flatten().isEmpty())

        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        r.fake.startResult = Result.success(Unit)
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue("the next press starts a read", r.fake.inventoryRunning)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Spec test 13 (T4): a start the sled took but has not confirmed (no tag
     *  yet) keeps the sweep, however long it stays quiet. */
    @Test fun anUnconfirmedStartKeepsTheSweep() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        val t0 = currentTime
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        at(t0 + 4 * RfidController.START_WAIT_MS)
        assertNotNull("no tag yet, and still reading", r.controller.session.value)
        assertEquals(listOf("start"), r.reader.calls)
        assertNull(r.controller.readError.value)

        r.fake.emitTag("100348"); settle()
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(listOf(listOf("100348")), r.bursts)
    }

    /** Row 5: a start that throws is a start failure: one stop, the sweep
     *  closed, the reason shown, and trigger handling still alive. */
    @Test fun aThrownStartIsAStartFailure() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.reader.throwOnStart = true

        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals(listOf("start", "stop"), r.reader.calls)
        assertNull(r.controller.session.value)
        assertEquals(SledWords.READ_DID_NOT_START, r.controller.readError.value)

        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue("the next press starts a read", r.fake.inventoryRunning)
    }

    @Test fun readErrorClearsOnTheNextSuccessfulStart() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.startResult = Result.failure(IllegalStateException(SledWords.CHARGING))
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(SledWords.CHARGING, r.controller.readError.value)

        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals("a second refusal keeps the sentence", SledWords.CHARGING, r.controller.readError.value)
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()

        r.fake.startResult = Result.success(Unit)
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNull(r.controller.readError.value)
        assertTrue(r.fake.inventoryRunning)
    }

    /** Row 6: a stop the sled answers with a failure is sent once more; when
     *  that fails too the sled may still be reading, and the next press sends
     *  one stop before it starts a read. */
    @Test fun aReturnedStopFailureIsRetriedOnceThenMayStillBeReading() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.stopResult = Result.failure(IllegalStateException("The sled didn't answer the stop."))

        r.fake.emitTrigger(TriggerEvent.PRESSED); r.fake.emitTag("100348"); settle()
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(listOf("start", "stop", "stop"), r.reader.calls)
        assertNull("the sweep still closes", r.controller.session.value)
        assertEquals(listOf(listOf("100348")), r.bursts)
        assertEquals(SledWords.MAY_STILL_BE_READING, r.controller.readError.value)

        r.fake.stopResult = Result.success(Unit)
        r.reader.calls.clear()
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals("one stop before the start", listOf("stop", "start"), r.reader.calls)
        assertNull(r.controller.readError.value)
        assertTrue(r.fake.inventoryRunning)

        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals("remembered once, not forever", listOf("stop", "start", "stop", "start"), r.reader.calls)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Spec test 12 (ruling 45): the sled ending a sweep by itself ends the
     *  sweep, queues its tags, sends one stop, and shows no sentence. */
    @Test fun anUnsolicitedStopEndsTheSweepQueuesItsTagsAndSetsNoReadError() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.emitTrigger(TriggerEvent.PRESSED); r.fake.emitTag("100348"); r.fake.emitTag("100349"); settle()

        r.fake.emitUnsolicitedStop("the sled's own stop trigger"); settle()
        assertNull(r.controller.session.value)
        assertEquals(listOf(listOf("100348", "100349")), r.bursts)
        assertEquals(listOf("start", "stop"), r.reader.calls)
        assertFalse("the controller sent its stop", r.fake.inventoryRunning)
        assertNull(r.controller.readError.value)
    }

    /** A call the reader turns away as not connected shows nothing: not on a
     *  start, a stop, a push or a layout write. */
    @Test fun sledNotConnectedSetsNoError() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)

        r.fake.startResult = Result.failure(SledNotConnected())
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNull(r.controller.session.value)
        assertNull(r.controller.readError.value)
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()

        r.fake.startResult = Result.success(Unit)
        r.fake.stopResult = Result.failure(SledNotConnected())
        r.reader.calls.clear()
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals("not connected is not retried", listOf("start", "stop"), r.reader.calls)
        assertNull(r.controller.readError.value)

        r.fake.applyResult = Result.failure(SledNotConnected())
        r.settings.value = r.settings.value.copy(powerDbm = 12); settle()
        assertNull(r.controller.applyError.value)

        r.fake.layoutResult = Result.failure(SledNotConnected())
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        assertEquals(SledTriggerLayout.SPLIT, r.fake.layoutCalls.last())
        assertNull(r.controller.layoutError.value)
    }
}
