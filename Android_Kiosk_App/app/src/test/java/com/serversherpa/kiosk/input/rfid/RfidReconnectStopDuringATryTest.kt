package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledNudge
import com.serversherpa.kiosk.core.rfid.SledRouteKind
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.keepDisplayOn
import com.serversherpa.kiosk.core.rfid.sledLine
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
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
 * Found on hardware, 2026-11-11 (steps 12 and 13, the Pixel run, process 17983): Stop tapped
 * 0.5 s into the first try after a drop looked like a lost try. It is the rule (R3, spec
 * ruling 4, ruling 41): Stop ends the tries, the try already dialing runs to its end with
 * nothing after it, and Bluetooth turning on afterwards does not dial, because the link is
 * no longer wanted. This pins that behavior on the device's own timeline, and pins that
 * without Stop the drop's schedule survives a try that fails slowly.
 *
 * The device timeline, in ms from the drop (D): try 1 dials at 2 000; the touch on Stop at
 * 2 522; try 1 fails at 12 705; the display dims at 26 461 (24 s after the touch, so the
 * app's hold was off by then); Bluetooth turns on at 40 307; Connect is tapped at 65 021.
 *
 * Every scenario drives the controller on virtual time with [FakeRfidReader] behind
 * [AdapterLike], whose failing connect is the adapter's as the controller can see it:
 * `Connecting` with `info` cleared at once, then, [TRY_MS] later, `Failed(couldNotReach,
 * retryable = true, fix = CONNECT)` published and returned as a [SledConnectException].
 *
 * If Bluetooth turning on is ever ruled to override Stop, the "Bluetooth on dials nothing"
 * assertion changes in the same commit as the rule.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidReconnectStopDuringATryTest {
    /** The controller's collectors live in backgroundScope, which advanceUntilIdle()
     *  does not drive. Each hop needs a runCurrent(). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    /** Moves virtual time to [ms] (absolute) and runs what is due then. */
    private fun TestScope.at(ms: Long) { advanceTimeBy(ms - currentTime); settle() }

    private companion object {
        /** A made-up sled. */
        const val SLED = "RFD40+_00000000000001"
        const val ADDRESS = "02:00:00:00:00:01"

        /** Try 1 on the device: dialed 09:43:24.256, failed 09:43:34.961. */
        const val TRY_MS = 10_705L

        /** Try 1 dials 2 s after the drop (OutboxMachine.BACKOFF[0]); it fails [TRY_MS] later. */
        const val TRY1_FAILS = 2_000L + TRY_MS

        /** The touch on Stop during try 1: 09:43:24.720. */
        const val STOP_TOUCH = 2_522L

        /** The display dimmed: 09:43:48.659. */
        const val DIMMED = 26_461L

        /** Bluetooth reported on: 09:44:02.505. */
        const val BT_ON = 40_307L

        /** The touch on Connect: 09:44:27.219. */
        const val CONNECT_TOUCH = 65_021L

        /** What the adapter publishes for the drop (`reached(name)`) and for an open error
         *  (`connectFailure(OPEN_ERROR, name, severalPaired = false)`): one and the same value. */
        val COULD_NOT_REACH = RfidConnection.Failed(SledWords.couldNotReach(SLED), retryable = true, fix = SledFix.CONNECT)
    }

    /** The adapter's connect as the controller sees it. Null [failingConnectMs]: the fake's own
     *  connect, which succeeds at once. */
    private class AdapterLike(val fake: FakeRfidReader, private val now: () -> Long) : RfidReader by fake {
        @Volatile var failingConnectMs: Long? = null
        val dials = CopyOnWriteArrayList<Long>()

        override suspend fun connect(request: SledConnectRequest): Result<Unit> {
            dials += now()
            val ms = failingConnectMs ?: return fake.connect(request)
            val hold = CompletableDeferred<Unit>()
            fake.holdNext = hold
            val usual = fake.connectResult
            fake.connectResult = Result.failure(SledConnectException(COULD_NOT_REACH))
            return try {
                coroutineScope {
                    launch { delay(ms); hold.complete(Unit) }
                    fake.connect(request)
                }
            } finally {
                fake.connectResult = usual
            }
        }
    }

    /** How the link drops: the fake's own `dropLink` (it always publishes `fix = null`), or
     *  `setConnection` with exactly what the adapter publishes (info kept either way). */
    private enum class Drop { FAKE_DROP_LINK, AS_THE_ADAPTER }

    /** The stored lifecycle gate: `{ true }`, or AppContainer's
     *  `{ prefs.rfid.first().enabled && RfidPermissions.granted(app) }` on the same settings flow. */
    private enum class Gate { TRUE, AS_APP_CONTAINER }

    private class Rig(t: TestScope) {
        val fake = FakeRfidReader(SLED).apply { paired = listOf(SledCandidate(SLED, ADDRESS)) }
        val reader = AdapterLike(fake) { t.testScheduler.currentTime }
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true, readerAddress = ADDRESS))
        val controller = RfidController(reader, settings, t.backgroundScope, printerBusy = { false }) {
            t.testScheduler.currentTime
        }

        /** SledDisplayEffect's decision on Scanning, the reader on, activity just now. */
        fun displayHeld(): Boolean = keepDisplayOn(
            SledRouteKind.SCAN_OR_LOOKUP, enabled = true, fake.connection.value,
            controller.reconnecting.value, layoutUsesScanner = false, idleMs = 0L,
        )

        /** The dials since index [from], in ms from the drop at [d]. */
        fun dialsAfter(from: Int, d: Long): List<Long> = reader.dials.drop(from).map { it - d }
    }

    /** Launch, the lifecycle connect, a sled screen with one sweep when [sledScreen], then the
     *  drop at the returned virtual time. Every later connect fails as the device's try 1 did. */
    private fun TestScope.connectSweepAndDrop(r: Rig, drop: Drop, gate: Gate, sledScreen: Boolean): Long {
        r.controller.start(); settle()
        when (gate) {
            Gate.TRUE -> r.controller.connectForLifecycle { true }
            Gate.AS_APP_CONTAINER -> r.controller.connectForLifecycle { r.settings.first().enabled && true }
        }
        settle()
        assertTrue("connected at launch", r.fake.connection.value is RfidConnection.Connected)
        at(currentTime + 70_000)
        if (sledScreen) {
            // SledScreenSignal's LaunchedEffect, then ScanScreen's arm, then a sweep.
            r.controller.setSledScreenOpen(true)
            r.controller.arm(RfidOwner.SCANNING)
            settle()
            at(currentTime + 2_500)
            r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
            assertTrue("the sweep started", r.fake.inventoryRunning)
            at(currentTime + 900)
            r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        }
        at(currentTime + 30_000)
        assertTrue("still connected before the drop", r.fake.connection.value is RfidConnection.Connected)
        r.reader.failingConnectMs = TRY_MS
        when (drop) {
            Drop.FAKE_DROP_LINK -> r.fake.dropLink(SledWords.couldNotReach(SLED))
            Drop.AS_THE_ADAPTER -> r.fake.setConnection(COULD_NOT_REACH)
        }
        val d = currentTime
        settle()
        return d
    }

    /**
     * Stop (the scan slot's only button while reconnecting) tapped 0.5 s into try 1: the tries
     * end at once, try 1 runs to its failure with nothing after it, the display is released
     * then, the slot offers Connect, Bluetooth on dials nothing, and Connect dials at once.
     */
    @Test fun stopDuringATryEndsTheTriesAndBluetoothOnDoesNotDial() = runTest {
        for (sledScreen in listOf(true, false)) {
            val label = "sledScreen=$sledScreen"
            val r = Rig(this)
            val d = connectSweepAndDrop(r, Drop.AS_THE_ADAPTER, Gate.AS_APP_CONTAINER, sledScreen)
            val before = r.reader.dials.size
            assertTrue(label, r.controller.reconnecting.value)
            assertTrue("$label: held while reconnecting", r.displayHeld())

            at(d + 2_000)
            assertEquals("$label: try 1", listOf(2_000L), r.dialsAfter(before, d))
            assertEquals(label, RfidConnection.Connecting, r.fake.connection.value)
            assertNull("$label: info cleared at the start of the connect", r.fake.info.value)

            at(d + STOP_TOUCH)
            r.controller.stopReconnecting(); settle()
            assertFalse("$label: Stop ends the tries at once", r.controller.reconnecting.value)
            assertNull(label, r.controller.retry.value)
            assertTrue("$label: still held: Connecting", r.displayHeld())

            at(d + TRY1_FAILS)
            assertEquals(label, COULD_NOT_REACH, r.fake.connection.value)
            assertFalse(label, r.controller.reconnecting.value)
            assertNull("$label: no sentence of the controller's own: the link is not wanted", r.controller.connectionError.value)
            assertFalse("$label: released when try 1 fails", r.displayHeld())
            val line = sledLine(
                r.fake.connection.value, r.controller.reconnecting.value, enabled = true,
                permissionMissing = false, retry = r.controller.retry.value,
            )
            assertEquals("$label: the slot says couldn't reach", SledWords.couldNotReach(SLED), line.text)
            assertEquals("$label: with Connect", SledFix.CONNECT, line.fix)
            assertFalse("$label: and no Stop", line.offersStop)

            at(d + DIMMED)
            assertFalse(label, r.displayHeld())
            at(d + BT_ON)
            r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
            assertEquals("$label: no try 2, and Bluetooth on dials nothing", listOf(2_000L), r.dialsAfter(before, d))

            at(d + CONNECT_TOUCH)
            r.reader.failingConnectMs = null
            assertTrue("$label: Connect", r.controller.connectNow().isSuccess)
            assertEquals("$label: Connect dials at once", listOf(2_000L, CONNECT_TOUCH), r.dialsAfter(before, d))
            assertTrue(label, r.fake.connection.value is RfidConnection.Connected)
            assertEquals(label, emptyList<String>(), r.fake.violations)
        }
    }

    /**
     * Without Stop, in all eight variants (how the link drops, which gate, a sled screen or
     * not): try 1 at 2 000, try 2 4 s after try 1's slow failure, Bluetooth on during the wait
     * for try 3 dials at once, and the display is still held when the device dimmed.
     */
    @Test fun withoutStopTheDropScheduleSurvivesASlowFailure() = runTest {
        for (drop in Drop.values()) for (gate in Gate.values()) for (sledScreen in listOf(false, true)) {
            val label = "drop=$drop gate=$gate sledScreen=$sledScreen"
            val r = Rig(this)
            val d = connectSweepAndDrop(r, drop, gate, sledScreen)
            val before = r.reader.dials.size

            at(d + TRY1_FAILS + 4_000)
            assertEquals("$label: try 1, then try 2 4 s after try 1 failed", listOf(2_000L, TRY1_FAILS + 4_000L), r.dialsAfter(before, d))

            at(d + DIMMED)
            assertTrue("$label: the display is held when the device dimmed", r.displayHeld())

            at(d + BT_ON)
            r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
            assertEquals(
                "$label: Bluetooth on during the wait dials at once",
                listOf(2_000L, TRY1_FAILS + 4_000L, BT_ON),
                r.dialsAfter(before, d),
            )
            assertTrue(label, r.controller.reconnecting.value)
            assertEquals("$label: no two reader calls at once", emptyList<String>(), r.fake.violations)
            r.controller.stopReconnecting(); settle()
        }
    }
}
