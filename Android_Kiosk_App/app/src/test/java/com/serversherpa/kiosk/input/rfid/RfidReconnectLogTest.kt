package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledNudge
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

/**
 * The reconnect decisions' log lines (spec, Controller › Reconnect, Logging): one
 * `RfidController` line for each link decision the log cannot otherwise show. Found on
 * hardware, 2026-11-11 (steps 12 and 13): Stop tapped 0.5 s into the first try looked like a
 * lost try, because Stop, the try it overtook and the ignored Bluetooth-on nudge logged
 * nothing. On virtual time; the fake's connect clears `info` at once, as the adapter's does.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RfidReconnectLogTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    /** Moves virtual time to [ms] (absolute) and runs what is due then. */
    private fun TestScope.at(ms: Long) { advanceTimeBy(ms - currentTime); settle() }

    private class Rig(t: TestScope) {
        val fake = FakeRfidReader()
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        var printerBusy = false
        val controller = RfidController(fake, settings, t.backgroundScope, printerBusy = { printerBusy }) {
            t.testScheduler.currentTime
        }
    }

    private val couldNotReach = SledWords.couldNotReach("Fake RFD40")

    private fun retryable(): Result<Unit> =
        Result.failure(SledConnectException(RfidConnection.Failed(couldNotReach, retryable = true, fix = SledFix.CONNECT)))

    /** The controller's lines since the last [ShadowLog.clear]. */
    private fun lines(): List<String> = ShadowLog.getLogsForTag("RfidController").map { it.msg }

    @Before fun clearLog() = ShadowLog.clear()

    /** Starts [r] and connects it through the lifecycle (which stores the gate), then
     *  clears the log: what follows is the case's own. */
    private fun TestScope.connected(r: Rig) {
        r.controller.start(); settle()
        r.controller.connectForLifecycle { true }; settle()
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        ShadowLog.clear()
    }

    /** Connected, then every later connect fails retryably and the link drops now. */
    private fun TestScope.connectedThenDropped(r: Rig) {
        connected(r)
        r.fake.connectResult = retryable()
        r.fake.dropLink(couldNotReach); settle()
    }

    /**
     * The Pixel run, process 17983, in ms from the drop: try 1 dials at 2 000, Stop at 2 522,
     * try 1 fails at 12 705, Bluetooth on at 40 307, Connect at 65 021. The manual connect's
     * own line is read while it still dials, before the connected link's own jobs log.
     */
    @Test fun stopDuringATryLogsEachDecisionInOrder() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        val d = currentTime
        val try1 = CompletableDeferred<Unit>()
        r.fake.holdNext = try1
        at(d + 2_000)
        assertEquals(RfidConnection.Connecting, r.fake.connection.value)
        at(d + 2_522)
        r.controller.stopReconnecting(); settle()
        at(d + 12_705)
        try1.complete(Unit); settle()
        at(d + 40_307)
        r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        at(d + 65_021)
        r.fake.connectResult = Result.success(Unit)
        val manual = CompletableDeferred<Unit>()
        r.fake.holdNext = manual
        val connect = launch { r.controller.connectNow() }
        settle()
        assertEquals(
            listOf(
                "The link dropped; reconnecting.",
                "Attempt (RETRY): dialing.",
                "Stop: the link is no longer wanted; the tries end; the attempt dialing now runs to its end.",
                "Attempt (RETRY) ended after the tries were stopped; nothing follows it.",
                "Nudge (BLUETOOTH_ON) ignored: the link is not wanted.",
                "Attempt (MANUAL): dialing.",
            ),
            lines(),
        )
        manual.complete(Unit); settle()
        connect.join()
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    @Test fun aNudgeWhileAnAttemptDialsSaysSo() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        val d = currentTime
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        at(d + 2_000)
        ShadowLog.clear()
        r.controller.nudge(SledNudge.BLUETOOTH_ON)
        r.controller.nudge(SledNudge.LINK_APPEARED, address = "AA:BB:CC:DD:EE:FF", name = "RFD40 21234")
        assertEquals(
            listOf(
                "Nudge (BLUETOOTH_ON) ignored: an attempt is dialing.",
                "Nudge (LINK_APPEARED) ignored: an attempt is dialing.",
            ),
            lines(),
        )
        hold.complete(Unit); settle()
    }

    @Test fun aLinkAppearedNudgeWithinTheQuietWindowSaysSo() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        val d = currentTime
        at(d + 2_000)
        at(d + 3_999)
        ShadowLog.clear()
        r.controller.nudge(SledNudge.LINK_APPEARED, address = "AA:BB:CC:DD:EE:FF", name = "RFD40 21234")
        assertEquals(listOf("Nudge (LINK_APPEARED) ignored: an attempt ended less than 2 s ago."), lines())
    }

    /** A try past its wait, held by the printer: it is on its way, so the nudge is ignored. */
    @Test fun aNudgeWithATryOnItsWaySaysSo() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        val d = currentTime
        r.printerBusy = true
        at(d + 2_000)
        ShadowLog.clear()
        r.controller.nudge(SledNudge.BLUETOOTH_ON)
        assertEquals(listOf("Nudge (BLUETOOTH_ON) ignored: a try is already on its way."), lines())
        r.printerBusy = false
        r.controller.stopReconnecting(); settle()
    }

    @Test fun aNudgeWhileTheLinkIsUpSaysSo() = runTest {
        val r = Rig(this)
        connected(r)
        r.controller.nudge(SledNudge.BLUETOOTH_ON)
        assertEquals(listOf("Nudge (BLUETOOTH_ON) ignored: the link is up or connecting."), lines())
    }

    /** A link appearing for a device that is not a sled gets no line: the receiver already
     *  logs it as "not the sled". */
    @Test fun aNudgeFromAnotherDeviceLogsNothing() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        ShadowLog.clear()
        r.controller.nudge(SledNudge.LINK_APPEARED, address = "11:22:33:44:55:66", name = "Car stereo")
        assertEquals(emptyList<String>(), lines())
        r.controller.stopReconnecting(); settle()
    }

    /** Each way of making the link unwanted, during a wait: its line names what it ended. */
    @Test fun eachWayOfStoppingDuringAWaitSaysTheTriesEnd() = runTest {
        val stops: List<Triple<String, suspend (Rig) -> Unit, String>> = listOf(
            Triple("Stop", { it.controller.stopReconnecting() }, "Stop"),
            Triple("Disconnect", { it.controller.disconnectNow() }, "Disconnect"),
            Triple("background", { it.controller.disconnectForLifecycle() }, "The app left the front"),
            Triple("reader off", { it.settings.value = it.settings.value.copy(enabled = false) }, "The reader was turned off"),
        )
        for ((name, stop, line) in stops) {
            val r = Rig(this)
            connectedThenDropped(r)
            at(currentTime + 1_000)
            ShadowLog.clear()
            stop(r); settle()
            assertEquals(name, "$line: the link is no longer wanted; the tries end.", lines().first())
        }
    }

    /** Stop with nothing running ends nothing, and says only that. */
    @Test fun stopWithNothingRunningSaysOnlyThatTheLinkIsUnwanted() = runTest {
        val r = Rig(this)
        connected(r)
        r.controller.stopReconnecting()
        assertEquals(listOf("Stop: the link is no longer wanted."), lines())
    }

    /** Stop during a manual connect: no tries to end; that attempt runs to its end, and then
     *  no more tries. */
    @Test fun stopDuringAManualConnectEndsWithNoMoreTries() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        r.fake.connectResult = retryable()
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        val connect = launch { r.controller.connectNow() }
        settle()
        r.controller.stopReconnecting(); settle()
        hold.complete(Unit); settle()
        connect.join()
        assertEquals(
            listOf(
                "Attempt (MANUAL): dialing.",
                "Stop: the link is no longer wanted; the attempt dialing now runs to its end.",
                "Attempt (MANUAL) ended with the link no longer wanted; no more tries.",
            ),
            lines(),
        )
    }

    @Test fun aFailureThatIsNotRetryableSaysWhy() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        r.fake.connectResult = Result.failure(
            SledConnectException(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, retryable = false, fix = SledFix.TURN_ON_BLUETOOTH)),
        )
        r.controller.connectNow()
        settle()
        assertEquals(
            listOf(
                "Attempt (MANUAL): dialing.",
                "Attempt (MANUAL) failed and is not retried on a timer: ${SledWords.BLUETOOTH_OFF}",
            ),
            lines(),
        )
    }

    @Test fun aNudgesTryAfterGivingUpSaysItIsStillGivenUp() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        val d = currentTime
        at(d + 81_000)
        assertTrue(lines().contains("Stopped reconnecting after 4 tries."))
        ShadowLog.clear()
        at(d + 90_000)
        r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        assertEquals(
            listOf(
                "Nudge (BLUETOOTH_ON): one try.",
                "Attempt (NUDGE): dialing.",
                "Attempt (NUDGE) failed after giving up; still given up.",
            ),
            lines(),
        )
    }

    @Test fun aNeverUpFailureOffASledScreenSaysOneAttemptOnly() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        r.fake.connectResult = retryable()
        r.controller.connectForLifecycle { true }; settle()
        assertEquals(
            listOf(
                "Attempt (LIFECYCLE): dialing.",
                "Attempt (LIFECYCLE) failed off a sled screen; one attempt only.",
            ),
            lines(),
        )
    }

    @Test fun aConnectWithTheLinkAlreadyUpSaysSo() = runTest {
        val r = Rig(this)
        connected(r)
        r.controller.connectNow()
        settle()
        assertEquals(listOf("Attempt (MANUAL): the link is already up."), lines())
    }

    /** A drop with the link unwanted (Stop left a connected sled up) starts no tries. */
    @Test fun aDropWithTheLinkUnwantedSaysSo() = runTest {
        val r = Rig(this)
        connected(r)
        r.controller.stopReconnecting(); settle()
        ShadowLog.clear()
        r.fake.dropLink(couldNotReach); settle()
        assertEquals(listOf("The link dropped; not reconnecting: the link is not wanted."), lines())
    }

    /** A second retryable failure while the drop's schedule waits starts no second one. */
    @Test fun aDropWhileTheTriesRunSaysATryIsAlreadyRunning() = runTest {
        val r = Rig(this)
        connectedThenDropped(r)
        at(currentTime + 1_000)
        ShadowLog.clear()
        r.fake.setConnection(RfidConnection.Failed(SledWords.couldNotReach(null), retryable = true))
        settle()
        assertEquals(listOf("The link dropped; not reconnecting: a try is already running."), lines())
        r.controller.stopReconnecting(); settle()
    }
}
