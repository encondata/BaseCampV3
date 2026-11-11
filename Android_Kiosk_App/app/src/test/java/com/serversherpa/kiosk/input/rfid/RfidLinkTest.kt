package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledNudge
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledWords
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The controller's link management (spec, Controller › Link management;
 * rulings 32 and 42): one gate around every connect and disconnect, the
 * `enabled` edge, the saved sled's address, the region reconnect and the
 * connect wait. Spec tests 10, 11 (first half), 14 (first half), 15 (first
 * half) and 16. Every rig runs in `backgroundScope` on virtual time, so the
 * controller's own clock is the test scheduler's.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidLinkTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    /** Moves virtual time to [ms] (absolute) and runs what is due then. */
    private fun TestScope.at(ms: Long) { advanceTimeBy(ms - currentTime); settle() }

    private class Rig(
        t: TestScope,
        initial: RfidSettings = DEFAULT_RFID_SETTINGS.copy(enabled = true),
        val fake: FakeRfidReader = FakeRfidReader(),
        reader: RfidReader = fake,
    ) {
        val settings = MutableStateFlow(initial)
        val controller = RfidController(reader, settings, t.backgroundScope) { t.testScheduler.currentTime }
    }

    private fun retryableFailure(reason: String = SledWords.couldNotReach("Fake RFD40")): Result<Unit> =
        Result.failure(SledConnectException(RfidConnection.Failed(reason, retryable = true)))

    /** Spec test 14, first half (T10): connectNow, disconnectNow and the two
     *  lifecycle calls from several coroutines on a real thread pool never put
     *  two link calls on the reader at once, and whichever call was issued last
     *  decides where the link ends up. */
    @Test fun connectAndDisconnectNeverOverlap() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val reader = FakeRfidReader()
            val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
            val controller = RfidController(reader, settings, scope)
            runBlocking {
                controller.start()
                delay(50)
                val rounds = 60
                listOf(
                    launch(Dispatchers.Default) { repeat(rounds) { controller.connectNow(); yield() } },
                    launch(Dispatchers.Default) { repeat(rounds) { controller.disconnectNow(); yield() } },
                    launch(Dispatchers.Default) { repeat(rounds) { controller.connectForLifecycle { true }; delay(1) } },
                    launch(Dispatchers.Default) { repeat(rounds) { controller.disconnectForLifecycle(); delay(1) } },
                ).joinAll()

                controller.connectForLifecycle { true }
                controller.disconnectNow()
                assertEquals(
                    "a disconnect issued after everything else ends disconnected",
                    RfidConnection.Disconnected,
                    reader.connection.value,
                )
                controller.connectNow()
                assertTrue(
                    "a connect issued after everything else ends connected",
                    reader.connection.value is RfidConnection.Connected,
                )
                controller.disconnectForLifecycle()
                withTimeout(5_000) {
                    while (reader.connection.value != RfidConnection.Disconnected) delay(10)
                }
                // Nothing still queued may undo the last call.
                delay(100)
                assertEquals(RfidConnection.Disconnected, reader.connection.value)
            }
            assertEquals("no two link calls were ever in flight at once", emptyList<String>(), reader.violations)
        } finally {
            scope.cancel()
        }
    }

    /** A connect that finds the link already up (`Connected`, or `NeedsRegion`)
     *  succeeds without dialing: no new generation, no reconnect. */
    @Test fun aConnectThatFindsTheReaderUpReturnsWithoutDialing() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        assertTrue(r.controller.connectNow().isSuccess)
        assertEquals(1, r.fake.connectCalls)

        assertTrue(r.controller.connectNow().isSuccess)
        r.controller.connectForLifecycle { true }; settle()
        assertEquals("Connected: neither connect dials", 1, r.fake.connectCalls)
        assertEquals(1, r.fake.generation)

        val n = Rig(this)
        n.fake.needsRegion = true
        n.controller.start(); settle()
        n.controller.connectNow()
        assertEquals(RfidConnection.NeedsRegion("Fake RFD40"), n.fake.connection.value)
        n.controller.connectForLifecycle { true }; settle()
        assertEquals("NeedsRegion: the lifecycle connect does not dial", 1, n.fake.connectCalls)
    }

    /** Spec test 11, first half: the request comes from `settings.first()`, not
     *  from the collector's copy, so a connect issued before the collector's
     *  first value still carries the saved sled and trigger layout. */
    @Test fun theConnectRequestComesFromTheSavedSettingsEvenBeforeTheFirstValue() = runTest {
        val saved = DEFAULT_RFID_SETTINGS.copy(
            enabled = true,
            readerAddress = "AA:BB:CC:DD:EE:FF",
            triggerLayout = SledTriggerLayout.SPLIT,
        )
        val r = Rig(this, saved)
        // start() has not run, so the settings collector has seen nothing yet.
        r.controller.connectNow()
        assertEquals(SledConnectRequest("AA:BB:CC:DD:EE:FF", SledTriggerLayout.SPLIT), r.fake.lastRequest)

        val l = Rig(this, saved)
        l.controller.connectForLifecycle { true }
        l.controller.start(); settle()
        assertEquals(SledConnectRequest("AA:BB:CC:DD:EE:FF", SledTriggerLayout.SPLIT), l.fake.lastRequest)
    }

    /** Ruling 32: `enabled` gates the automatic connects only. The lifecycle
     *  connect, the retries after a drop and a nudge run the stored gate;
     *  Connect does not. */
    @Test fun enabledGatesAutomaticConnectsOnly() = runTest {
        val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = false))
        r.controller.start(); settle()
        r.controller.connectForLifecycle { r.settings.value.enabled }; settle()
        assertEquals("the lifecycle connect runs the gate", 0, r.fake.connectCalls)

        assertTrue(r.controller.connectNow().isSuccess)
        assertEquals("Connect does not read enabled", 1, r.fake.connectCalls)

        r.fake.dropLink("The sled disconnected."); settle()
        at(300_000)
        assertEquals("a retry runs the gate", 1, r.fake.connectCalls)
        assertFalse(r.controller.reconnecting.value)

        r.controller.nudge(SledNudge.BLUETOOTH_ON); settle()
        assertEquals("a nudge runs the gate", 1, r.fake.connectCalls)
    }

    /** Spec test 15, first half. The settings flow re-emits on every DataStore
     *  write, so equal values arrive often: only a change of `enabled` between
     *  two collected values counts, and the first collected value is not one.
     *  The false-to-true edge dials through the stored gate. */
    @Test fun theEnableEdgeConnectsOnceAndDisconnectsOnce() = runTest {
        val reader = FakeRfidReader()
        val settings = MutableSharedFlow<RfidSettings>(replay = 1)
        val controller = RfidController(reader, settings, backgroundScope) { currentTime }
        var gateOpen = false
        controller.start(); settle()
        controller.connectForLifecycle { gateOpen }; settle()
        assertEquals("the stored gate is closed: nothing dials", 0, reader.connectCalls)
        gateOpen = true

        val on = DEFAULT_RFID_SETTINGS.copy(enabled = true)
        val off = on.copy(enabled = false)
        settings.emit(on); settle()
        assertEquals("the first value is not a change", 0, reader.connectCalls)
        assertEquals(0, reader.disconnectCalls)
        repeat(3) { settings.emit(on); settle() }
        assertEquals(0, reader.connectCalls)

        settings.emit(off); settle()
        assertEquals("true to false disconnects once", 1, reader.disconnectCalls)
        repeat(3) { settings.emit(off); settle() }
        assertEquals(1, reader.disconnectCalls)

        settings.emit(on); settle()
        assertEquals("false to true dials once", 1, reader.connectCalls)
        assertTrue(reader.connection.value is RfidConnection.Connected)
        repeat(3) { settings.emit(on); settle() }
        assertEquals(1, reader.connectCalls)
        assertEquals(1, reader.disconnectCalls)

        gateOpen = false
        settings.emit(off); settle()
        settings.emit(on); settle()
        assertEquals("the edge goes through the stored gate", 1, reader.connectCalls)
        assertEquals(2, reader.disconnectCalls)
    }

    /** Review Focus 3: the switch goes off while a connect is still in flight.
     *  The attempt finishes, the switch's disconnect runs after it, and the app
     *  ends `Disconnected` with nothing retrying and no failure sentence, whether
     *  the attempt failed (on a sled screen, where a retryable failure would
     *  otherwise start the schedule) or came up. */
    @Test fun switchingOffDuringAConnectEndsDisconnectedWithNoRetry() = runTest {
        for (outcome in listOf(retryableFailure(), Result.success(Unit))) {
            val r = Rig(this)
            r.fake.connectResult = outcome
            r.controller.start(); r.controller.setSledScreenOpen(true); settle()
            val hold = CompletableDeferred<Unit>()
            r.fake.holdNext = hold
            backgroundScope.launch { r.controller.connectNow() }; settle()
            assertEquals(RfidConnection.Connecting, r.fake.connection.value)

            r.settings.value = r.settings.value.copy(enabled = false); settle()
            assertEquals("the attempt is not cut short", 0, r.fake.disconnectCalls)
            hold.complete(Unit); settle()

            assertEquals(RfidConnection.Disconnected, r.fake.connection.value)
            assertFalse(r.controller.reconnecting.value)
            assertNull(r.controller.connectionError.value)
            val t0 = currentTime
            at(t0 + 300_000)
            assertEquals("nothing retried", 1, r.fake.connectCalls)
            assertEquals(1, r.fake.disconnectCalls)
            assertEquals(RfidConnection.Disconnected, r.fake.connection.value)
            assertEquals(emptyList<String>(), r.fake.violations)
        }
    }

    /** Spec test 16, first half: choosing another sled while connected to one,
     *  or while a connect is running, disconnects and connects to the new one. */
    @Test fun aReaderAddressChangeToAnotherSledReconnects() = runTest {
        val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, readerAddress = "AA:BB:CC:DD:EE:01"))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals("AA:BB:CC:DD:EE:01", r.fake.info.value?.address)

        r.settings.value = r.settings.value.copy(readerAddress = "AA:BB:CC:DD:EE:02"); settle()
        assertEquals(1, r.fake.disconnectCalls)
        assertEquals(2, r.fake.connectCalls)
        assertEquals("AA:BB:CC:DD:EE:02", r.fake.lastRequest?.address)
        assertTrue(r.fake.connection.value is RfidConnection.Connected)

        // While a connect is running: once it has finished, the same.
        r.controller.disconnectNow()
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        backgroundScope.launch { r.controller.connectNow() }; settle()
        assertEquals(RfidConnection.Connecting, r.fake.connection.value)
        r.settings.value = r.settings.value.copy(readerAddress = "AA:BB:CC:DD:EE:03"); settle()
        assertEquals("nothing cuts the running attempt short", 3, r.fake.connectCalls)
        hold.complete(Unit); settle()
        assertEquals(3, r.fake.disconnectCalls)
        assertEquals(4, r.fake.connectCalls)
        assertEquals("AA:BB:CC:DD:EE:03", r.fake.info.value?.address)
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Spec test 16, second half: saving the connected sled's own address (the
     *  automatic save after the pre-check picked it, or the same address in
     *  other letter case) reconnects nothing. */
    @Test fun aReaderAddressChangeToTheConnectedSledsOwnAddressDoesNothing() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        r.fake.setInfo(r.fake.info.value!!.copy(address = "00:11:22:33:44:55"))

        r.settings.value = r.settings.value.copy(readerAddress = "00:11:22:33:44:55"); settle()
        r.settings.value = r.settings.value.copy(readerAddress = "00:11:22:33:44:55".lowercase()); settle()

        assertEquals(0, r.fake.disconnectCalls)
        assertEquals(1, r.fake.connectCalls)
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
    }

    /** Records the order of the region write and the link calls around it. */
    private class OrderRecordingReader(private val inner: FakeRfidReader) : RfidReader by inner {
        val order = CopyOnWriteArrayList<String>()

        override suspend fun connect(request: SledConnectRequest): Result<Unit> {
            order += "connect"
            return inner.connect(request)
        }

        override suspend fun disconnect() {
            order += "disconnect"
            inner.disconnect()
        }

        override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> =
            inner.setRegion(code, hopping).also { order += "setRegion returned" }
    }

    /**
     * Spec test 10, first half: a region set on a sled in `NeedsRegion` is
     * followed by one disconnect and one connect, in that order, after the
     * region write returned, and `setRegion` returns once that connect has
     * finished. The reconnect's own calls need `applyGate`, so a `setRegion`
     * that still held it would never return and this test would hang.
     */
    @Test fun setRegionInNeedsRegionDisconnectsThenConnectsAfterApplyGateIsFree() = runTest {
        val fake = FakeRfidReader()
        fake.needsRegion = true
        val recorder = OrderRecordingReader(fake)
        val r = Rig(this, fake = fake, reader = recorder)
        r.controller.start(); settle()
        r.controller.connectNow()
        assertEquals(RfidConnection.NeedsRegion("Fake RFD40"), fake.connection.value)

        recorder.order.clear()
        fake.needsRegion = false
        assertTrue(r.controller.setRegion("ETSI", hopping = null).isSuccess)
        assertEquals(listOf("setRegion returned", "disconnect", "connect"), recorder.order)
        assertTrue("setRegion returns once the connect has finished", fake.connection.value is RfidConnection.Connected)

        recorder.order.clear()
        assertTrue(r.controller.setRegion("USA", hopping = null).isSuccess)
        assertEquals("a region set while Connected reconnects nothing", listOf("setRegion returned"), recorder.order)
        assertEquals(emptyList<String>(), fake.violations)
    }

    /** Spec test 10, second half. */
    @Test fun connectNowInNeedsRegionDoesNotDial() = runTest {
        val r = Rig(this)
        r.fake.needsRegion = true
        r.controller.start(); settle()
        r.controller.connectNow()
        assertEquals(1, r.fake.connectCalls)

        assertTrue(r.controller.connectNow().isSuccess)
        assertEquals(1, r.fake.connectCalls)
        assertEquals(RfidConnection.NeedsRegion("Fake RFD40"), r.fake.connection.value)
    }

    /**
     * After 30 s the caller is answered and `connectionError` says the sled
     * couldn't be reached, but the gate stays held until the reader's own call
     * returns: a disconnect issued meanwhile waits for it, so the two never
     * overlap on the reader.
     */
    @Test fun aConnectTimeoutSaysCouldNotReachAndHoldsTheGateUntilTheAttemptReturns() = runTest {
        val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, readerAddress = "AA:BB:CC:DD:EE:FF"))
        r.fake.paired = listOf(SledCandidate("RFD40 21234", "AA:BB:CC:DD:EE:FF"))
        r.controller.start(); settle()
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        var result: Result<Unit>? = null
        backgroundScope.launch { result = r.controller.connectNow() }; settle()

        at(RfidController.CONNECT_WAIT_MS - 1)
        assertNull(result)
        assertNull(r.controller.connectionError.value)

        at(RfidController.CONNECT_WAIT_MS)
        assertTrue("the caller is answered at the timeout", result?.isFailure == true)
        assertEquals(SledWords.couldNotReach("RFD40 21234"), r.controller.connectionError.value)

        backgroundScope.launch { r.controller.disconnectNow() }; settle()
        assertEquals("the disconnect waits for the slow connect", 0, r.fake.disconnectCalls)
        assertEquals(RfidConnection.Connecting, r.fake.connection.value)

        hold.complete(Unit); settle()
        assertEquals(1, r.fake.disconnectCalls)
        assertEquals(RfidConnection.Disconnected, r.fake.connection.value)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** A batch-mode recovery inside the attempt stretches the wait to 60 s. */
    @Test fun theConnectWaitStretchesTo60sWhenABatchRecoveryRuns() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        backgroundScope.launch { r.controller.connectNow() }; settle()

        at(10_000)
        r.fake.setBatchRecovery(true); settle()
        at(20_000)
        r.fake.setBatchRecovery(false); settle()

        at(RfidController.CONNECT_WAIT_MS)
        assertNull("a recovery ran: 30 s is not the limit", r.controller.connectionError.value)
        at(RfidController.CONNECT_WAIT_BATCH_MS - 1)
        assertNull(r.controller.connectionError.value)
        at(RfidController.CONNECT_WAIT_BATCH_MS)
        assertEquals(SledWords.couldNotReach(null), r.controller.connectionError.value)

        hold.complete(Unit); settle()
    }

    /** Leaving the RFID tab cancels the coroutine that tapped Connect; the
     *  attempt runs on the controller's scope and finishes anyway. */
    @Test fun cancelingTheCallerDoesNotCancelTheAttempt() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        val caller = backgroundScope.launch { r.controller.connectNow() }; settle()
        assertEquals(RfidConnection.Connecting, r.fake.connection.value)

        caller.cancel(); settle()
        hold.complete(Unit); settle()

        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        assertEquals(1, r.fake.connectCalls)
    }
}
