package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledNudge
import com.serversherpa.kiosk.core.rfid.SledRetry
import com.serversherpa.kiosk.core.rfid.SledWords
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reconnect schedule (spec, Controller › Reconnect; rulings 4 and 41),
 * spec test 7, on virtual time throughout: the controller's clock is the test
 * scheduler's, and every wait is `OutboxMachine.BACKOFF` (2, 4, 15, 60 s).
 * Times below are absolute virtual milliseconds; a drop at 0 is tried at
 * 2 000, 6 000, 21 000 and 81 000.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidReconnectTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    /** Moves virtual time to [ms] (absolute) and runs what is due then. */
    private fun TestScope.at(ms: Long) { advanceTimeBy(ms - currentTime); settle() }

    /** Takes the next connect result from [script] when it has one, for that
     *  one call, else the fake's own `connectResult`, so one attempt can fail
     *  differently from the next within a single virtual instant. */
    private class ScriptedReader(private val inner: FakeRfidReader) : RfidReader by inner {
        val script = ArrayDeque<Result<Unit>>()

        override suspend fun connect(request: SledConnectRequest): Result<Unit> {
            val scripted = script.removeFirstOrNull() ?: return inner.connect(request)
            val usual = inner.connectResult
            inner.connectResult = scripted
            return try {
                inner.connect(request)
            } finally {
                inner.connectResult = usual
            }
        }
    }

    private class Rig(t: TestScope, initial: RfidSettings = DEFAULT_RFID_SETTINGS.copy(enabled = true)) {
        val fake = FakeRfidReader()
        val reader = ScriptedReader(fake)
        val settings = MutableStateFlow(initial)
        var printerBusy = false
        val controller = RfidController(reader, settings, t.backgroundScope, printerBusy = { printerBusy }) {
            t.testScheduler.currentTime
        }
    }

    private fun retryable(reason: String = SledWords.couldNotReach("Fake RFD40")): Result<Unit> =
        Result.failure(SledConnectException(RfidConnection.Failed(reason, retryable = true)))

    private fun notRetryable(reason: String, fix: SledFix?): Result<Unit> =
        Result.failure(SledConnectException(RfidConnection.Failed(reason, retryable = false, fix = fix)))

    private val batchCleared: Result<Unit>
        get() = retryable(SledWords.BATCH_CLEARED_RETRYING)

    /** Starts [r], connects it through the lifecycle (which stores the gate),
     *  makes every later connect fail retryably, and drops the link now. */
    private fun TestScope.connectedThenDropped(r: Rig, sledScreen: Boolean = false) {
        r.controller.start()
        if (sledScreen) r.controller.setSledScreenOpen(true)
        settle()
        r.controller.connectForLifecycle { true }; settle()
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        assertEquals(1, r.fake.connectCalls)
        r.fake.connectResult = retryable()
        r.fake.dropLink("The sled disconnected."); settle()
    }

    @Test fun aDropRetriesAfter2_4_15And60SecondsThenGivesUp() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        assertTrue(r.controller.reconnecting.value)

        at(1_999); assertEquals("no dial before 2 s", 1, r.fake.connectCalls)
        at(2_000); assertEquals(2, r.fake.connectCalls)
        at(5_999); assertEquals(2, r.fake.connectCalls)
        at(6_000); assertEquals(3, r.fake.connectCalls)
        at(20_999); assertEquals(3, r.fake.connectCalls)
        at(21_000); assertEquals(4, r.fake.connectCalls)
        assertTrue(r.controller.reconnecting.value)
        at(80_999); assertEquals(4, r.fake.connectCalls)
        at(81_000); assertEquals(5, r.fake.connectCalls)

        assertFalse("four failed tries give up", r.controller.reconnecting.value)
        assertNull(r.controller.retry.value)
        assertEquals(SledWords.couldNotReach("Fake RFD40"), r.controller.connectionError.value)
        at(201_000)
        assertEquals("nothing after giving up", 5, r.fake.connectCalls)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** With the wait already running, each of the four ways to stop wanting
     *  the link ends the schedule before it dials again. */
    @Test fun nothingDialsAfterLifecycleDisconnectDisconnectNowStopOrDisable() = runTest {
        val stops: List<Pair<String, suspend (Rig) -> Unit>> = listOf(
            "disconnectForLifecycle" to { it.controller.disconnectForLifecycle() },
            "disconnectNow" to { it.controller.disconnectNow() },
            "stopReconnecting" to { it.controller.stopReconnecting() },
            "turning the reader off" to { it.settings.value = it.settings.value.copy(enabled = false) },
        )
        for ((name, stop) in stops) {
            val r = Rig(this)
            val t0 = currentTime
            connectedThenDropped(r)
            at(t0 + 1_000)
            assertTrue(name, r.controller.reconnecting.value)

            stop(r); settle()
            assertFalse(name, r.controller.reconnecting.value)
            assertNull(name, r.controller.retry.value)
            at(t0 + 300_000)
            assertEquals(name, 1, r.fake.connectCalls)
        }
    }

    /** With a try dialing, each of the four ways to stop wanting the link ends the tries: that
     *  try runs to its end, nothing follows it, and Bluetooth turning on afterwards does not
     *  dial. A disconnect waits for the try. Found on hardware, 2026-11-11 (steps 12 and 13). */
    @Test fun nothingFollowsATryDialingWhenTheLinkStopsBeingWanted() = runTest {
        val stops = listOf("stopReconnecting", "disconnectForLifecycle", "disconnectNow", "turning the reader off")
        for (name in stops) {
            val r = Rig(this)
            val t0 = currentTime
            connectedThenDropped(r)
            val hold = CompletableDeferred<Unit>()
            r.fake.holdNext = hold
            at(t0 + 2_000)
            assertEquals(name, 2, r.fake.connectCalls)
            assertEquals(name, RfidConnection.Connecting, r.fake.connection.value)

            at(t0 + 2_500)
            // disconnectNow() awaits a reply that comes only after the held try.
            val pending = when (name) {
                "stopReconnecting" -> { r.controller.stopReconnecting(); null }
                "disconnectForLifecycle" -> { r.controller.disconnectForLifecycle(); null }
                "disconnectNow" -> launch { r.controller.disconnectNow() }
                else -> { r.settings.value = r.settings.value.copy(enabled = false); null }
            }
            settle()
            assertFalse(name, r.controller.reconnecting.value)
            assertNull(name, r.controller.retry.value)
            assertEquals("$name: nothing disconnects while the try dials", 0, r.fake.disconnectCalls)

            at(t0 + 12_700)
            hold.complete(Unit); settle()
            pending?.join()

            at(t0 + 300_000)
            assertEquals("$name: nothing follows the try", 2, r.fake.connectCalls)
            r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
            assertEquals("$name: Bluetooth on dials nothing", 2, r.fake.connectCalls)
            if (name == "stopReconnecting") {
                assertEquals(name, 0, r.fake.disconnectCalls)
                assertEquals(
                    "$name: the try's own failure",
                    RfidConnection.Failed(SledWords.couldNotReach("Fake RFD40"), retryable = true),
                    r.fake.connection.value,
                )
                assertNull(name, r.controller.connectionError.value)
            } else {
                assertEquals("$name: one disconnect, after the try ended", 1, r.fake.disconnectCalls)
                assertEquals(name, RfidConnection.Disconnected, r.fake.connection.value)
            }
            assertEquals(name, emptyList<String>(), r.fake.violations)
        }
    }

    /** `ACL_CONNECTED` also fires for the app's own outgoing connect, so a
     *  nudge while an attempt runs is ignored. */
    @Test fun aNudgeDuringAnAttemptDoesNothing() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        at(2_000)
        assertEquals("try 1 is in flight", 2, r.fake.connectCalls)
        assertEquals(RfidConnection.Connecting, r.fake.connection.value)

        r.controller.nudge(SledNudge.BLUETOOTH_ON)
        r.controller.nudge(SledNudge.LINK_APPEARED, address = "AA:BB:CC:DD:EE:FF", name = "RFD40 21234")
        settle()
        assertEquals(2, r.fake.connectCalls)

        at(2_500)
        hold.complete(Unit); settle()
        at(6_499); assertEquals(2, r.fake.connectCalls)
        at(6_500); assertEquals("try 2 waits its 4 s from the end of try 1", 3, r.fake.connectCalls)
    }

    /** A nudge during a wait dials at once instead of at the wait's end. That
     *  try is the schedule's next one: the count goes on, so the wait after it
     *  is 15 s. A link appearing for a device that is not a sled is no nudge. */
    @Test fun aNudgeDuringAWaitDialsOnceAndKeepsTheCount() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        at(2_000); assertEquals(2, r.fake.connectCalls)

        at(4_500)
        r.controller.nudge(SledNudge.LINK_APPEARED, address = "11:22:33:44:55:66", name = "Car stereo"); settle()
        assertEquals("not a sled", 2, r.fake.connectCalls)
        r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        assertEquals(3, r.fake.connectCalls)
        assertTrue(r.controller.reconnecting.value)

        at(6_000); assertEquals("the shortened wait does not dial again", 3, r.fake.connectCalls)
        at(19_499); assertEquals(3, r.fake.connectCalls)
        at(19_500); assertEquals("then 15 s: the nudge's try counted", 4, r.fake.connectCalls)
    }

    /** The link appearing also fires for the app's own outgoing connect, so within 2 s of
     *  an attempt ending it is ignored. */
    @Test fun aLinkAppearedNudgeWithin2sOfAnAttemptEndingIsIgnored() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        at(2_000); assertEquals(2, r.fake.connectCalls)

        at(3_999)
        r.controller.nudge(SledNudge.LINK_APPEARED, address = "AA:BB:CC:DD:EE:FF", name = "RFD40 21234"); settle()
        assertEquals(2, r.fake.connectCalls)
        at(5_999); assertEquals(2, r.fake.connectCalls)
        at(6_000); assertEquals("the schedule goes on as planned", 3, r.fake.connectCalls)
    }

    /** Ruling 41 as amended: Bluetooth turning on is no echo of an attempt, so the 2 s
     *  guard does not apply to it. Hardware script step 13: Bluetooth off drops the link,
     *  try 1 fails "Bluetooth is off" (not retryable, the schedule ends), and Bluetooth comes
     *  back on a second later. That is the only way back by itself, so it tries. */
    @Test fun bluetoothComingOnRightAfterABluetoothOffFailureTriesAgain() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        r.fake.connectResult = notRetryable(SledWords.BLUETOOTH_OFF, SledFix.TURN_ON_BLUETOOTH)
        at(2_000)
        assertEquals(2, r.fake.connectCalls)
        assertFalse("the schedule ended", r.controller.reconnecting.value)
        assertEquals(SledWords.BLUETOOTH_OFF, r.controller.connectionError.value)

        r.fake.connectResult = Result.success(Unit)
        at(3_000)
        r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        assertEquals("one try, within 2 s of the failure", 3, r.fake.connectCalls)
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        assertNull(r.controller.connectionError.value)

        // Bluetooth on inside a running wait: that wait ends at once, as before.
        val w = Rig(this)
        val t0 = currentTime
        connectedThenDropped(w)
        at(t0 + 2_000); assertEquals(2, w.fake.connectCalls)
        at(t0 + 2_500)
        w.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        assertEquals(3, w.fake.connectCalls)
    }

    /** Hardware script step 32: the saved sled was forgotten in Bluetooth settings and the
     *  other one is paired. A link appearing for the other one nudges (the sled-name rule),
     *  since a sled no longer paired is no longer the one to wait for. */
    @Test fun aForgottenSavedSledNoLongerFiltersTheNudge() = runTest {
        val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, readerAddress = "AA:BB:CC:00:00:01"))
        r.fake.paired = listOf(SledCandidate("RFD4031-B", "AA:BB:CC:00:00:02"))
        r.fake.connectResult = retryable()
        r.controller.start(); settle()
        r.controller.connectForLifecycle { true }; settle()
        assertEquals("one attempt off a sled screen", 1, r.fake.connectCalls)
        assertEquals("the saved sled is not paired: none known", null, r.controller.nudgeAddress())

        at(5_000)
        r.fake.connectResult = Result.success(Unit)
        r.controller.nudge(SledNudge.LINK_APPEARED, address = "AA:BB:CC:00:00:02", name = "RFD4031-B"); settle()
        assertEquals(2, r.fake.connectCalls)

        // While the saved sled is still paired, only its own link counts.
        val k = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, readerAddress = "AA:BB:CC:00:00:01"))
        k.fake.paired = listOf(SledCandidate("RFD4031-A", "AA:BB:CC:00:00:01"), SledCandidate("RFD4031-B", "AA:BB:CC:00:00:02"))
        k.fake.connectResult = retryable()
        k.controller.start(); settle()
        val tk = currentTime
        k.controller.connectForLifecycle { true }; settle()
        assertEquals("AA:BB:CC:00:00:01", k.controller.nudgeAddress())
        at(tk + 5_000)
        k.controller.nudge(SledNudge.LINK_APPEARED, address = "AA:BB:CC:00:00:02", name = "RFD4031-B"); settle()
        assertEquals(1, k.fake.connectCalls)
        k.controller.nudge(SledNudge.LINK_APPEARED, address = "aa:bb:cc:00:00:01", name = "RFD4031-A"); settle()
        assertEquals(2, k.fake.connectCalls)
    }

    /** Ruling 41: after giving up, a nudge starts one try; when that fails the
     *  app stays given up, so a sled that takes the link and refuses the
     *  channel cannot loop. */
    @Test fun afterGivingUpANudgeTriesOnceAndStaysGivenUpOnFailure() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        at(81_000)
        assertEquals(5, r.fake.connectCalls)
        assertFalse(r.controller.reconnecting.value)

        at(90_000)
        r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        assertEquals(6, r.fake.connectCalls)
        assertFalse(r.controller.reconnecting.value)
        assertEquals(SledWords.couldNotReach("Fake RFD40"), r.controller.connectionError.value)
        at(400_000)
        assertEquals(6, r.fake.connectCalls)
    }

    /** Stop while a nudge's try after giving up is still dialing: when that try fails, the
     *  link is no longer wanted, so no failure sentence is left behind. */
    @Test fun stopDuringANudgesTryAfterGivingUpLeavesNoSentence() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        at(81_000)
        assertFalse(r.controller.reconnecting.value)
        assertEquals(SledWords.couldNotReach("Fake RFD40"), r.controller.connectionError.value)

        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        at(90_000)
        r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        assertEquals("the nudge's try is dialing", RfidConnection.Connecting, r.fake.connection.value)
        r.controller.stopReconnecting(); settle()
        hold.complete(Unit); settle()
        assertNull(r.controller.connectionError.value)
        at(400_000)
        assertEquals(6, r.fake.connectCalls)
    }

    /** A connect that never came up gets the schedule only while a sled screen
     *  is open; elsewhere it is one attempt, as today. */
    @Test fun aNeverUpFailureRetriesOnlyWithASledScreenOpen() = runTest {
        val r = Rig(this)
        r.fake.connectResult = retryable()
        r.controller.start(); settle()
        r.controller.connectForLifecycle { true }; settle()
        assertEquals(1, r.fake.connectCalls)
        assertFalse(r.controller.reconnecting.value)
        assertEquals(SledWords.couldNotReach("Fake RFD40"), r.controller.connectionError.value)
        at(300_000)
        assertEquals("no sled screen: one attempt", 1, r.fake.connectCalls)

        val s = Rig(this)
        s.fake.connectResult = retryable()
        s.controller.start(); s.controller.setSledScreenOpen(true); settle()
        val t1 = currentTime
        s.controller.connectForLifecycle { true }; settle()
        assertEquals(1, s.fake.connectCalls)
        assertTrue(s.controller.reconnecting.value)
        assertNull("the schedule raises no error of its own", s.controller.connectionError.value)
        at(t1 + 2_000); assertEquals(2, s.fake.connectCalls)
        at(t1 + 6_000); assertEquals(3, s.fake.connectCalls)
    }

    @Test fun openingASledScreenAfterANeverUpFailureStartsTheScheduleOnce() = runTest {
        val r = Rig(this)
        r.fake.connectResult = retryable()
        r.controller.start(); settle()
        r.controller.connectForLifecycle { true }; settle()
        assertFalse(r.controller.reconnecting.value)
        assertEquals(SledWords.couldNotReach("Fake RFD40"), r.controller.connectionError.value)

        at(10_000)
        r.controller.setSledScreenOpen(true)
        r.controller.setSledScreenOpen(false)
        r.controller.setSledScreenOpen(true)
        settle()
        assertTrue(r.controller.reconnecting.value)
        // The failure's sentence is the connection line's now: no red "tap Connect" under
        // "Connecting to…", which offers only Stop.
        assertNull("the schedule raises no error of its own", r.controller.connectionError.value)
        at(11_999); assertEquals(1, r.fake.connectCalls)
        at(12_000); assertEquals("one schedule, at try 1", 2, r.fake.connectCalls)
        at(15_999); assertEquals(2, r.fake.connectCalls)
        // A try that outlasts the connect wait raises none either.
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        at(16_000); assertEquals(3, r.fake.connectCalls)
        at(16_000 + RfidController.CONNECT_WAIT_MS + 1)
        assertTrue(r.controller.reconnecting.value)
        assertNull(r.controller.connectionError.value)
        hold.complete(Unit); settle()
    }

    /** The first batch clear fails retryably with its own sentence; one more
     *  try follows at once, on any screen, and inside the schedule it does not
     *  advance the count. */
    @Test fun aFirstBatchClearGetsOneImmediateTryAnywhereWithoutAdvancingTheCount() = runTest {
        val r = Rig(this)
        r.reader.script += batchCleared
        r.reader.script += Result.success(Unit)
        r.controller.start(); settle()
        r.controller.connectForLifecycle { true }; settle()
        assertEquals("no sled screen, and still one more try at once", 2, r.fake.connectCalls)
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        assertFalse(r.controller.reconnecting.value)

        val q = Rig(this)
        q.reader.script += batchCleared
        q.fake.connectResult = retryable()
        q.controller.start(); settle()
        val tq = currentTime
        q.controller.connectForLifecycle { true }; settle()
        assertEquals(2, q.fake.connectCalls)
        at(tq + 300_000)
        assertEquals("the try after it is an ordinary never-up connect", 2, q.fake.connectCalls)

        val s = Rig(this)
        val ts = currentTime
        connectedThenDropped(s)
        s.reader.script += batchCleared
        at(ts + 2_000)
        assertEquals("try 1, then its immediate retry", 3, s.fake.connectCalls)
        at(ts + 5_999); assertEquals(3, s.fake.connectCalls)
        at(ts + 6_000); assertEquals("the next wait is 4 s: the batch clear did not count", 4, s.fake.connectCalls)
    }

    @Test fun aNotRetryableFailureInsideTheScheduleEndsIt() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        r.fake.connectResult = notRetryable(SledWords.BLUETOOTH_OFF, SledFix.TURN_ON_BLUETOOTH)
        at(2_000)
        assertEquals(2, r.fake.connectCalls)
        assertFalse(r.controller.reconnecting.value)
        assertNull(r.controller.retry.value)
        assertEquals(
            RfidConnection.Failed(SledWords.BLUETOOTH_OFF, retryable = false, fix = SledFix.TURN_ON_BLUETOOTH),
            r.fake.connection.value,
        )
        assertEquals(SledWords.BLUETOOTH_OFF, r.controller.connectionError.value)
        at(300_000)
        assertEquals(2, r.fake.connectCalls)
    }

    /** No try while a label is printing: the wait stretches until the printer
     *  is free. */
    @Test fun noAttemptStartsWhileThePrinterIsBusy() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        r.printerBusy = true
        at(2_000); assertEquals(1, r.fake.connectCalls)
        at(10_000); assertEquals(1, r.fake.connectCalls)
        assertTrue(r.controller.reconnecting.value)

        r.printerBusy = false
        at(11_000)
        assertEquals("the try runs once the printer is free", 2, r.fake.connectCalls)
    }

    /** Pre-check failures are things the operator has to fix (`retryable =
     *  false`): no timer, even on a sled screen, from a lifecycle connect or
     *  from Connect. */
    @Test fun precheckFailuresNeverRetryOnATimer() = runTest {
        val prechecks = listOf(
            SledWords.BLUETOOTH_OFF to SledFix.TURN_ON_BLUETOOTH,
            SledWords.PERMISSION_MISSING to SledFix.ALLOW,
            SledWords.NO_SLED_PAIRED to SledFix.BLUETOOTH_SETTINGS,
            SledWords.SEVERAL_PAIRED to SledFix.CHOOSE_SLED,
            SledWords.NAMELESS_DEVICE to SledFix.BLUETOOTH_SETTINGS,
            SledWords.duplicateName("RFD40 21234") to SledFix.BLUETOOTH_SETTINGS,
        )
        for ((sentence, fix) in prechecks) {
            val r = Rig(this)
            r.fake.connectResult = notRetryable(sentence, fix)
            r.controller.start(); r.controller.setSledScreenOpen(true); settle()
            val t0 = currentTime
            r.controller.connectForLifecycle { true }; settle()
            r.controller.connectNow(); settle()
            assertEquals(sentence, 2, r.fake.connectCalls)
            assertFalse(sentence, r.controller.reconnecting.value)
            at(t0 + 300_000)
            assertEquals(sentence, 2, r.fake.connectCalls)
            assertEquals(sentence, sentence, r.controller.connectionError.value)
        }
    }

    /** Connect tapped during the schedule cancels the pending wait; when it
     *  fails retryably on a sled screen, the schedule starts over at try 1. */
    @Test fun aManualFailureRestartsTheScheduleOnASledScreen() = runTest {
        val r = Rig(this)
        connectedThenDropped(r, sledScreen = true)
        at(2_000); assertEquals(2, r.fake.connectCalls)
        at(6_000); assertEquals(3, r.fake.connectCalls)

        at(8_000)
        assertTrue(r.controller.connectNow().isFailure)
        assertEquals(4, r.fake.connectCalls)
        assertTrue(r.controller.reconnecting.value)

        at(9_999); assertEquals(4, r.fake.connectCalls)
        at(10_000); assertEquals("try 1 again, 2 s later", 5, r.fake.connectCalls)
        at(13_999); assertEquals(5, r.fake.connectCalls)
        at(14_000); assertEquals(6, r.fake.connectCalls)
        at(21_000); assertEquals("the old try-3 wait never dials", 6, r.fake.connectCalls)
    }

    /** What `sledLine` needs to pick its sentence: a drop or a never-up
     *  connect (fixed when the schedule starts, though each attempt clears
     *  `info`), the sled's name, and the last failure seen. */
    @Test fun theRetryStateNamesADropOrANeverUpConnect() = runTest {
        val d = Rig(this)
        assertNull(d.controller.retry.value)
        val td = currentTime
        connectedThenDropped(d)
        assertEquals(SledRetry(afterDrop = true, name = "Fake RFD40", lastReason = "The sled disconnected."), d.controller.retry.value)
        at(td + 2_000)
        assertEquals(
            "still a drop after a try cleared info",
            SledRetry(afterDrop = true, name = "Fake RFD40", lastReason = SledWords.couldNotReach("Fake RFD40")),
            d.controller.retry.value,
        )

        val n = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, readerAddress = "AA:BB:CC:DD:EE:FF"))
        n.fake.paired = listOf(SledCandidate("RFD40 21234", "aa:bb:cc:dd:ee:ff"))
        n.fake.connectResult = retryable(SledWords.TRIGGER_NOT_SET_UP)
        n.controller.start(); n.controller.setSledScreenOpen(true); settle()
        n.controller.connectForLifecycle { true }; settle()
        assertTrue(n.controller.reconnecting.value)
        assertEquals(
            SledRetry(afterDrop = false, name = "RFD40 21234", lastReason = SledWords.TRIGGER_NOT_SET_UP),
            n.controller.retry.value,
        )
    }

    /** The drop's own reason is on the connection line once; the retries raise
     *  no `connectionError` of their own until the schedule gives up. */
    @Test fun theLossReasonIsShownOnceAndNotRaisedAgainByRetries() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        assertEquals(RfidConnection.Failed("The sled disconnected.", retryable = true), r.fake.connection.value)
        assertNull(r.controller.connectionError.value)
        for (t in listOf(2_000L, 6_000L, 21_000L)) {
            at(t)
            assertNull("at $t", r.controller.connectionError.value)
        }
        at(81_000)
        assertEquals(SledWords.couldNotReach("Fake RFD40"), r.controller.connectionError.value)
    }

    /** Review Focus 4: the phone goes to the background during a wait and comes
     *  back before the wait would have ended. The old wait never dials, and
     *  exactly one lifecycle connect runs, whether that connect comes up or
     *  fails (off a sled screen, so a failure is one attempt and the link is
     *  still down when the old wait would have ended). */
    @Test fun backgroundingDuringAWaitCancelsItAndForegroundDialsOnce() = runTest {
        for (foreground in listOf(Result.success(Unit), retryable())) {
            val r = Rig(this)
            val t0 = currentTime
            connectedThenDropped(r)
            at(t0 + 1_000)
            r.controller.disconnectForLifecycle(); settle()
            assertEquals(RfidConnection.Disconnected, r.fake.connection.value)
            assertFalse(r.controller.reconnecting.value)

            at(t0 + 1_500)
            r.fake.connectResult = foreground
            r.controller.connectForLifecycle { true }; settle()
            assertEquals("one lifecycle connect", 2, r.fake.connectCalls)

            at(t0 + 300_000)
            assertEquals("the old wait never dialed", 2, r.fake.connectCalls)
            assertEquals(emptyList<String>(), r.fake.violations)
        }
    }
}
