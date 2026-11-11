package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledKey
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledTriggerReadback
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.interimKeys
import com.serversherpa.kiosk.core.rfid.keys
import com.serversherpa.kiosk.core.rfid.readbackOf
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The controller's one job queue (spec, Controller › Job queue, Battery, Soft
 * scan, Activity; Review Focus 2): settings pushes, layout writes, battery
 * requests and region loads run one at a time, never while a sweep is open,
 * and coalesce the way the spec says. Spec tests 1, 2, 3, 6 and 17; row 19.
 * Every rig but the stress test runs in `backgroundScope` on virtual time.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidJobQueueTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    /** Moves virtual time to [ms] (absolute) and runs what is due then. */
    private fun TestScope.at(ms: Long) { advanceTimeBy(ms - currentTime); settle() }

    private val usa = RfidRegion("USA", "United States", hoppingConfigurable = false, channels = emptyList())
    private val eu = RfidRegion("ETSI", "Europe", hoppingConfigurable = true, channels = emptyList())

    /** Records every queued call and every start and stop, in order. While
     *  [holdApply] is set, `apply()` waits on it. While [holdConnectReturn]
     *  is set, `connect()` waits on it after the fake's own connect is done,
     *  so the link is up while the controller's connect call is still out. */
    private class Recorder(private val inner: FakeRfidReader) : RfidReader by inner {
        val calls = CopyOnWriteArrayList<String>()
        @Volatile var holdApply: CompletableDeferred<Unit>? = null
        @Volatile var holdConnectReturn: CompletableDeferred<Unit>? = null

        override suspend fun connect(request: SledConnectRequest): Result<Unit> {
            val result = inner.connect(request)
            holdConnectReturn?.await()
            return result
        }

        override suspend fun apply(settings: RfidSettings): Result<Unit> {
            calls += "apply:${settings.powerDbm}"
            holdApply?.await()
            return inner.apply(settings)
        }

        override suspend fun startInventory(): Result<Unit> {
            calls += "start"
            return inner.startInventory()
        }

        override suspend fun stopInventory(): Result<Unit> {
            calls += "stop"
            return inner.stopInventory()
        }

        override suspend fun setTriggerLayout(layout: SledTriggerLayout): Result<SledTriggerReadback> {
            calls += "layout:${layout.wire}"
            return inner.setTriggerLayout(layout)
        }

        override suspend fun requestBattery() {
            calls += "battery"
            inner.requestBattery()
        }

        override suspend fun regions(): Result<RfidRegions> {
            calls += "regions"
            return inner.regions()
        }
    }

    private class Rig(
        t: TestScope,
        initial: RfidSettings = DEFAULT_RFID_SETTINGS.copy(enabled = true),
        settingsFlow: Flow<RfidSettings>? = null,
        zebraHost: Boolean = false,
    ) {
        val fake = FakeRfidReader()
        val reader = Recorder(fake)
        val settings = MutableStateFlow(initial)
        val controller = RfidController(reader, settingsFlow ?: settings, t.backgroundScope, zebraHost = zebraHost) {
            t.testScheduler.currentTime
        }
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

    private fun Rig.applies(): Int = reader.calls.count { it.startsWith("apply") }

    /**
     * Spec test 1 (T15): connect, disconnect, settings pushes, layout changes,
     * trigger starts and stops, region loads and region writes from several
     * coroutines on a real thread pool. The fake records any two calls in
     * flight at once and any call during a running inventory; the test ending
     * at all proves nothing deadlocked, and the counted starts and bursts
     * prove sweeps really ran.
     */
    @Test fun connectDisconnectPushLayoutStartStopAndRegionLoadNeverDeadlockOrOverlap() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val reader = FakeRfidReader()
            reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
            val started = AtomicInteger(0)
            val counting = object : RfidReader by reader {
                override suspend fun startInventory(): Result<Unit> =
                    reader.startInventory().onSuccess { started.incrementAndGet() }
            }
            val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
            val controller = RfidController(counting, settings, scope)
            val ended = AtomicInteger(0)
            scope.launch { controller.bursts.collect { ended.incrementAndGet() } }
            val dropped = AtomicInteger(0)
            fun emit(flow: Flow<*>, block: () -> Unit) {
                // The fake's pull buffer holds 16; a stalled collector here is
                // buffer pressure, not what this test is about. A collector that
                // died (nothing subscribed any more) fails the test.
                try {
                    block()
                } catch (e: IllegalStateException) {
                    if ((flow as MutableSharedFlow<*>).subscriptionCount.value == 0) throw e
                    dropped.incrementAndGet()
                }
            }
            runBlocking {
                withTimeout(60_000) {
                    controller.start(); controller.arm()
                    controller.connectNow()
                    delay(50)
                    val rounds = 40
                    listOf(
                        launch(Dispatchers.Default) {
                            repeat(rounds) { controller.disconnectNow(); delay(2); controller.connectNow(); delay(5) }
                        },
                        launch(Dispatchers.Default) {
                            repeat(rounds * 2) { i ->
                                settings.update {
                                    it.copy(powerDbm = 10 + i % 20, triggerLayout = SledTriggerLayout.entries[i % 3])
                                }
                                delay(3)
                            }
                        },
                        launch(Dispatchers.Default) {
                            repeat(rounds * 3) { i ->
                                emit(reader.pulls) { reader.emitTrigger(TriggerEvent.PRESSED) }
                                emit(reader.tags) { reader.emitTag("T15-$i") }
                                emit(reader.pulls) { reader.emitTrigger(TriggerEvent.RELEASED) }
                                delay(3)
                            }
                        },
                        launch(Dispatchers.Default) { repeat(rounds) { controller.loadRegions(); delay(4) } },
                        launch(Dispatchers.Default) { repeat(rounds / 2) { controller.setRegion("ETSI", hopping = true); delay(9) } },
                        launch(Dispatchers.Default) { repeat(rounds) { controller.stopBurst(); delay(6) } },
                    ).joinAll()
                    controller.stopBurst()
                    controller.connectNow()
                    controller.loadRegions()
                    delay(200)
                    controller.disarm()
                    delay(100)
                }
            }
            assertEquals("no call overlapped another or a running inventory", emptyList<String>(), reader.violations)
            assertTrue("the link went up and down", reader.connectCalls > 1 && reader.disconnectCalls > 0)
            assertTrue("layouts were written", reader.layoutCalls.isNotEmpty())
            assertTrue("regions were read (emissions dropped for buffer pressure: $dropped)", reader.regionsCalls > 0)
            assertTrue("sweeps ran: $started reads started, $ended bursts ended", started.get() > 0 && ended.get() > 0)
        } finally {
            scope.cancel()
        }
    }

    /** Spec test 2: a push waits for an open sweep; when the link drops the
     *  sweep ends with its tags queued, and the push never reaches a sled
     *  that is gone. */
    @Test fun aPushPendingWithASweepOpenAndTheLinkDropsQueuesTheTags() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.emitTrigger(TriggerEvent.PRESSED); r.fake.emitTag("100348"); settle()
        r.settings.value = r.settings.value.copy(powerDbm = 12); settle()
        assertEquals("the push waits for the sweep", listOf("start"), r.reader.calls)

        r.fake.dropLink("The sled disconnected."); settle()
        assertNull(r.controller.session.value)
        assertEquals(listOf(listOf("100348")), r.bursts)
        assertEquals("nothing reaches a sled that is gone", listOf("start"), r.reader.calls)
        assertNull(r.controller.applyError.value)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Spec test 3 (T3): a battery poll coming due, a settings change, a
     *  region load and a layout change, each during an open sweep, make no
     *  call until it ends; then each runs, in the order queued. */
    @Test fun noVendorCallDuringAnOpenSweep() = runTest {
        val r = Rig(this)
        r.fake.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        connectedAndArmed(r)
        val t0 = currentTime
        r.fake.emitTrigger(TriggerEvent.PRESSED); r.fake.emitTag("100348"); settle()

        at(t0 + RfidController.BATTERY_IDLE_MS + 1)
        r.settings.value = r.settings.value.copy(powerDbm = 12); settle()
        var regions: Result<RfidRegions>? = null
        backgroundScope.launch { regions = r.controller.loadRegions() }; settle()
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        assertEquals("nothing but the start while the sweep is open", listOf("start"), r.reader.calls)
        assertNull(regions)
        assertNotNull(r.controller.session.value)

        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(
            listOf("start", "stop", "apply:12", "regions", "layout:split", "battery"),
            r.reader.calls,
        )
        assertEquals(RfidRegions(listOf(usa, eu), "USA"), regions?.getOrNull())
        assertEquals(listOf(listOf("100348")), r.bursts)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Spec test 6: the sled came back as a new generation with no gap the
     *  controller saw: both generations get a push. */
    @Test fun twoConnectionsWithNoObservedGapBothGetAPush() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals(1, r.applies())
        val first = r.fake.generation

        // The fake reconnects in one step, so the controller only ever sees
        // Connected: the generation is what tells it the link is a new one.
        r.fake.connect(SledConnectRequest(null, SledTriggerLayout.RFID)); settle()
        assertEquals(first + 1, r.fake.info.value?.generation)
        assertEquals(2, r.applies())
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Pushes waiting for a sweep coalesce: one push, of the latest settings. */
    @Test fun pushesCoalesceToTheLatestSettings() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        for (power in listOf(10, 11, 12)) {
            r.settings.value = r.settings.value.copy(powerDbm = power); settle()
        }
        assertEquals(listOf("start"), r.reader.calls)

        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(listOf("start", "stop", "apply:12", "battery"), r.reader.calls)
        assertEquals(12, r.fake.applied?.powerDbm)
    }

    /** A layout change ends the open sweep (its tags queued) before it writes. */
    @Test fun aLayoutChangeEndsTheSweepThenWritesTheLayout() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.emitTrigger(TriggerEvent.PRESSED); r.fake.emitTag("100348"); r.fake.emitTag("100349"); settle()

        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        assertEquals(listOf("start", "stop", "layout:split", "battery"), r.reader.calls)
        assertNull(r.controller.session.value)
        assertEquals(listOf(listOf("100348", "100349")), r.bursts)
        assertEquals(SledTriggerLayout.SPLIT, r.fake.info.value?.trigger?.layout)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /**
     * Review Focus 2: three taps on Sled triggers land together while a sweep
     * is open. Only the latest layout is written, once, after the sweep the
     * layout job ended (its tags queued), and never during it. Run twice: on
     * the rig's `MutableStateFlow` (the collector sees the last write), and on
     * a buffered flow, where the collector sees every write and the queue
     * itself has to coalesce them.
     */
    @Test fun rapidLayoutChangesWriteTheLatestOnceAndNeverDuringASweep() = runTest {
        for (buffered in listOf(false, true)) {
            val stream = MutableSharedFlow<RfidSettings>(replay = 1, extraBufferCapacity = 8)
            stream.tryEmit(DEFAULT_RFID_SETTINGS.copy(enabled = true))
            val r = Rig(this, settingsFlow = if (buffered) stream else null)
            connectedAndArmed(r)
            r.fake.emitTrigger(TriggerEvent.PRESSED); r.fake.emitTag("100348"); settle()
            val before = r.fake.layoutCalls.size

            for (layout in listOf(SledTriggerLayout.RFID, SledTriggerLayout.BARCODE, SledTriggerLayout.SPLIT)) {
                if (buffered) {
                    assertTrue(stream.tryEmit(DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = layout)))
                } else {
                    r.settings.update { it.copy(triggerLayout = layout) }
                }
            }
            settle()

            assertEquals("buffered=$buffered", listOf(SledTriggerLayout.SPLIT), r.fake.layoutCalls.drop(before))
            assertEquals("buffered=$buffered", listOf("start", "stop", "layout:split", "battery"), r.reader.calls)
            assertEquals("buffered=$buffered", listOf(listOf("100348")), r.bursts)
            assertNull(r.controller.session.value)
            assertEquals(emptyList<String>(), r.fake.violations)
        }
    }

    /** A change arriving while a layout write is in flight is written once
     *  more, after it: the latest is always last. */
    @Test fun aLayoutChangeArrivingWhileAWriteIsInFlightWritesOnceMore() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        val before = r.fake.layoutCalls.size
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold

        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.BARCODE); settle()
        assertEquals(listOf(SledTriggerLayout.BARCODE), r.fake.layoutCalls.drop(before))
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        assertEquals("one write at a time", listOf(SledTriggerLayout.BARCODE), r.fake.layoutCalls.drop(before))

        hold.complete(Unit); settle()
        assertEquals(listOf(SledTriggerLayout.BARCODE, SledTriggerLayout.SPLIT), r.fake.layoutCalls.drop(before))
        assertEquals(SledTriggerLayout.SPLIT, r.fake.info.value?.trigger?.layout)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** The layout in force: the accepted read-back when there is one, else
     *  the effective layout of the last request in this generation. */
    @Test fun theLayoutInForceFollowsTheReadbackElseTheLastRequest() = runTest {
        val r = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = SledTriggerLayout.BARCODE))
        r.fake.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        r.controller.start(); settle()
        assertNull("no sled: no request", r.controller.requestedLayout.value)
        assertFalse(r.controller.layoutInForceUsesScanner.value)

        r.controller.connectNow(); settle()
        assertNull("the write failed: no read-back", r.fake.info.value?.trigger)
        assertEquals(SledTriggerLayout.BARCODE, r.controller.requestedLayout.value)
        assertTrue("from the request", r.controller.layoutInForceUsesScanner.value)

        r.fake.setInfo(r.fake.info.value!!.copy(trigger = readbackOf(SledKey.RFID, SledKey.RFID, 4))); settle()
        assertFalse("from the read-back", r.controller.layoutInForceUsesScanner.value)

        r.fake.layoutResult = null
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        assertEquals(SledTriggerLayout.SPLIT, r.controller.requestedLayout.value)
        assertTrue(r.controller.layoutInForceUsesScanner.value)

        r.controller.disconnectNow(); settle()
        assertNull("null while info is null", r.controller.requestedLayout.value)
        assertFalse(r.controller.layoutInForceUsesScanner.value)

        // On a Zebra host the sled's triggers always read tags.
        val z = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = SledTriggerLayout.BARCODE), zebraHost = true)
        z.fake.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        z.controller.start(); settle()
        z.controller.connectNow(); settle()
        assertEquals(SledTriggerLayout.BARCODE, z.controller.requestedLayout.value)
        assertFalse(z.controller.layoutInForceUsesScanner.value)
    }

    /**
     * Ruling 27, with the connect and a layout write racing: the generation's
     * layout write waits on the `applyGate` the connect holds, and when the
     * connect's call returns both resume at once. Here the write runs first
     * (a setting changed during the connect, and the sled left no read-back);
     * the connect's own request must not replace it afterward.
     */
    @Test fun aLayoutWriteThatRunsBeforeTheConnectReturnsStaysTheRequestedLayout() = runTest {
        val r = Rig(this)
        r.fake.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        r.controller.start(); settle()
        val release = CompletableDeferred<Unit>()
        r.reader.holdConnectReturn = release
        backgroundScope.launch { r.controller.connectNow() }; settle()
        assertTrue("the link is up", r.fake.connection.value is RfidConnection.Connected)
        assertEquals("the connect request's, for now", SledTriggerLayout.RFID, r.controller.requestedLayout.value)
        assertEquals("nothing is written while the connect holds the radio", emptyList<SledTriggerLayout>(), r.fake.layoutCalls)

        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.BARCODE); settle()
        release.complete(Unit); settle()

        assertEquals(listOf(SledTriggerLayout.BARCODE), r.fake.layoutCalls)
        assertNull("the write left no read-back", r.fake.info.value?.trigger)
        assertEquals("the last write is what this sled was asked", SledTriggerLayout.BARCODE, r.controller.requestedLayout.value)
        assertTrue(r.controller.layoutInForceUsesScanner.value)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** A sled that will not take the layout is asked once per generation, not
     *  in a loop. */
    @Test fun aSledThatRefusesTheLayoutIsWrittenOnlyOncePerGeneration() = runTest {
        val r = Rig(this)
        r.fake.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals(1, r.fake.layoutCalls.size)

        at(currentTime + 5 * RfidController.BATTERY_IDLE_MS)
        assertTrue("battery polls ran meanwhile", r.fake.batteryRequests > 0)
        assertEquals("nothing wrote the layout again", 1, r.fake.layoutCalls.size)

        r.controller.disconnectNow(); settle()
        r.controller.connectNow(); settle()
        assertEquals("a new generation is checked once", 2, r.fake.layoutCalls.size)
    }

    /** A connect whose step 10 left the no-beam keys for the layout asked (the
     *  sled's scanner was not ready yet; the reader writes the real keys once it
     *  is) queues no layout job: that read-back stands in for the layout. */
    @Test fun aConnectThatLeftTheNoBeamKeysQueuesNoLayoutJob() = runTest {
        val fake = FakeRfidReader()
        val reader = StepTenReader(fake, backgroundScope) { it.interimKeys() }
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = SledTriggerLayout.BARCODE))
        val controller = RfidController(reader, settings, backgroundScope) { testScheduler.currentTime }
        controller.start(); settle()
        controller.connectNow(); settle()
        assertTrue(reader.connection.value is RfidConnection.Connected)
        assertEquals(readbackOf(SledKey.NO_ACTION, SledKey.NO_ACTION, null), reader.info.value?.trigger)
        assertEquals("no layout job", emptyList<SledTriggerLayout>(), fake.layoutCalls)
        assertTrue(controller.layoutInForceUsesScanner.value)
        assertNull(controller.layoutError.value)
        assertEquals(emptyList<String>(), fake.violations)
    }

    @Test fun aLayoutFailureSetsLayoutError() = runTest {
        val r = Rig(this)
        r.fake.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals(SledWords.TRIGGER_CHECK_FAILED, r.controller.layoutError.value)

        r.fake.layoutResult = null
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        assertNull("a write that took clears it", r.controller.layoutError.value)

        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        val t0 = currentTime
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.BARCODE); settle()
        at(t0 + RfidController.CALL_WAIT_MS - 1)
        assertNull(r.controller.layoutError.value)
        at(t0 + RfidController.CALL_WAIT_MS)
        assertEquals("a write that never answers", SledWords.TRIGGER_CHECK_FAILED, r.controller.layoutError.value)
        hold.complete(Unit); settle()

        r.fake.layoutResult = null
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.RFID); settle()
        assertNull(r.controller.layoutError.value)
        r.fake.layoutResult = Result.failure(IllegalStateException())
        r.settings.value = r.settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        assertEquals("a failure with no sentence", SledWords.TRIGGER_CHECK_FAILED, r.controller.layoutError.value)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Spec test 17: a battery job that comes up while a sweep is open is
     *  dropped, not run when the sweep ends; and no idle poll runs during one. */
    @Test fun aBatteryJobIsDroppedWhileASweepIsOpen() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        // A sweep ends and the next one opens before the queue gets to the
        // battery job the first one queued.
        r.fake.emitTrigger(TriggerEvent.RELEASED); r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNotNull(r.controller.session.value)
        assertEquals(0, r.fake.batteryRequests)

        at(currentTime + 2 * RfidController.BATTERY_IDLE_MS)
        assertEquals("no idle poll while a sweep is open", 0, r.fake.batteryRequests)

        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals("the sweep that ended asks once", 1, r.fake.batteryRequests)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Spec test 17: the controller asks after each sweep and after 60 s with
     *  no sweep and no other job while connected; never while disconnected. */
    @Test fun theControllerAsksForBatteryAfterEachSweepAndAfter60sIdle() = runTest {
        val r = Rig(this)
        connectedAndArmed(r)
        assertEquals("the adapter asks at connect, the controller does not", 0, r.fake.batteryRequests)

        r.fake.emitTrigger(TriggerEvent.PRESSED); r.fake.emitTag("100348"); settle()
        r.fake.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals("after the sweep", 1, r.fake.batteryRequests)

        val t1 = currentTime
        at(t1 + RfidController.BATTERY_IDLE_MS - 1)
        assertEquals(1, r.fake.batteryRequests)
        at(t1 + RfidController.BATTERY_IDLE_MS)
        assertEquals("after 60 s idle", 2, r.fake.batteryRequests)
        at(t1 + 2 * RfidController.BATTERY_IDLE_MS)
        assertEquals(3, r.fake.batteryRequests)

        r.controller.disconnectNow(); settle()
        at(currentTime + 5 * RfidController.BATTERY_IDLE_MS)
        assertEquals("never while disconnected", 3, r.fake.batteryRequests)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** A region load returns its result to its caller; the controller never
     *  reads regions at connect, in `Connected` or `NeedsRegion`; a load that
     *  never answers fails with the Retry sentence. */
    @Test fun loadRegionsReturnsItsResultAndIsNeverCalledAtConnect() = runTest {
        val regions = RfidRegions(listOf(usa, eu), "USA")
        val r = Rig(this)
        r.fake.reportedRegions = regions
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals(0, r.fake.regionsCalls)
        assertEquals(regions, r.controller.loadRegions().getOrThrow())
        assertEquals(1, r.fake.regionsCalls)

        val n = Rig(this)
        n.fake.needsRegion = true
        n.fake.reportedRegions = regions
        n.controller.start(); settle()
        n.controller.connectNow(); settle()
        assertEquals(RfidConnection.NeedsRegion("Fake RFD40"), n.fake.connection.value)
        assertEquals(0, n.fake.regionsCalls)
        assertEquals(regions, n.controller.loadRegions().getOrThrow())

        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        var got: Result<RfidRegions>? = null
        val t0 = currentTime
        backgroundScope.launch { got = r.controller.loadRegions() }; settle()
        at(t0 + RfidController.CALL_WAIT_MS - 1)
        assertNull(got)
        at(t0 + RfidController.CALL_WAIT_MS)
        assertEquals(SledWords.REGIONS_FAILED, got?.exceptionOrNull()?.message)
        hold.complete(Unit); settle()

        r.controller.disconnectNow(); settle()
        assertTrue(r.controller.loadRegions().exceptionOrNull() is SledNotConnected)
    }

    /** A region load runs on the queue's one consumer, not in its caller:
     *  cancelling the caller (leaving the Admin tab) never cuts the read
     *  short, so nothing else reaches the radio until the sled answers. */
    @Test fun cancellingARegionLoadsCallerLeavesTheReadToFinish() = runTest {
        val r = Rig(this)
        r.fake.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        connectedAndArmed(r)
        val hold = CompletableDeferred<Unit>()
        r.fake.holdNext = hold
        val caller = backgroundScope.launch { r.controller.loadRegions() }; settle()
        assertEquals("the read is out", 1, r.fake.regionsCalls)

        caller.cancel(); settle()
        r.fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertNotNull(r.controller.session.value)
        assertFalse("the start waits for the region read", r.fake.inventoryRunning)

        hold.complete(Unit); settle()
        assertTrue("then the read starts", r.fake.inventoryRunning)
        assertEquals(listOf("regions", "start"), r.reader.calls)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Row 19: a settings push the sled never answers is reported after
     *  `CALL_WAIT_MS`. */
    @Test fun aStuckSettingsPushReportsATimeoutAfterCallWaitMsElapses() = runTest {
        val r = Rig(this)
        val hold = CompletableDeferred<Unit>()
        r.reader.holdApply = hold
        r.controller.start(); settle()
        val t0 = currentTime
        backgroundScope.launch { r.controller.connectNow() }; settle()
        assertEquals("the connect's push is in flight", listOf("apply:27"), r.reader.calls.filter { it.startsWith("apply") })

        at(t0 + RfidController.CALL_WAIT_MS - 1)
        assertNull("nothing has timed out yet", r.controller.applyError.value)
        at(t0 + RfidController.CALL_WAIT_MS)
        assertEquals(SledWords.PUSH_STOPPED, r.controller.applyError.value)

        hold.complete(Unit); settle()
    }

    /** Ruling 12: the Scan button pulls the sled's soft trigger, then lets go
     *  on the first barcode or after 3 s, whichever is first. */
    @Test fun softScanOnceReleasesOnTheFirstBarcodeOrAfter3s() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        r.fake.setScanner(SledScannerState.Ready)

        var done = false
        backgroundScope.launch { r.controller.softScanOnce(); done = true }; settle()
        assertEquals(listOf(true), r.fake.softScans)
        r.fake.emitBarcode(SledBarcode("A-100348", "Code 128")); settle()
        assertEquals(listOf(true, false), r.fake.softScans)
        assertTrue(done)

        done = false
        val t0 = currentTime
        backgroundScope.launch { r.controller.softScanOnce(); done = true }; settle()
        at(t0 + RfidController.SOFT_SCAN_HOLD_MS - 1)
        assertEquals(listOf(true, false, true), r.fake.softScans)
        assertFalse(done)
        at(t0 + RfidController.SOFT_SCAN_HOLD_MS)
        assertEquals(listOf(true, false, true, false), r.fake.softScans)
        assertTrue(done)

        r.fake.setScanner(SledScannerState.Off)
        r.controller.softScanOnce()
        assertEquals("a pull that failed is not released", listOf(true, false, true, false, true), r.fake.softScans)
    }

    /** Every pull, tag and note is activity, in steps of [RfidController.ACTIVITY_STEP_MS]:
     *  a sweep's hundreds of tags a second change it about once a second, so the display
     *  effect does not restart its idle timer on every tag. */
    @Test fun lastActivityMovesOnEveryPullTagAndNoteAtMostOncePerStep() = runTest {
        var now = 500L
        val fake = FakeRfidReader()
        val controller = RfidController(fake, MutableStateFlow(DEFAULT_RFID_SETTINGS), backgroundScope) { now }
        assertEquals(500L, controller.lastActivityMs.value)
        val changes = CopyOnWriteArrayList<Long>()
        backgroundScope.launch { controller.lastActivityMs.collect { changes += it } }
        controller.start(); settle()

        now = 1_500
        fake.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals("a pull, armed or not", 1_500L, controller.lastActivityMs.value)
        now = 2_500
        fake.emitTag("100348"); settle()
        assertEquals("a tag, in a sweep or not", 2_500L, controller.lastActivityMs.value)
        for (ms in 2_501L..3_499L step 7) {
            now = ms
            fake.emitTag("100348"); settle()
        }
        now = 3_499
        controller.noteActivity()
        assertEquals("within a step of the last stamp: unchanged", 2_500L, controller.lastActivityMs.value)
        now = 3_500
        controller.noteActivity()
        assertEquals(3_500L, controller.lastActivityMs.value)
        now = 4_500
        fake.emitTrigger(TriggerEvent.RELEASED, atMs = 10L); settle()
        assertEquals("by the clock, not the pull's stamp", 4_500L, controller.lastActivityMs.value)
        assertEquals("one change per step, not one per tag", listOf(500L, 1_500L, 2_500L, 3_500L, 4_500L), changes)
    }

    /**
     * The Zebra adapter's connect writes the requested layout and reads it back
     * (connect step 10) before it publishes `Connected`, so a generation whose
     * read-back already matches gets no layout job. Its layout writes run on a
     * worker, so one the controller stopped waiting for still finishes.
     */
    private class StepTenReader(
        private val inner: FakeRfidReader,
        private val worker: CoroutineScope,
        /** The pair the connect's step 10 leaves on the sled for the layout asked. */
        private val connectKeys: (SledTriggerLayout) -> Pair<SledKey, SledKey> = { it.keys() },
    ) : RfidReader by inner {
        private val _info = MutableStateFlow<SledInfo?>(null)
        private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
        override val info: StateFlow<SledInfo?> = _info
        override val connection: StateFlow<RfidConnection> = _connection

        private fun mirror() {
            _info.value = inner.info.value
            _connection.value = inner.connection.value
        }

        override suspend fun connect(request: SledConnectRequest): Result<Unit> {
            _info.value = null
            _connection.value = RfidConnection.Connecting
            val result = inner.connect(request)
            if (result.isSuccess) {
                val (upper, lower) = connectKeys(request.layout)
                inner.setInfo(inner.info.value!!.copy(trigger = readbackOf(upper, lower, null)))
            }
            mirror()
            return result
        }

        override suspend fun disconnect() {
            inner.disconnect()
            mirror()
        }

        override suspend fun setTriggerLayout(layout: SledTriggerLayout): Result<SledTriggerReadback> =
            worker.async { inner.setTriggerLayout(layout).also { _info.value = inner.info.value } }.await()

        fun drop(reason: String) {
            inner.dropLink(reason)
            mirror()
        }
    }

    /** A failed layout write belongs to its link: after a reconnect whose connect-time
     *  read-back matches (no layout job), after a write that finished late with an accepted
     *  read-back, and after a disconnect, the check-failed sentence is gone. */
    @Test fun aLayoutErrorDoesNotOutliveItsLinkOrALateWriteThatTook() = runTest {
        val fake = FakeRfidReader()
        val reader = StepTenReader(fake, backgroundScope)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(reader, settings, backgroundScope) { testScheduler.currentTime }
        controller.start(); settle()
        controller.connectForLifecycle { true }; settle()
        assertTrue(reader.connection.value is RfidConnection.Connected)
        assertEquals("the read-back matches: no layout job", emptyList<SledTriggerLayout>(), fake.layoutCalls)

        // A write that meets link trouble keeps the read-back and fails.
        fake.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        settings.value = settings.value.copy(triggerLayout = SledTriggerLayout.BARCODE); settle()
        assertEquals(SledWords.TRIGGER_CHECK_FAILED, controller.layoutError.value)

        // The link drops; the reconnect's own step 10 writes Barcode and reads it back.
        fake.layoutResult = null
        reader.drop("The sled disconnected.")
        at(currentTime + 2_000)
        assertTrue(reader.connection.value is RfidConnection.Connected)
        assertEquals(SledTriggerLayout.BARCODE, reader.info.value?.trigger?.layout)
        assertEquals("no job: the reconnect wrote it", listOf(SledTriggerLayout.BARCODE), fake.layoutCalls)
        assertNull("the new link's read-back stands", controller.layoutError.value)

        // A write past the call wait that finishes later with an accepted read-back.
        val hold = CompletableDeferred<Unit>()
        fake.holdNext = hold
        val t0 = currentTime
        settings.value = settings.value.copy(triggerLayout = SledTriggerLayout.SPLIT); settle()
        at(t0 + RfidController.CALL_WAIT_MS)
        assertEquals(SledWords.TRIGGER_CHECK_FAILED, controller.layoutError.value)
        hold.complete(Unit); settle()
        assertEquals(SledTriggerLayout.SPLIT, reader.info.value?.trigger?.layout)
        assertNull("the late write took", controller.layoutError.value)

        // A failure, then a disconnect.
        fake.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))
        settings.value = settings.value.copy(triggerLayout = SledTriggerLayout.RFID); settle()
        assertEquals(SledWords.TRIGGER_CHECK_FAILED, controller.layoutError.value)
        controller.disconnectNow(); settle()
        assertNull(controller.layoutError.value)
        assertEquals(emptyList<String>(), fake.violations)
    }

    @Test fun retryScannerPassesThrough() = runTest {
        val r = Rig(this)
        r.controller.start(); settle()
        assertTrue(r.controller.retryScanner().exceptionOrNull() is SledNotConnected)
        r.controller.connectNow(); settle()
        assertTrue(r.controller.retryScanner().isSuccess)
        assertEquals(2, r.fake.retryScannerCalls)
    }
}
