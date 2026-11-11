package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledScannerFault
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledWords
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_RESULT
import com.zebra.scannercontrol.DCSScannerInfo
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The scanner engine with a fake scanner SDK ([FakeSdk]): no test reaches a
 * sled. Most tests run the worker on the calling thread (a direct executor);
 * the ones about waiting and ordering use a real single-thread executor. No
 * timer fires by itself: [Timers] records every watchdog and the stale
 * window's end, and a test fires the one it means. [FakeSdk] moves the clock
 * past the stale window inside a successful establish (its [FakeSdk.tail]),
 * so an open is `Ready` when it returns unless a test says otherwise.
 *
 * The doubles are nested, not top-level, so `ZebraRfidReaderTest` can reuse
 * them and no name can clash with Track B's test files (preflight ruling 12).
 *
 * The pure helpers are here too: [chooseScanner] (matching a listed scanner
 * against this kiosk's own sled, never a stranger's device),
 * [scanCommandInXml], and [reapLeakedReaderThreads] with the connect dump's
 * count, which run against real threads that copy the vendor reader's loop.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ZebraBarcodeEngineTest {

    /** A clock the test moves. */
    internal class FakeClock(@Volatile var now: Long = 1_000L)

    /** Every timer the engine armed. Nothing fires unless a test calls [Armed.fire]. */
    internal class Timers {
        inner class Armed(val ms: Long, private val onTimeout: () -> Unit) {
            @Volatile var cancelled = false
                private set

            fun cancel() {
                cancelled = true
            }

            /** Fires once, unless it was cancelled. */
            fun fire() {
                if (cancelled) return
                cancelled = true
                onTimeout()
            }
        }

        val armed = CopyOnWriteArrayList<Armed>()

        val watchdog: (Long, () -> Unit) -> () -> Unit = { ms, onTimeout ->
            val timer = Armed(ms, onTimeout)
            armed += timer
            ({ timer.cancel() })
        }

        /** The timers of [ms] still armed. */
        fun live(ms: Long): List<Armed> = armed.filter { it.ms == ms && !it.cancelled }

        /** The one timer still armed (the watchdogs are cancelled when their call returns). */
        fun liveOne(): Armed = armed.single { !it.cancelled }
    }

    /**
     * A scanner SDK that records each call ("mode DISABLED", "list",
     * "establish 10", ...) and answers from its knobs. Like the vendor's, a
     * successful establish sends the established callback inside the call
     * (then moves the clock by [tail]), and a terminate sends the terminated
     * callback inside the call.
     */
    internal class FakeSdk(private val clock: FakeClock) : ScannerSdk {
        lateinit var events: ScannerEvents
        val calls = CopyOnWriteArrayList<String>()
        @Volatile var listed: List<ScannerCandidate> = listOf(SLED)
        val establishResults = ConcurrentLinkedQueue<ScannerResult>()
        @Volatile var terminateResult = ScannerResult.SUCCESS
        @Volatile var pullResult = ScannerResult.SUCCESS
        @Volatile var tail = ZebraBarcodeEngine.STALE_WINDOW_MS
        @Volatile var beforeEstablished: (Int) -> Unit = {}
        @Volatile var afterEstablished: (Int) -> Unit = {}
        @Volatile var onCall: (String) -> Unit = {}

        private fun record(call: String) {
            calls += call
            onCall(call)
        }

        override fun setMode(mode: ScannerMode): ScannerResult {
            record("mode $mode")
            return ScannerResult.SUCCESS
        }

        override fun list(): List<ScannerCandidate> {
            record("list")
            return listed
        }

        override fun establish(scannerId: Int): ScannerResult {
            record("establish $scannerId")
            beforeEstablished(scannerId)
            val result = establishResults.poll() ?: ScannerResult.SUCCESS
            if (result == ScannerResult.SUCCESS) {
                events.sessionEstablished(scannerId)
                afterEstablished(scannerId)
                clock.now += tail
            }
            return result
        }

        override fun terminate(scannerId: Int): ScannerResult {
            record("terminate $scannerId")
            events.sessionTerminated(scannerId)
            return terminateResult
        }

        override fun pullTrigger(scannerId: Int): ScannerResult {
            record("pull $scannerId")
            return pullResult
        }

        override fun releaseTrigger(scannerId: Int): ScannerResult {
            record("release $scannerId")
            return ScannerResult.SUCCESS
        }
    }

    /**
     * One engine over a [FakeSdk], on [executor] (the calling thread by
     * default). Its reaper is a stand-in: it records where it ran, among the
     * vendor calls, and reports [reapResult]. The vendor calls themselves stay
     * in [FakeSdk.calls], unchanged.
     */
    internal class Rig(val executor: Executor = Executor { it.run() }) {
        val clock = FakeClock()
        val timers = Timers()
        val sdk = FakeSdk(clock)
        val logs = CopyOnWriteArrayList<String>()
        @Volatile var bluetooth = true
        val sdkBuilds = AtomicInteger()

        /** Where each reap ran: how many vendor calls came before it. */
        val reapsAt = CopyOnWriteArrayList<Int>()
        @Volatile var reapResult = ReapResult(found = 0, reaped = 0, survivors = 0, elapsedMs = 0)
        @Volatile var onReap: () -> Unit = {}

        val engine = ZebraBarcodeEngine(
            sdk = {
                sdkBuilds.incrementAndGet()
                sdk
            },
            executor = executor,
            bluetoothOn = { bluetooth },
            clock = { clock.now },
            watchdog = timers.watchdog,
            log = { logs += it },
            reap = {
                reapsAt += sdk.calls.size
                onReap()
                reapResult
            },
        ).also { sdk.events = it }

        val state: SledScannerState get() = engine.state.value

        fun open(generation: Int = 1) = engine.want(generation, open = true, target = SLED_IDENTITY)

        fun close(generation: Int = 1) = engine.want(generation, open = false, target = SLED_IDENTITY)

        /** The vendor calls, with [REAP] where each reap ran. */
        fun callsAndReaps(): List<String> {
            val calls = sdk.calls.toList()
            val merged = mutableListOf<String>()
            var next = 0
            for (at in reapsAt) {
                while (next < at) merged += calls[next++]
                merged += REAP
            }
            while (next < calls.size) merged += calls[next++]
            return merged
        }
    }

    companion object {
        internal val SLED_IDENTITY = SledIdentity(name = "RFD4031", address = "00:11:22:33:44:55", serial = null)
        internal val SLED = ScannerCandidate(scannerId = 10, name = "RFD4031", model = "RFD40", serial = "00:11:22:33:44:55")
        private val STRANGER = ScannerCandidate(scannerId = 1, name = "HSLT_a844", model = null, serial = "CA:4C:A1:81:A8:44")

        /** A first open: the mode reset, the Bluetooth mode, the list to find the id, and the establish. */
        internal val OPEN_CALLS = listOf("mode DISABLED", "mode BT_NORMAL", "list", "establish 10")

        /** A close: terminate, then the mode reset. */
        internal val CLOSE_CALLS = listOf("terminate 10", "mode DISABLED")

        /** Where a reap ran, in [Rig.callsAndReaps]. */
        private const val REAP = "reap"

        private val READY = SledScannerState.Ready
        private val OPENING = SledScannerState.Opening
        private val OFF = SledScannerState.Off
        private val DID_NOT_START = SledScannerState.Unavailable(SledScannerFault.DID_NOT_START)
        private val STOPPED_RESPONDING = SledScannerState.Unavailable(SledScannerFault.STOPPED_RESPONDING)
        private val BLUETOOTH_OFF = SledScannerState.Unavailable(SledScannerFault.BLUETOOTH_OFF)
    }

    private fun singleWorker(): ExecutorService = Executors.newSingleThreadExecutor()

    /** Waits until everything posted to [worker] so far has run. */
    private fun drain(worker: ExecutorService) {
        worker.submit {}.get(5, TimeUnit.SECONDS)
    }

    /** Holds [worker] until the returned latch opens. */
    private fun hold(worker: ExecutorService): CountDownLatch {
        val latch = CountDownLatch(1)
        worker.execute { latch.await(5, TimeUnit.SECONDS) }
        return latch
    }

    private fun CountDownLatch.awaitBriefly(): Boolean = await(5, TimeUnit.SECONDS)

    // ── generations and the one desired value ──

    @Test fun aLateEstablishForAnOldGenerationIsTerminatedAndNotPublished() {
        val rig = Rig()
        var first = true
        // A new link (generation 2) comes up while generation 1's establish is still running.
        rig.sdk.beforeEstablished = {
            if (first) {
                first = false
                rig.open(generation = 2)
            }
        }
        val stateAtTerminate = CopyOnWriteArrayList<SledScannerState>()
        rig.sdk.onCall = { if (it.startsWith("terminate")) stateAtTerminate += rig.state }

        rig.open(generation = 1)

        assertEquals(
            OPEN_CALLS + CLOSE_CALLS + listOf("mode DISABLED", "mode BT_NORMAL", "establish 10"),
            rig.sdk.calls.toList(),
        )
        assertEquals("generation 1's late session was never shown", listOf(OPENING), stateAtTerminate.toList())
        assertEquals(READY, rig.state)
    }

    @Test fun fiveFlipsDuringOneSlowEstablishMakeAtMostOneMoreEstablish() {
        // Ending open in a new generation: the slow session is closed, one more is opened.
        // Ending closed: the slow session is closed and nothing more is opened.
        for (endsOpen in listOf(true, false)) {
            val worker = singleWorker()
            try {
                val rig = Rig(worker)
                val entered = CountDownLatch(1)
                val release = CountDownLatch(1)
                rig.sdk.beforeEstablished = {
                    entered.countDown()
                    release.awaitBriefly()
                }
                rig.open()
                assertTrue(entered.awaitBriefly())

                rig.close()
                rig.open()
                rig.close()
                rig.open()
                if (endsOpen) rig.open(generation = 2) else rig.close()
                release.countDown()
                drain(worker)

                val establishes = rig.sdk.calls.count { it.startsWith("establish") }
                if (endsOpen) {
                    assertEquals(2, establishes)
                    assertEquals(OPEN_CALLS + CLOSE_CALLS + listOf("mode DISABLED", "mode BT_NORMAL", "establish 10"), rig.sdk.calls.toList())
                    assertEquals(READY, rig.state)
                } else {
                    assertEquals(1, establishes)
                    assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())
                    assertEquals(OFF, rig.state)
                }
            } finally {
                worker.shutdown()
            }
        }
    }

    @Test fun anOlderGenerationsRequestOrLossChangesNothing() {
        val rig = Rig()
        rig.open(generation = 2)
        assertEquals(READY, rig.state)

        rig.close(generation = 1)
        rig.engine.linkLost(1)

        assertEquals(READY, rig.state)
        assertEquals(OPEN_CALLS, rig.sdk.calls.toList())

        rig.engine.linkLost(2)
        assertEquals(OFF, rig.state)
        assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())

        rig.open(generation = 2)
        assertEquals("a lost generation never opens again", OFF, rig.state)
        assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())
    }

    // ── establish results ──

    @Test fun alreadyActiveNotOpenedHereTerminatesAndRetriesOnce() {
        val rig = Rig()
        rig.sdk.establishResults += ScannerResult.ALREADY_ACTIVE

        rig.open()

        assertEquals(OPEN_CALLS + listOf("terminate 10", "establish 10"), rig.sdk.calls.toList())
        assertEquals(READY, rig.state)
    }

    @Test fun aSecondAlreadyActiveIsDidNotStart() {
        val rig = Rig()
        rig.sdk.establishResults += ScannerResult.ALREADY_ACTIVE
        rig.sdk.establishResults += ScannerResult.ALREADY_ACTIVE

        rig.open()

        assertEquals(OPEN_CALLS + listOf("terminate 10", "establish 10", "mode DISABLED"), rig.sdk.calls.toList())
        assertEquals(DID_NOT_START, rig.state)
    }

    @Test fun alreadyActiveAfterATerminateThatDidNotGoThroughIsTerminatedAndEstablishedAgain() {
        // The terminate fails (in the vendor, a throw before it clears its
        // active flag), so the vendor still marks the scanner active. The
        // close's mode reset stopped the vendor's Bluetooth manager and closed
        // the socket all the same, so the next open in the same generation
        // (a Barcode, RFID, Barcode flip) must not take ALREADY_ACTIVE as up.
        val rig = Rig()
        rig.open()
        assertEquals(READY, rig.state)
        rig.sdk.terminateResult = ScannerResult.FAILURE
        rig.close()
        assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())
        rig.sdk.terminateResult = ScannerResult.SUCCESS
        val again = listOf("mode DISABLED", "mode BT_NORMAL", "establish 10", "terminate 10", "establish 10")

        rig.sdk.calls.clear()
        rig.sdk.establishResults += ScannerResult.ALREADY_ACTIVE
        rig.open()

        assertEquals("the same generation: terminate, then one more establish", again, rig.sdk.calls.toList())
        assertEquals(READY, rig.state)

        rig.close()
        rig.sdk.calls.clear()
        rig.sdk.establishResults += ScannerResult.ALREADY_ACTIVE
        rig.open(generation = 2)

        assertEquals("a new generation: the same", again, rig.sdk.calls.toList())
        assertEquals(READY, rig.state)
    }

    @Test fun notAvailableDropsTheCachedIdAndListsAgain() {
        val rig = Rig()
        rig.open()
        assertEquals(READY, rig.state)
        rig.close()
        rig.sdk.calls.clear()
        rig.sdk.listed = listOf(STRANGER, SLED.copy(scannerId = 11))
        rig.sdk.establishResults += ScannerResult.NOT_AVAILABLE

        rig.open()

        assertEquals(listOf("mode DISABLED", "mode BT_NORMAL", "establish 10", "list", "establish 11"), rig.sdk.calls.toList())
        assertEquals(READY, rig.state)

        rig.close()
        rig.sdk.calls.clear()
        rig.open()
        assertEquals("the new id is cached", listOf("mode DISABLED", "mode BT_NORMAL", "establish 11"), rig.sdk.calls.toList())
    }

    @Test fun aListWithoutThisSledIsDidNotStartAndConnectsToNoStranger() {
        val rig = Rig()
        rig.sdk.listed = listOf(STRANGER)

        rig.open()

        assertEquals(listOf("mode DISABLED", "mode BT_NORMAL", "list", "mode DISABLED"), rig.sdk.calls.toList())
        assertEquals(DID_NOT_START, rig.state)
        assertTrue("the listed names are logged", rig.logs.any { it.contains("HSLT_a844") })
    }

    // ── Bluetooth ──

    @Test fun bluetoothOffMakesNoVendorCall() {
        val rig = Rig()
        rig.bluetooth = false

        rig.open()

        assertEquals(BLUETOOTH_OFF, rig.state)
        assertEquals("the SDK is not even built", 0, rig.sdkBuilds.get())
        assertTrue(rig.sdk.calls.isEmpty())

        // Bluetooth goes off between the mode reset and the Bluetooth mode: the Bluetooth mode is never sent.
        val late = Rig()
        late.sdk.onCall = { if (it == "mode DISABLED") late.bluetooth = false }
        late.open()
        assertEquals(listOf("mode DISABLED"), late.sdk.calls.toList())
        assertEquals(BLUETOOTH_OFF, late.state)
    }

    @Test fun bluetoothTurningOffWhileReadyGoesOffAndDropsTheCachedId() {
        val worker = singleWorker()
        try {
            val rig = Rig(worker)
            rig.open()
            drain(worker)
            assertEquals(READY, rig.state)

            val release = hold(worker)
            rig.bluetooth = false
            rig.engine.bluetoothTurningOff()
            assertEquals("Off at once, before the worker gets to it", OFF, rig.state)
            assertEquals(OPEN_CALLS, rig.sdk.calls.toList())
            release.countDown()
            drain(worker)
            assertEquals("terminate, then the mode reset", OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())

            // While Bluetooth is off, an open makes no vendor call.
            rig.open(generation = 2)
            drain(worker)
            assertEquals(BLUETOOTH_OFF, rig.state)
            assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())

            // Bluetooth is back: the next open lists again instead of using the old id.
            rig.bluetooth = true
            rig.open(generation = 3)
            drain(worker)
            assertEquals(OPEN_CALLS + CLOSE_CALLS + OPEN_CALLS, rig.sdk.calls.toList())
            assertEquals(READY, rig.state)
        } finally {
            worker.shutdown()
        }
    }

    // ── closing ──

    @Test fun anUnexpectedTerminationOffersTryAgainAndQueuesTerminateThenDisabled() {
        val worker = singleWorker()
        try {
            val rig = Rig(worker)
            rig.open()
            drain(worker)
            assertEquals(READY, rig.state)

            rig.engine.sessionTerminated(7)
            drain(worker)
            assertEquals("another scanner's termination changes nothing", READY, rig.state)

            val release = hold(worker)
            rig.engine.sessionTerminated(10)
            // The RFID link is still Connected in a layout that uses the
            // scanner, and the screens offer Try again only for this fault.
            assertEquals("at once, as a scanner that did not start", DID_NOT_START, rig.state)
            assertEquals(OPEN_CALLS, rig.sdk.calls.toList())
            release.countDown()
            drain(worker)
            assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())

            rig.open()
            drain(worker)
            assertEquals("asking again for the same session does not reopen it", DID_NOT_START, rig.state)
            assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())

            assertTrue(runBlocking { rig.engine.retry(1) }.isSuccess)
            drain(worker)
            assertEquals(
                "Try again reopens it",
                OPEN_CALLS + CLOSE_CALLS + listOf("mode DISABLED", "mode BT_NORMAL", "establish 10"),
                rig.sdk.calls.toList(),
            )
            assertEquals(READY, rig.state)

            rig.engine.sessionTerminated(10)
            assertEquals(DID_NOT_START, rig.state)
            rig.engine.linkLost(1)
            assertEquals("the link drop that follows shows Off", OFF, rig.state)
        } finally {
            worker.shutdown()
        }
    }

    @Test fun bluetoothTurningOffAfterAnUnexpectedTerminationShowsOff() {
        val rig = Rig()
        rig.open()
        rig.engine.sessionTerminated(10)
        assertEquals(DID_NOT_START, rig.state)

        rig.engine.bluetoothTurningOff()

        assertEquals("the link drop and the reconnect after it open a new request", OFF, rig.state)
    }

    @Test fun closingWhileReadyGoesOffAndTerminatesThenResetsTheMode() {
        val rig = Rig()
        rig.open()
        assertEquals(READY, rig.state)

        rig.close()

        assertEquals(OFF, rig.state)
        assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())
    }

    // ── the stale window ──

    @Test fun aBarcodeBeforeTheEstablishedCallbackOrInsideTheWindowIsDropped() = runTest {
        val rig = Rig()
        val got = mutableListOf<SledBarcode>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { rig.engine.barcodes.toList(got) }
        rig.sdk.tail = 0L
        rig.sdk.beforeEstablished = { rig.engine.barcode("OLD-1".toByteArray(), 3, it) }
        rig.sdk.afterEstablished = { rig.engine.barcode("OLD-22".toByteArray(), 3, it) }

        rig.open()
        rig.engine.barcode("OLD-333".toByteArray(), 3, 10)
        assertEquals(OPENING, rig.state)

        rig.clock.now += ZebraBarcodeEngine.STALE_WINDOW_MS
        rig.timers.liveOne().fire()
        assertEquals(READY, rig.state)
        rig.engine.barcode("  ASSET-0042\r\n".toByteArray(), 3, 10)
        runCurrent()

        assertEquals(listOf(SledBarcode("ASSET-0042", "CODE128")), got)
        for (length in listOf(5, 6, 7)) {
            assertTrue("a dropped barcode is logged with its length ($length)", rig.logs.any { it.contains("of length $length ") })
        }
        assertTrue("never its value", rig.logs.none { it.contains("OLD") || it.contains("ASSET") })
    }

    @Test fun readyComesAfterTheStaleWindow() {
        val rig = Rig()
        rig.sdk.tail = 100L

        rig.open()

        assertEquals(OPENING, rig.state)
        val window = rig.timers.liveOne()
        assertEquals("the rest of the window after the establish returned", 150L, window.ms)

        rig.clock.now += 149
        window.fire()
        assertEquals("1 ms short of the window", OPENING, rig.state)
        val rest = rig.timers.liveOne()
        assertEquals(1L, rest.ms)

        rig.clock.now += 1
        rest.fire()
        assertEquals(READY, rig.state)
    }

    @Test fun aBarcodeWhileNotReadyIsNotEmitted() = runTest {
        val got = mutableListOf<SledBarcode>()

        val off = Rig()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { off.engine.barcodes.toList(got) }
        off.engine.barcode("A1".toByteArray(), 3, 10)

        val failed = Rig()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { failed.engine.barcodes.toList(got) }
        failed.sdk.establishResults += ScannerResult.FAILURE
        failed.open()
        assertEquals(DID_NOT_START, failed.state)
        failed.engine.barcode("A2".toByteArray(), 3, 10)

        val closed = Rig()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { closed.engine.barcodes.toList(got) }
        closed.open()
        closed.close()
        closed.engine.barcode("A3".toByteArray(), 3, 10)

        val blank = Rig()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { blank.engine.barcodes.toList(got) }
        blank.open()
        blank.engine.barcode(" \r\n".toByteArray(), 3, 10)
        runCurrent()

        assertTrue(got.isEmpty())
    }

    // ── the watchdog ──

    @Test fun theWatchdogShowsStoppedRespondingAndALateResultIsApplied() {
        // Still wanted when the late result comes: it is applied (Ready).
        // No longer wanted: the late session is terminated and the mode reset.
        for (stillWanted in listOf(true, false)) {
            val worker = singleWorker()
            try {
                val rig = Rig(worker)
                val entered = CountDownLatch(1)
                val release = CountDownLatch(1)
                rig.sdk.beforeEstablished = {
                    entered.countDown()
                    release.awaitBriefly()
                }
                rig.open()
                assertTrue(entered.awaitBriefly())
                assertEquals(OPENING, rig.state)

                rig.timers.live(ZebraBarcodeEngine.ESTABLISH_WATCHDOG_MS).single().fire()
                assertEquals(STOPPED_RESPONDING, rig.state)
                val retry = runBlocking { rig.engine.retry(1) }
                assertEquals("Try again fails at once", SledWords.SCANNER_STOPPED_RESPONDING, retry.exceptionOrNull()?.message)

                if (!stillWanted) {
                    rig.close()
                    assertEquals("not wanted is Off, even while the call is stuck", OFF, rig.state)
                }
                release.countDown()
                drain(worker)

                if (stillWanted) {
                    assertEquals(READY, rig.state)
                    assertEquals(OPEN_CALLS, rig.sdk.calls.toList())
                } else {
                    assertEquals(OFF, rig.state)
                    assertEquals(OPEN_CALLS + CLOSE_CALLS, rig.sdk.calls.toList())
                }
            } finally {
                worker.shutdown()
            }
        }
    }

    @Test fun everyVendorCallIsWatchedAndTheWatchdogIsCancelledWhenItReturns() {
        val rig = Rig()
        rig.open()

        val watchdogs = rig.timers.armed.map { it.ms }
        assertEquals(
            listOf(
                ZebraBarcodeEngine.COMMAND_WATCHDOG_MS,
                ZebraBarcodeEngine.COMMAND_WATCHDOG_MS,
                ZebraBarcodeEngine.COMMAND_WATCHDOG_MS,
                ZebraBarcodeEngine.ESTABLISH_WATCHDOG_MS,
            ),
            watchdogs,
        )
        assertTrue(rig.timers.armed.all { it.cancelled })
    }

    // ── soft scan and Try again ──

    @Test fun softScanAwaitsTheWorkerWithoutBlockingTheCaller() {
        val worker = singleWorker()
        try {
            val rig = Rig(worker)
            rig.open()
            drain(worker)
            assertEquals(READY, rig.state)

            val release = hold(worker)
            val timedOut = runBlocking {
                try {
                    withTimeout(100) { rig.engine.softScan(pull = true) }
                    false
                } catch (e: TimeoutCancellationException) {
                    true
                }
            }
            assertTrue("the caller stops waiting", timedOut)
            assertFalse("the pull waits behind the held worker", rig.sdk.calls.contains("pull 10"))

            release.countDown()
            drain(worker)
            assertEquals("the queued pull still runs, once", 1, rig.sdk.calls.count { it == "pull 10" })

            assertTrue(runBlocking { rig.engine.softScan(pull = false) }.isSuccess)
            assertEquals(1, rig.sdk.calls.count { it == "release 10" })
        } finally {
            worker.shutdown()
        }
    }

    @Test fun softScanFailsUnlessReadyAndAFailedPullIsDidNotStart() = runTest {
        val rig = Rig()
        assertTrue(rig.engine.softScan(pull = true).exceptionOrNull() is SledNotConnected)
        rig.sdk.tail = 0L
        rig.open()
        assertEquals(OPENING, rig.state)
        assertTrue("not while opening", rig.engine.softScan(pull = true).exceptionOrNull() is SledNotConnected)
        assertFalse(rig.sdk.calls.contains("pull 10"))

        rig.clock.now += ZebraBarcodeEngine.STALE_WINDOW_MS
        rig.timers.liveOne().fire()
        assertTrue(rig.engine.softScan(pull = true).isSuccess)

        rig.sdk.pullResult = ScannerResult.FAILURE
        val failed = rig.engine.softScan(pull = true)
        assertTrue(failed.isFailure)
        assertNull("the failure carries no sentence; the state says it", failed.exceptionOrNull()?.message)
        assertEquals(DID_NOT_START, rig.state)
    }

    @Test fun retryTerminatesThenOpensAgainAndReturnsOnceQueued() {
        val worker = singleWorker()
        try {
            val rig = Rig(worker)
            assertTrue("nothing asked for", runBlocking { rig.engine.retry(1) }.exceptionOrNull() is SledNotConnected)
            rig.sdk.establishResults += ScannerResult.FAILURE
            rig.open()
            drain(worker)
            assertEquals(DID_NOT_START, rig.state)
            assertTrue("an older generation", runBlocking { rig.engine.retry(0) }.exceptionOrNull() is SledNotConnected)

            val release = hold(worker)
            assertTrue(runBlocking { rig.engine.retry(1) }.isSuccess)
            assertEquals("Starting at once", OPENING, rig.state)
            release.countDown()
            drain(worker)
            assertEquals(READY, rig.state)

            rig.sdk.calls.clear()
            assertTrue(runBlocking { rig.engine.retry(1) }.isSuccess)
            drain(worker)
            assertEquals(CLOSE_CALLS + listOf("mode DISABLED", "mode BT_NORMAL", "establish 10"), rig.sdk.calls.toList())
            assertEquals(READY, rig.state)
        } finally {
            worker.shutdown()
        }
    }

    // ── the vendor's leaked reader threads ──
    //
    // The vendor's reader thread swallows the one interrupt its own cancel()
    // sends, so each session the vendor closes leaves it polling a closed
    // socket every 50 ms. The engine reaps them where it holds no session.

    @Test fun everyCloseReapsAfterItsModeResetAndLogsOnlyWhenItFoundSome() {
        val rig = Rig()
        rig.open()
        rig.reapResult = ReapResult(found = 2, reaped = 1, survivors = 1, elapsedMs = 500)

        rig.close()

        assertEquals(listOf(REAP) + OPEN_CALLS + CLOSE_CALLS + REAP, rig.callsAndReaps())
        assertEquals(
            "one line, for the reap that found some",
            listOf("Scanner: reaped 1 of 2 leaked reader thread(s) in 500 ms; 1 still running."),
            rig.logs.filter { it.startsWith("Scanner: reaped") },
        )

        // A failed open after the Bluetooth mode went in is closed the same way.
        val failed = Rig()
        failed.sdk.listed = listOf(STRANGER)
        failed.open()
        assertEquals(DID_NOT_START, failed.state)
        assertEquals(listOf(REAP, "mode DISABLED", "mode BT_NORMAL", "list", "mode DISABLED", REAP), failed.callsAndReaps())
        assertTrue("found none: nothing logged", failed.logs.none { it.startsWith("Scanner: reaped") })
    }

    @Test fun everyOpenReapsBeforeItsModeReset() {
        val rig = Rig()
        rig.open()
        assertEquals(listOf(REAP) + OPEN_CALLS, rig.callsAndReaps())

        rig.close()
        rig.open(generation = 2)

        assertEquals(
            listOf(REAP) + OPEN_CALLS + CLOSE_CALLS + REAP + REAP + listOf("mode DISABLED", "mode BT_NORMAL", "establish 10"),
            rig.callsAndReaps(),
        )
        assertEquals(READY, rig.state)
    }

    @Test fun noReapWhileASessionIsUpOrOpening() {
        val worker = singleWorker()
        try {
            val rig = Rig(worker)
            val reapThreads = CopyOnWriteArrayList<Thread>()
            rig.onReap = { reapThreads += Thread.currentThread() }
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            rig.sdk.beforeEstablished = {
                entered.countDown()
                release.awaitBriefly()
            }
            rig.open()
            assertTrue(entered.awaitBriefly())
            assertEquals(OPENING, rig.state)

            // Sled triggers changed to Barcode while the scanner is opening: the same session is still asked for.
            rig.open()
            assertEquals("only the reap before the open", listOf(0), rig.reapsAt.toList())
            release.countDown()
            drain(worker)
            assertEquals(READY, rig.state)

            // Changed again while Ready (Both to Barcode keeps the scanner).
            rig.open()
            drain(worker)

            assertEquals(listOf(REAP) + OPEN_CALLS, rig.callsAndReaps())
            assertEquals("on the engine's worker, never the caller's thread", 1, reapThreads.size)
            assertTrue(reapThreads.single() !== Thread.currentThread())
        } finally {
            worker.shutdown()
        }
    }

    @Test fun aSingleInterruptDoesNotStopAThreadThatSwallowsItsInterrupt() {
        val zombie = startSleeping(ZombieReader())
        try {
            zombie.interrupt() // all the vendor's own cancel() does before it closes the socket
            zombie.join(300)

            assertTrue("the catch swallowed the interrupt and the loop went on", zombie.isAlive)
        } finally {
            stopAll(listOf(zombie))
        }
    }

    @Test fun theReaperStopsEveryZombieWithinTheBound() {
        val zombies: List<Thread> = List(3) { startSleeping(ZombieReader()) }
        try {
            val result = reapLeakedReaderThreads(isVendorReader = { it in zombies })

            assertEquals(ReapResult(found = 3, reaped = 3, survivors = 0, elapsedMs = result.elapsedMs), result)
            assertTrue("within $REAP_BOUND_MS ms: ${result.elapsedMs}", result.elapsedMs in 0..REAP_BOUND_MS)
            assertTrue(zombies.none { it.isAlive })
        } finally {
            stopAll(zombies)
        }
    }

    @Test fun theReaperTouchesOnlyVendorReaderThreads() {
        val zombie = startSleeping(ZombieReader())
        val bystander = startSleeping(Bystander())
        val finished = Thread {}.apply {
            start()
            join()
        }
        try {
            // Every thread but the bystander passes the test, the calling thread included.
            val result = reapLeakedReaderThreads(
                threads = { listOf(zombie, bystander, finished, Thread.currentThread()) },
                isVendorReader = { it !== bystander },
            )

            assertEquals("the alive zombie only: never the calling thread or a finished one", 1, result.found)
            assertEquals(1, result.reaped)
            assertFalse(zombie.isAlive)
            assertFalse("the calling thread was not interrupted", Thread.interrupted())
            bystander.join(100)
            assertTrue("the bystander still runs", bystander.isAlive)

            // The real test takes the vendor's reader class only.
            assertEquals(0, reapLeakedReaderThreads(threads = { listOf(bystander) }).found)
            assertTrue(bystander.isAlive)
        } finally {
            stopAll(listOf(zombie, bystander))
        }
    }

    @Test fun theReaperNeverThrows() {
        val noList = reapLeakedReaderThreads(threads = { throw IllegalStateException("no thread list") })
        assertEquals(ReapResult(0, 0, 0, noList.elapsedMs), noList)

        val zombie = startSleeping(ZombieReader())
        try {
            val badTest = reapLeakedReaderThreads(threads = { listOf(zombie) }, isVendorReader = { throw NoClassDefFoundError("vendor") })
            assertEquals(ReapResult(0, 0, 0, badTest.elapsedMs), badTest)

            val badClock = reapLeakedReaderThreads(threads = { listOf(zombie) }, isVendorReader = { true }, now = { throw IllegalStateException("clock") })
            assertEquals(ReapResult(0, 0, 0, badClock.elapsedMs), badClock)
            assertTrue(zombie.isAlive)
        } finally {
            stopAll(listOf(zombie))
        }
    }

    @Test fun theConnectDumpCountsTheAliveThreadsTheReaperWouldTake() {
        val finished = Thread {}.apply {
            start()
            join()
        }
        val alive = Thread.currentThread()

        assertEquals(
            "Dump: 1 vendor scanner reader thread(s) alive.",
            vendorReaderThreadsDump(threads = { listOf(alive, finished) }, isVendorReader = { true }),
        )
        assertEquals("the real test takes the vendor's reader class only", "Dump: 0 vendor scanner reader thread(s) alive.", vendorReaderThreadsDump(threads = { listOf(alive) }))
        assertEquals(
            "Dump: the app's threads could not be listed, so the vendor scanner reader threads were not counted.",
            vendorReaderThreadsDump(threads = { throw IllegalStateException("no thread list") }),
        )
    }

    /**
     * The vendor reader thread's loop, as `BluetoothManager.ConnectedThread.run`
     * has it once its socket is closed: sleep 50 ms a pass, and swallow the
     * interrupt the sleep throws.
     */
    private open class SwallowsItsInterrupt(name: String) : Thread(name) {
        init {
            isDaemon = true
        }

        override fun run() {
            while (!Thread.interrupted()) {
                try {
                    Thread.sleep(50)
                } catch (e: InterruptedException) {
                    e.printStackTrace()
                }
            }
        }
    }

    /** One the tests take for a vendor reader thread. */
    private class ZombieReader : SwallowsItsInterrupt("zombie-reader")

    /** The same loop in a class that is not the vendor's. */
    private class Bystander : SwallowsItsInterrupt("bystander")

    /** Starts [thread] and waits until it sleeps, where the vendor's own cancel lands its one interrupt. */
    private fun startSleeping(thread: Thread): Thread {
        thread.start()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (thread.state != Thread.State.TIMED_WAITING) {
            check(System.nanoTime() < deadline) { "${thread.name} never went to sleep" }
            Thread.sleep(1)
        }
        return thread
    }

    /** Stops the looping threads a test started, so none outlives it. */
    private fun stopAll(threads: List<Thread>) {
        reapLeakedReaderThreads(threads = { threads }, isVendorReader = { true }, boundMs = 5_000)
        threads.forEach { it.join(1_000) }
    }

    // ── the delegate ──

    @Test fun aThrowingSinkDoesNotEscapeTheDelegate() {
        val sink = object : ScannerEvents {
            override fun sessionEstablished(scannerId: Int) {
                throw IllegalStateException("sink")
            }

            override fun sessionTerminated(scannerId: Int) {
                throw NoClassDefFoundError("sink")
            }

            override fun barcode(bytes: ByteArray?, type: Int, scannerId: Int) {
                throw IllegalStateException("sink")
            }
        }
        val logged = CopyOnWriteArrayList<Throwable?>()
        val delegate = scannerDelegate(sink) { _, t -> logged += t }

        delegate.dcssdkEventBarcode("ABC".toByteArray(), 3, 10)
        delegate.dcssdkEventCommunicationSessionEstablished(DCSScannerInfo())
        delegate.dcssdkEventCommunicationSessionEstablished(null)
        delegate.dcssdkEventCommunicationSessionTerminated(10)
        delegate.dcssdkEventScannerAppeared(null)
        delegate.dcssdkEventScannerDisappeared(10)
        delegate.dcssdkEventImage(null, 10)
        delegate.dcssdkEventVideo(null, 10)
        delegate.dcssdkEventBinaryData(null, 10)
        delegate.dcssdkEventFirmwareUpdate(null)
        delegate.dcssdkEventAuxScannerAppeared(null, null)

        assertEquals(4, logged.count { it != null })
    }

    @Test fun nullAndEmptyBarcodeArraysAreIgnored() {
        val seen = CopyOnWriteArrayList<ByteArray?>()
        val sink = object : ScannerEvents {
            override fun sessionEstablished(scannerId: Int) = Unit
            override fun sessionTerminated(scannerId: Int) = Unit
            override fun barcode(bytes: ByteArray?, type: Int, scannerId: Int) {
                seen += bytes
            }
        }
        val delegate = scannerDelegate(sink) { _, _ -> }

        delegate.dcssdkEventBarcode(null, 3, 10)
        delegate.dcssdkEventBarcode(ByteArray(0), 3, 10)
        assertTrue(seen.isEmpty())

        delegate.dcssdkEventBarcode("A".toByteArray(), 3, 10)
        assertEquals(1, seen.size)
    }

    @Test fun vendorResultsMapOntoTheEnginesFive() {
        assertEquals(ScannerResult.SUCCESS, scannerResultOf(DCSSDK_RESULT.DCSSDK_RESULT_SUCCESS))
        assertEquals(ScannerResult.ALREADY_ACTIVE, scannerResultOf(DCSSDK_RESULT.DCSSDK_RESULT_SCANNER_ALREADY_ACTIVE))
        assertEquals(ScannerResult.NOT_AVAILABLE, scannerResultOf(DCSSDK_RESULT.DCSSDK_RESULT_SCANNER_NOT_AVAILABLE))
        assertEquals(ScannerResult.NOT_ACTIVE, scannerResultOf(DCSSDK_RESULT.DCSSDK_RESULT_SCANNER_NOT_ACTIVE))
        assertEquals(ScannerResult.FAILURE, scannerResultOf(DCSSDK_RESULT.DCSSDK_RESULT_RESPONSE_TIMEOUT))
        assertEquals(ScannerResult.FAILURE, scannerResultOf(null))
    }

    // ── chooseScanner ──
    //
    // Every discriminating test places a non-matching "stranger" candidate
    // ahead of the real sled, so a target-blind firstOrNull() (the real bug:
    // a stranger's dive computer chosen over the sled further down the list)
    // would return the stranger and fail.

    @Test fun chooseScannerReturnsNullWhenCandidateListIsEmpty() {
        val target = SledIdentity(name = "RFD40+_23087520101428", address = "48:A4:93:BD:15:DB", serial = null)
        assertNull(chooseScanner(emptyList(), target))
    }

    @Test fun chooseScannerMatchesByAddress() {
        val target = SledIdentity(name = "RFD40+_23087520101428", address = "48:A4:93:BD:15:DB", serial = null)
        val stranger = ScannerCandidate(scannerId = 1, name = "HSLT_a844", model = "Dive Computer", serial = "CA:4C:A1:81:A8:44")
        val sled = ScannerCandidate(scannerId = 10, name = "RFD40+_23087520101428", model = "RFD40", serial = "48:A4:93:BD:15:DB")
        assertEquals(sled, chooseScanner(listOf(stranger, sled), target))
    }

    @Test fun chooseScannerMatchesDespiteColonAndCaseDifferences() {
        val target = SledIdentity(name = null, address = "48:A4:93:BD:15:DB", serial = null)
        val stranger = ScannerCandidate(scannerId = 1, name = "HSLT_a844", model = null, serial = "CA:4C:A1:81:A8:44")
        // Same address as target, but unpunctuated and lowercase — must
        // still match after normalizing both sides.
        val sled = ScannerCandidate(scannerId = 10, name = "RFD40+", model = "RFD40", serial = "48a493bd15db")
        assertEquals(sled, chooseScanner(listOf(stranger, sled), target))
    }

    @Test fun chooseScannerMatchesBySerialWhenAddressDoesNotMatchAnything() {
        val target = SledIdentity(name = null, address = "00:00:00:00:00:00", serial = "23087520101428")
        val stranger = ScannerCandidate(scannerId = 1, name = "HSLT_a844", model = null, serial = "CA:4C:A1:81:A8:44")
        val sled = ScannerCandidate(scannerId = 10, name = "RFD40+", model = "RFD40", serial = "23087520101428")
        assertEquals(sled, chooseScanner(listOf(stranger, sled), target))
    }

    @Test fun chooseScannerReturnsNullWhenNothingMatches() {
        val target = SledIdentity(name = "RFD40+_23087520101428", address = "48:A4:93:BD:15:DB", serial = "23087520101428")
        val stranger1 = ScannerCandidate(scannerId = 1, name = "HSLT_a844", model = "Dive Computer", serial = "CA:4C:A1:81:A8:44")
        val stranger2 = ScannerCandidate(scannerId = 2, name = "Meshtastic_6014", model = null, serial = "11:22:33:44:55:66")
        assertNull(chooseScanner(listOf(stranger1, stranger2), target))
    }

    // ── scanCommandInXml ──

    @Test fun scanCommandXmlIsEmpty() {
        // The pull and release trigger opcodes take no parameters and are
        // addressed by the scannerID argument, not the XML body. Pinned so a
        // body added by accident fails a test, not a device.
        assertEquals("", scanCommandInXml())
    }
}
