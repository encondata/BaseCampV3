package com.serversherpa.kiosk.input.rfid

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.BatchRecoveryPlan
import com.serversherpa.kiosk.core.rfid.BondedDevice
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.LayoutWriteOutcome
import com.serversherpa.kiosk.core.rfid.LinkTroubleTracker
import com.serversherpa.kiosk.core.rfid.PerformOutcome
import com.serversherpa.kiosk.core.rfid.Precheck
import com.serversherpa.kiosk.core.rfid.PushOutcome
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TeardownPlan
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.TriggerPull
import com.serversherpa.kiosk.core.rfid.VendorError
import com.serversherpa.kiosk.core.rfid.batchRecoveryPlan
import com.serversherpa.kiosk.core.rfid.decodeKeyLayout
import com.serversherpa.kiosk.core.rfid.powerTable
import com.serversherpa.kiosk.core.rfid.runSettingSteps
import com.serversherpa.kiosk.core.rfid.teardownPlan
import com.zebra.rfid.api3.OperationFailureException
import com.zebra.rfid.api3.RFIDReader
import com.zebra.rfid.api3.RFIDResults
import java.util.logging.Level
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

/**
 * There is no sled under a Robolectric test. The real reader is used only to
 * show that, with nothing paired, nothing throws and the failure is a
 * sentence. Everything else runs [SeamReader], which replaces the vendor
 * seams (pre-check, open, close, link-up) and keeps the real worker,
 * generation and state machine around them. Its open skips connect steps 8
 * to 11, which live in the real `openVendorConnection` body.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ZebraRfidReaderTest {
    private val request = SledConnectRequest(null, SledTriggerLayout.RFID)

    private fun reader(scope: CoroutineScope) =
        ZebraRfidReader(ApplicationProvider.getApplicationContext(), scope)

    /**
     * The adapter with its vendor seams replaced. [onOpen] decides what the
     * open returns (or throws); [onClose] runs inside each close. [events]
     * records "open" and "close" in order; [plans] records each close's plan.
     * [attached] stands for the real link field: the open sets it before
     * [onOpen] runs (so a throw from [onOpen] leaves something for the
     * failed-connect cleanup to close), and only the adapter dropping its
     * references clears it, never the close itself. [lastOpenWasBatchSeen]
     * records, per open, whether the open before it was a batch result.
     */
    private class SeamReader(context: Context, scope: CoroutineScope) : ZebraRfidReader(context, scope) {
        val events = CopyOnWriteArrayList<String>()
        val plans = CopyOnWriteArrayList<TeardownPlan>()
        val lastOpenWasBatchSeen = CopyOnWriteArrayList<Boolean>()

        @Volatile var attached = false
        @Volatile var linkUp = true
        @Volatile var lastOpenGeneration = -1
        @Volatile var precheckResult: Precheck = Precheck.Chosen(
            SledCandidate("RFD4031", "00:11:22:33:44:55"),
            autoChosen = false,
            severalPaired = false,
        )
        @Volatile var onOpen: (SledCandidate, Int) -> VendorOpen =
            { sled, generation -> VendorOpen.Up(SledInfo(generation, sled.name, sled.address)) }
        @Volatile var onClose: () -> Unit = {}
        @Volatile var onLinkUpCheck: () -> Unit = {}
        @Volatile var closeThread: String? = null

        val openCalls: Int get() = events.count { it == "open" }
        val closeCalls: Int get() = events.count { it == "close" }

        override fun precheck(savedAddress: String?): Precheck = precheckResult

        override fun hasOpenVendorConnection(): Boolean = attached

        override fun vendorLinkUp(): Boolean {
            onLinkUpCheck()
            return linkUp
        }

        override fun openVendorConnection(sled: SledCandidate, request: SledConnectRequest, generation: Int): VendorOpen {
            events += "open"
            lastOpenGeneration = generation
            lastOpenWasBatchSeen += lastOpenWasBatch
            attached = true
            return onOpen(sled, generation)
        }

        override fun closeVendorConnection(plan: TeardownPlan) {
            events += "close"
            plans += plan
            closeThread = Thread.currentThread().name
            onClose()
        }

        override fun forgetVendorConnection() {
            attached = false
        }
    }

    private fun seamReader(scope: CoroutineScope) =
        SeamReader(ApplicationProvider.getApplicationContext(), scope)

    /** Waits in real time (the worker is a real thread), at most five seconds. */
    private suspend fun <T> realWait(block: suspend () -> T): T =
        withContext(Dispatchers.Default) { withTimeout(5_000) { block() } }

    private fun CountDownLatch.awaitBriefly(): Boolean = await(5, TimeUnit.SECONDS)

    private fun failedOf(result: Result<Unit>): RfidConnection.Failed {
        val e = result.exceptionOrNull()
        assertTrue("expected a SledConnectException, got $e", e is SledConnectException)
        return (e as SledConnectException).failed
    }

    private val reached = RfidConnection.Failed(SledWords.couldNotReach("RFD4031"), retryable = true, fix = SledFix.CONNECT)

    /**
     * An `OperationFailureException` carrying [result]. Its public
     * constructor asks the vendor's native-backed protocol layer for a
     * description, and that layer is null with no sled (a
     * `NullPointerException`), so the object is allocated without running
     * the constructor and only its result field is set; the vendor text and
     * status stay null.
     */
    private fun operationFailure(result: RFIDResults): OperationFailureException {
        val unsafeClass = Class.forName("sun.misc.Unsafe")
        val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        val e = unsafeClass.getMethod("allocateInstance", Class::class.java)
            .invoke(unsafe, OperationFailureException::class.java) as OperationFailureException
        OperationFailureException::class.java.declaredFields.single { it.type == RFIDResults::class.java }
            .apply { isAccessible = true }
            .set(e, result)
        return e
    }

    @Test fun startsDisconnected() = runTest {
        assertTrue(reader(backgroundScope).connection.value is RfidConnection.Disconnected)
    }

    @Test fun connectingWithNoReaderPresentFailsWithSomethingReadable() = runTest {
        // Under Robolectric the pre-check fails first: Bluetooth is off or
        // Nearby devices is not granted, so no vendor object is built.
        val r = reader(backgroundScope)
        val result = r.connect(request)
        assertTrue("connect must not throw, it must report", result.isFailure)
        val state = r.connection.value
        assertTrue("expected a Failed state, got $state", state is RfidConnection.Failed)
        state as RfidConnection.Failed
        assertTrue(
            "the reason must be a pre-check sentence, got: ${state.reason}",
            state.reason in setOf(SledWords.BLUETOOTH_OFF, SledWords.PERMISSION_MISSING),
        )
        assertFalse(state.retryable)
        assertEquals(state, failedOf(result))
    }

    @Test fun everyOperationOnADisconnectedReaderReportsRatherThanThrows() = runTest {
        val r = reader(backgroundScope)
        val results = mapOf(
            "startInventory" to r.startInventory(),
            "stopInventory" to r.stopInventory(),
            "apply" to r.apply(DEFAULT_RFID_SETTINGS),
            "regions" to r.regions(),
            "setRegion" to r.setRegion("US", hopping = null),
            "setTriggerLayout" to r.setTriggerLayout(SledTriggerLayout.BARCODE),
            "softScan" to r.softScan(pull = true),
            "retryScanner" to r.retryScanner(),
        )
        for ((member, result) in results) {
            assertTrue("$member must report SledNotConnected, got ${result.exceptionOrNull()}", result.exceptionOrNull() is SledNotConnected)
        }
        r.requestBattery()   // returns, makes no vendor call
        assertTrue(r.pairedSleds().isEmpty())
        r.disconnect()   // must not throw
        assertEquals(RfidConnection.Disconnected, r.connection.value)
    }

    @After fun vendorLoggingOff() {
        reader(CoroutineScope(Dispatchers.Unconfined)).setVendorLogging(false)
    }

    // ── the settings push ──

    /** Records every [RadioSettingsOps] call by name; [failing] names a call that throws. */
    private class RecordingRadio(private val failing: String? = null) : RadioSettingsOps {
        val calls = mutableListOf<String>()
        val powerIndexes = mutableListOf<Int>()

        private fun call(name: String) {
            calls += name
            if (name == failing) throw IllegalStateException("simulated refusal of $name")
        }

        override fun beeper(level: SledBeeper) = call("beeper")
        override fun powerIndex(index: Int) {
            powerIndexes += index
            call("powerIndex")
        }
        override fun session(session: RfidSession) = call("session")
        override fun tagPopulation(n: Int) = call("tagPopulation")
        override fun uniqueReport(on: Boolean) = call("uniqueReport")
        override fun dpo(on: Boolean) = call("dpo")
    }

    @Test fun settingStepsAreLabeledWithTheRowLabelsInOrder() {
        val radio = RecordingRadio()
        val steps = settingSteps(DEFAULT_RFID_SETTINGS, table = null, ops = radio)

        assertEquals(
            listOf(
                SledWords.ROW_SLED_BEEPER,
                SledWords.ROW_TRANSMIT_POWER,
                SledWords.ROW_SESSION,
                SledWords.ROW_TAG_POPULATION,
                SledWords.ROW_UNIQUE,
                SledWords.ROW_DPO,
            ),
            steps.map { it.label },
        )
        steps.forEach { it.run() }
        assertEquals(
            "one call per step, in order, and no LED step",
            listOf("beeper", "powerIndex", "session", "tagPopulation", "uniqueReport", "dpo"),
            radio.calls,
        )
    }

    @Test fun powerIsSentAsAnIndexIntoTheSledsTable() {
        val settings = RfidSettings(powerDbm = 27)
        val withTable = RecordingRadio()
        settingSteps(settings, powerTable(IntArray(201) { 100 + it }), withTable).forEach { it.run() }
        assertEquals("27 dBm is 270 tenths, entry 170 of a 100..300 table", listOf(170), withTable.powerIndexes)

        val noTable = RecordingRadio()
        settingSteps(settings, table = null, ops = noTable).forEach { it.run() }
        assertEquals("with no table, today's tenths value", listOf(270), noTable.powerIndexes)
    }

    @Test fun aRefusedSettingDoesNotStopThePush() {
        val radio = RecordingRadio(failing = "beeper")

        val outcome = runSettingSteps(settingSteps(DEFAULT_RFID_SETTINGS, null, radio), ::vendorErrorOf)

        assertEquals(PushOutcome.Refused(listOf(SledWords.ROW_SLED_BEEPER), othersApplied = true), outcome)
        assertEquals(listOf("beeper", "powerIndex", "session", "tagPopulation", "uniqueReport", "dpo"), radio.calls)
    }

    // ── paired sleds and vendor logging ──

    private class BondedReader(context: Context, scope: CoroutineScope, private val bonded: List<BondedDevice>) :
        ZebraRfidReader(context, scope) {
        override fun bondedDevices(): List<BondedDevice> = bonded
    }

    @Test fun pairedSledsListsOnlySledsFromTheBondedList() = runTest {
        val r = BondedReader(
            ApplicationProvider.getApplicationContext(),
            backgroundScope,
            listOf(
                BondedDevice("RFD4031", "00:11:22:33:44:55"),
                BondedDevice("ZD421", "66:77:88:99:AA:BB"),
                BondedDevice("RFD9090", "CC:DD:EE:FF:00:11"),
            ),
        )

        assertEquals(
            listOf(SledCandidate("RFD4031", "00:11:22:33:44:55"), SledCandidate("RFD9090", "CC:DD:EE:FF:00:11")),
            r.pairedSleds(),
        )
    }

    @Test fun pairedSledsIsEmptyWithNothingGranted() = runTest {
        assertTrue(reader(backgroundScope).pairedSleds().isEmpty())
    }

    @Test fun theLoggingSwitchGatesTheVendorLog() = runTest {
        val r = reader(backgroundScope)
        assertFalse(r.vendorLogging.value)

        r.setVendorLogging(true)
        ShadowLog.clear()
        RFIDReader.LOGGER.log(Level.INFO, "probe")
        assertTrue("on: the vendor's line appears", ShadowLog.getLogsForTag("IRFIDinfo").any { it.msg == "probe" })
        assertTrue(r.vendorLogging.value)

        r.setVendorLogging(false)
        ShadowLog.clear()
        RFIDReader.LOGGER.log(Level.INFO, "probe")
        assertTrue("off: nothing", ShadowLog.getLogsForTag("IRFIDinfo").isEmpty())
        assertFalse(r.vendorLogging.value)
    }

    // ── connect steps 8 to 11 ──

    /** Records every [SetupOps] call; [layoutOutcome] and [batteryError] decide what those return. */
    private class RecordingSetup(
        private val layoutOutcome: LayoutWriteOutcome = LayoutWriteOutcome.Accepted(decodeKeyLayout(4)),
        private val batteryError: VendorError? = null,
    ) : SetupOps {
        val calls = mutableListOf<String>()

        override fun identity(): SledInfo {
            calls += "identity"
            return SledInfo(1, "RFD4031")
        }

        override fun dump() {
            calls += "dump"
        }

        override fun writeLayout(layout: SledTriggerLayout): LayoutWriteOutcome {
            calls += "layout $layout"
            return layoutOutcome
        }

        override fun battery(): VendorError? {
            calls += "battery"
            return batteryError
        }
    }

    private val timeout = VendorError("RFID_API_COMMAND_TIMEOUT", null)

    @Test fun bestStepsRunInOrderAndSkipPastTheDeadline() {
        val all = RecordingSetup()
        val split = SledConnectRequest(null, SledTriggerLayout.SPLIT)

        val noneSkipped = runBestSteps(split, { 0L }, all, LinkTroubleTracker(), "RFD4031")

        assertEquals(listOf("identity", "dump", "layout SPLIT", "battery"), all.calls)
        assertTrue(noneSkipped.isEmpty())

        val late = RecordingSetup()
        val clock = ArrayDeque(listOf(0L, 7_999L, 8_000L, 8_000L))
        val skipped = runBestSteps(split, { clock.removeFirst() }, late, LinkTroubleTracker(), "RFD4031")

        assertEquals("a step not started within 8 s is skipped", listOf("identity", "dump"), late.calls)
        assertEquals(listOf(ZebraRfidReader.STEP_LAYOUT, ZebraRfidReader.STEP_BATTERY), skipped)
    }

    @Test fun theConnectAsksForBatteryOnce() {
        val ops = RecordingSetup()
        runBestSteps(request, { 0L }, ops, LinkTroubleTracker(), "RFD4031")
        assertEquals(1, ops.calls.count { it == "battery" })
    }

    @Test fun twoBatteryReadTimeoutsInARowMarkTheLinkLost() {
        val ops = RecordingSetup(batteryError = timeout)
        val links = LinkTroubleTracker()

        assertFalse(batteryBlock(ops, links))
        assertTrue(batteryBlock(ops, links))
    }

    @Test fun linkTroubleInABestStepFailsTheConnectRetryably() {
        for (ops in listOf(RecordingSetup(layoutOutcome = LayoutWriteOutcome.LinkTrouble), RecordingSetup(batteryError = timeout))) {
            try {
                runBestSteps(request, { 0L }, ops, LinkTroubleTracker(), "RFD4031")
                fail("link trouble in a best step must fail the connect")
            } catch (e: SledConnectException) {
                assertEquals(reached, e.failed)
            }
        }
        val layoutTrouble = RecordingSetup(layoutOutcome = LayoutWriteOutcome.LinkTrouble)
        try {
            runBestSteps(request, { 0L }, layoutTrouble, LinkTroubleTracker(), "RFD4031")
        } catch (e: SledConnectException) {
            // expected
        }
        assertEquals("nothing runs after the step that lost the link", listOf("identity", "dump", "layout RFID"), layoutTrouble.calls)
    }

    @Test fun aRefusedBestStepIsLoggedAndSetupGoesOn() {
        val ops = object : SetupOps {
            val calls = mutableListOf<String>()
            override fun identity(): SledInfo = throw IllegalStateException("no capabilities").also { calls += "identity" }
            override fun dump() {
                calls += "dump"
            }
            override fun writeLayout(layout: SledTriggerLayout): LayoutWriteOutcome = LayoutWriteOutcome.CheckFailed.also { calls += "layout" }
            override fun battery(): VendorError? = null.also { calls += "battery" }
        }

        assertTrue(runBestSteps(request, { 0L }, ops, LinkTroubleTracker(), "RFD4031").isEmpty())
        assertEquals(listOf("identity", "dump", "layout", "battery"), ops.calls)
    }

    // ── inventory ──

    private class RecordingInventory(private val purged: Boolean = true, private val error: VendorError? = null) : InventoryOps {
        val calls = mutableListOf<String>()

        override fun purge(): Boolean {
            calls += "purge"
            return purged
        }

        override fun perform(): VendorError? {
            calls += "perform"
            return error
        }
    }

    @Test fun uniqueReportingPurgesBeforeEachStart() {
        val unique = RecordingInventory()
        assertEquals(PerformOutcome.STARTED, runStart(uniqueReport = true, ops = unique))
        assertEquals(listOf("purge", "perform"), unique.calls)

        val plain = RecordingInventory()
        assertEquals(PerformOutcome.STARTED, runStart(uniqueReport = false, ops = plain))
        assertEquals(listOf("perform"), plain.calls)

        val purgeFailed = RecordingInventory(purged = false)
        assertEquals("a failed purge is logged, and the start goes on", PerformOutcome.STARTED, runStart(true, purgeFailed))
        assertEquals(PerformOutcome.CHARGING, runStart(false, RecordingInventory(error = VendorError("RFID_CHARGING_COMMAND_NOT_ALLOWED", null))))
    }

    @Test fun anUnsolicitedStopIsEmittedOnlyWhileAnInventoryRunsAndOnlyForTheCurrentGeneration() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)
        val stops = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { r.unsolicitedStops.toList(stops) }
        val g = r.currentGeneration

        r.onStopEvent(g)
        runCurrent()
        assertTrue("nothing was running", stops.isEmpty())

        r.onStartEvent(g - 1)
        r.onStopEvent(g)
        runCurrent()
        assertTrue("a start event from an old generation runs nothing", stops.isEmpty())

        r.onStartEvent(g)
        r.onStopEvent(g - 1)
        runCurrent()
        assertTrue("a stop event from an old generation is dropped", stops.isEmpty())

        r.onStopEvent(g)
        runCurrent()
        assertEquals(1, stops.size)
        assertFalse("the reason is for the log; no vendor name in it either way", stops.single().contains("RFID_"))

        r.onStopEvent(g)
        runCurrent()
        assertEquals("the sweep already ended", 1, stops.size)
    }

    // ── has-scanner ──

    @Test fun hasScannerIsKnownFalseOnlyForTheModelsWithoutAnImager() {
        assertEquals(true, hasScannerOf("PREMIUM PLUS(WiFi & SCAN)"))
        assertEquals(false, hasScannerOf("PREMIUM (WiFi)"))
        assertEquals(false, hasScannerOf("STANDARD"))
        assertNull("a renamed sled is unknown, not known to lack one", hasScannerOf("RFDXXXX"))
        assertNull(hasScannerOf("RFD8500"))
        assertNull(hasScannerOf(null))
    }

    // ── the pre-check ──

    @Test fun aPrecheckFailureNeverReachesTheVendorSeam() = runTest {
        val r = seamReader(backgroundScope)
        val refused = RfidConnection.Failed(SledWords.BLUETOOTH_OFF, retryable = false, fix = SledFix.TURN_ON_BLUETOOTH)
        r.precheckResult = Precheck.Refused(refused)

        val result = r.connect(request)

        assertEquals(refused, failedOf(result))
        assertEquals(refused, r.connection.value)
        assertEquals("no vendor object may be built", 0, r.openCalls)
        assertNull(r.info.value)
    }

    @Test fun infoCarriesTheGenerationAndAutoChosenFromThePrecheck() = runTest {
        val r = seamReader(backgroundScope)
        r.precheckResult = Precheck.Chosen(SledCandidate("RFD4031", "00:11:22:33:44:55"), autoChosen = true, severalPaired = false)

        assertTrue(r.connect(request).isSuccess)

        val info = r.info.value
        assertNotNull(info)
        assertEquals(r.currentGeneration, info!!.generation)
        assertTrue(info.autoChosen)
        assertEquals("00:11:22:33:44:55", info.address)
        assertEquals(RfidConnection.Connected("RFD4031", null), r.connection.value)
    }

    // ── cancellation and the stale link (rows 3 and 19) ──

    @Test fun aConnectCancelledPartwayLeavesADefiniteStateAndNoAttachedReader() = runTest {
        // The caller stops waiting while the vendor connect is still running.
        // The block is never interrupted: it finishes, and the state it ends
        // in is definite. Nothing tears the new link down behind its back.
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val r = seamReader(backgroundScope)
        r.onOpen = { sled, generation ->
            entered.countDown()
            release.awaitBriefly()
            VendorOpen.Up(SledInfo(generation, sled.name, sled.address))
        }

        val caller = launch(Dispatchers.Default) { r.connect(request) }
        assertTrue(withContext(Dispatchers.IO) { entered.awaitBriefly() })
        caller.cancelAndJoin()
        assertTrue(caller.isCancelled)
        assertEquals(RfidConnection.Connecting, r.connection.value)

        release.countDown()
        val state = realWait { r.connection.first { it !is RfidConnection.Connecting } }

        assertEquals(RfidConnection.Connected("RFD4031", null), state)
        assertEquals("a finished connect must not be torn down", 0, r.closeCalls)
        assertTrue(r.attached)
    }

    @Test fun aConnectFollowingADisconnectionEventTearsDownThePreviousReaderFirst() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)

        r.onLinkLost(r.currentGeneration)
        assertTrue(r.connection.value is RfidConnection.Failed)
        assertTrue("the disconnect event makes no vendor call, so the link is still attached", r.attached)

        assertTrue(r.connect(request).isSuccess)

        assertEquals(listOf("open", "close", "open"), r.events.toList())
        assertEquals(
            "a link known to be lost gets no stop and no batch-mode step",
            listOf(teardownPlan(linkUp = false, wroteLayout = false)),
            r.plans.toList(),
        )
        assertTrue(r.attached)
    }

    @Test fun aFailedAttemptAfterTheCallerLeftCleansUpOnce() = runTest {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val r = seamReader(backgroundScope)
        r.onOpen = { _, _ ->
            entered.countDown()
            release.awaitBriefly()
            throw IllegalStateException("simulated partway failure")
        }
        r.onClose = { closed.countDown() }

        val caller = launch(Dispatchers.Default) { r.connect(request) }
        assertTrue(withContext(Dispatchers.IO) { entered.awaitBriefly() })
        caller.cancelAndJoin()
        release.countDown()

        assertTrue("cleanup must run", withContext(Dispatchers.IO) { closed.awaitBriefly() })
        val state = realWait { r.connection.first { it !is RfidConnection.Connecting } }
        assertEquals(
            RfidConnection.Failed(SledWords.couldNotReach("RFD4031"), retryable = false, fix = SledFix.CONNECT),
            state,
        )
        assertNotEquals("cleanup runs on its own thread", ZebraRfidReader.WORKER_THREAD_NAME, r.closeThread)

        r.disconnect()   // the next block joins the cleanup and finds nothing left to close
        assertEquals(1, r.closeCalls)
        assertEquals(RfidConnection.Disconnected, r.connection.value)
    }

    @Test fun aCleanupThatOutlivesItsBoundIsAbandonedAndNeverRunTwice() = runTest {
        // Real time: the bound is the companion's 5 s.
        val closeEntered = CountDownLatch(1)
        val releaseClose = CountDownLatch(1)
        val r = seamReader(backgroundScope)
        r.onOpen = { _, _ -> throw IllegalStateException("simulated partway failure") }
        r.onClose = {
            closeEntered.countDown()
            releaseClose.await(3 * ZebraRfidReader.CLEANUP_BOUND_MS, TimeUnit.MILLISECONDS)
        }
        try {
            assertTrue(r.connect(request).isFailure)
            assertTrue("the cleanup's close has started", withContext(Dispatchers.IO) { closeEntered.awaitBriefly() })
            r.onOpen = { sled, generation -> VendorOpen.Up(SledInfo(generation, sled.name, sled.address)) }

            val startedNs = System.nanoTime()
            val next = withContext(Dispatchers.Default) {
                withTimeout(2 * ZebraRfidReader.CLEANUP_BOUND_MS) { r.connect(request) }
            }
            val waitedMs = (System.nanoTime() - startedNs) / 1_000_000L

            assertTrue("the next block goes on without the stuck cleanup", next.isSuccess)
            assertTrue("it waited out the bound first ($waitedMs ms)", waitedMs >= ZebraRfidReader.CLEANUP_BOUND_MS - 100)
            assertEquals(RfidConnection.Connected("RFD4031", null), r.connection.value)
            assertEquals("the abandoned cleanup's link is dropped, not closed again", 1, r.closeCalls)
            assertEquals(2, r.openCalls)
            assertTrue("the new link is untouched", r.attached)
        } finally {
            releaseClose.countDown()
        }
    }

    @Test fun aConnectStaleWhenItsBlockStartsMakesNoVendorCall() = runTest {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val r = seamReader(backgroundScope)
        r.onOpen = { sled, generation ->
            entered.countDown()
            release.awaitBriefly()
            VendorOpen.Up(SledInfo(generation, sled.name, sled.address))
        }
        val held = async(Dispatchers.Default) { r.connect(request) }
        assertTrue(withContext(Dispatchers.IO) { entered.awaitBriefly() })

        // Both are posted now, behind the held block: a connect, then a disconnect.
        val queued = async(start = CoroutineStart.UNDISPATCHED) { r.connect(request) }
        val disconnecting = async(start = CoroutineStart.UNDISPATCHED) { r.disconnect() }
        assertEquals(RfidConnection.Disconnected, r.connection.value)
        release.countDown()

        assertTrue("the queued connect is stale when it starts", realWait { queued.await() }.exceptionOrNull() is SledNotConnected)
        assertTrue("the held connect came up after newer calls", realWait { held.await() }.exceptionOrNull() is SledNotConnected)
        realWait { disconnecting.await() }
        assertEquals("the stale connect makes no vendor call", 1, r.openCalls)
        assertEquals(RfidConnection.Disconnected, r.connection.value)
        assertNull(r.info.value)
        assertEquals("the disconnect tears the held connect's link down", 1, r.closeCalls)
    }

    @Test fun aFailureAfterANewerCallPublishesNothingAndReturnsNotConnected() = runTest {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val r = seamReader(backgroundScope)
        r.onOpen = { _, _ ->
            entered.countDown()
            release.awaitBriefly()
            throw IllegalStateException("simulated partway failure")
        }
        val held = async(Dispatchers.Default) { r.connect(request) }
        assertTrue(withContext(Dispatchers.IO) { entered.awaitBriefly() })
        val disconnecting = async(start = CoroutineStart.UNDISPATCHED) { r.disconnect() }
        assertEquals(RfidConnection.Disconnected, r.connection.value)

        release.countDown()
        val result = realWait { held.await() }

        assertTrue(
            "a failure that was never published is not a connect failure, got ${result.exceptionOrNull()}",
            result.exceptionOrNull() is SledNotConnected,
        )
        realWait { disconnecting.await() }
        assertEquals(RfidConnection.Disconnected, r.connection.value)
        assertEquals("the failed attempt's cleanup closes it once", 1, r.closeCalls)
    }

    // ── loss detection ──

    @Test fun aLossRecordedDuringSetupFailsTheConnectRetryably() = runTest {
        val r = seamReader(backgroundScope)
        r.onOpen = { sled, generation ->
            r.onLinkLost(generation)
            VendorOpen.Up(SledInfo(generation, sled.name, sled.address))
        }

        val result = r.connect(request)

        assertEquals(reached, failedOf(result))
        assertEquals(reached, r.connection.value)
        assertNull("info is never set for a connect that did not come up", r.info.value)
        r.disconnect()   // joins the cleanup
        assertEquals(listOf(teardownPlan(linkUp = false, wroteLayout = false)), r.plans.toList())
    }

    @Test fun aLossBetweenTheLastCheckAndThePublishStillFailsTheConnect() = runTest {
        // The disconnect event lands after setup's last loss check, while the
        // vendor is asked whether the link is up, just before the publish.
        // The loss is checked again under the state lock, so the connect
        // fails retryably instead of showing a dead link as up.
        for (needsRegion in listOf(false, true)) {
            val r = seamReader(backgroundScope)
            if (needsRegion) {
                r.onOpen = { sled, generation -> VendorOpen.NoRegion(SledInfo(generation, sled.name, sled.address)) }
            }
            var fired = false
            r.onLinkUpCheck = {
                if (!fired) {
                    fired = true
                    r.onLinkLost(r.currentGeneration)
                }
            }

            val result = r.connect(request)

            assertEquals("needsRegion = $needsRegion", reached, failedOf(result))
            assertEquals(reached, r.connection.value)
            assertNull("info is never set for a connect that did not come up", r.info.value)
            r.disconnect()   // joins the cleanup
            assertEquals(listOf(teardownPlan(linkUp = false, wroteLayout = false)), r.plans.toList())
            assertEquals(1, r.closeCalls)
        }
    }

    @Test fun aStaleGenerationLossChangesNothing() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)

        r.onLinkLost(r.currentGeneration - 1)

        assertEquals(RfidConnection.Connected("RFD4031", null), r.connection.value)
        assertNotNull(r.info.value)
        r.disconnect()
        assertEquals(
            "the current link is still known to be up",
            listOf(teardownPlan(linkUp = true, wroteLayout = false)),
            r.plans.toList(),
        )
    }

    @Test fun aLossDuringTeardownEndsDisconnected() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)
        r.onClose = { r.onLinkLost(r.lastOpenGeneration) }

        r.disconnect()

        assertEquals(RfidConnection.Disconnected, r.connection.value)
        assertEquals(1, r.closeCalls)
    }

    @Test fun linkLossWritesFailedRetryableAndKeepsInfo() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)
        val info = r.info.value
        assertNotNull(info)

        r.onLinkLost(r.currentGeneration)

        assertEquals(RfidConnection.Failed(SledWords.couldNotReach("RFD4031"), retryable = true), r.connection.value)
        assertEquals("a drop keeps info, so the controller can tell it from a connect that never came up", info, r.info.value)
    }

    @Test fun aLinkThatIsNotUpAfterSetupFailsRetryably() = runTest {
        val r = seamReader(backgroundScope)
        r.linkUp = false

        val result = r.connect(request)

        assertEquals(reached, failedOf(result))
        assertEquals(reached, r.connection.value)
        assertNull(r.info.value)
    }

    // ── disconnect and the start of each attempt ──

    @Test fun disconnectPublishesDisconnectedFirstAndIsIdempotent() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)
        var stateAtClose: RfidConnection? = null
        var infoAtClose: SledInfo? = SledInfo(-1, "unset")
        r.onClose = {
            stateAtClose = r.connection.value
            infoAtClose = r.info.value
        }
        val before = r.currentGeneration

        r.disconnect()

        assertEquals(RfidConnection.Disconnected, stateAtClose)
        assertNull(infoAtClose)
        assertTrue("disconnect starts a new generation", r.currentGeneration > before)
        assertEquals(listOf(teardownPlan(linkUp = true, wroteLayout = false)), r.plans.toList())

        r.disconnect()

        assertEquals("nothing is left to tear down", 1, r.closeCalls)
        assertEquals(RfidConnection.Disconnected, r.connection.value)
        assertNull(r.info.value)
    }

    @Test fun disconnectFromAFailedStateEndsDisconnected() = runTest {
        val r = seamReader(backgroundScope)
        r.precheckResult = Precheck.Refused(RfidConnection.Failed(SledWords.NO_SLED_PAIRED, fix = SledFix.BLUETOOTH_SETTINGS))
        assertTrue(r.connect(request).isFailure)

        r.disconnect()

        assertEquals(RfidConnection.Disconnected, r.connection.value)
        assertEquals(0, r.closeCalls)
    }

    @Test fun infoIsClearedAtTheStartOfEachAttempt() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)
        val first = r.info.value
        assertNotNull(first)
        var infoAtOpen: SledInfo? = SledInfo(-1, "unset")
        var stateAtOpen: RfidConnection? = null
        r.onOpen = { sled, generation ->
            infoAtOpen = r.info.value
            stateAtOpen = r.connection.value
            VendorOpen.Up(SledInfo(generation, sled.name, sled.address))
        }

        assertTrue(r.connect(request).isSuccess)

        assertNull(infoAtOpen)
        assertEquals(RfidConnection.Connecting, stateAtOpen)
        assertTrue(r.info.value!!.generation > first!!.generation)
    }

    // ── NeedsRegion ──

    @Test fun needsRegionPublishesInfoFirst() = runTest {
        val r = seamReader(backgroundScope)
        r.onOpen = { sled, generation -> VendorOpen.NoRegion(SledInfo(generation, sled.name, sled.address)) }
        val infoWhenSeen = CopyOnWriteArrayList<SledInfo?>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            r.connection.collect { if (it is RfidConnection.NeedsRegion) infoWhenSeen += r.info.value }
        }

        val result = r.connect(request)
        runCurrent()

        assertTrue("NeedsRegion is a link that is up", result.isSuccess)
        assertEquals(RfidConnection.NeedsRegion("RFD4031"), r.connection.value)
        assertEquals(1, infoWhenSeen.size)
        assertEquals("RFD4031", infoWhenSeen.single()?.name)
    }

    @Test fun regionNotConfiguredGetsItsOwnActionableSentence() {
        val sentence = SledWords.noRegion("RFD4031")
        assertTrue("must tell the operator where to fix it", sentence.contains("Settings › Admin"))
        assertFalse("no vendor result name on screen", sentence.contains("RFID_"))
        assertEquals(sentence, com.serversherpa.kiosk.core.rfid.connectionLine(RfidConnection.NeedsRegion("RFD4031")))
    }

    // ── failures from the vendor seam ──

    @Test fun aTriggerEventSetupFailurePublishesTheTriggerSentenceAndAConnectFix() = runTest {
        val r = seamReader(backgroundScope)
        val stepFour = RfidConnection.Failed(SledWords.TRIGGER_NOT_SET_UP, retryable = false, fix = SledFix.CONNECT)
        r.onOpen = { _, _ -> throw SledConnectException(stepFour) }

        val result = r.connect(request)

        val failed = failedOf(result)
        assertEquals(stepFour, failed)
        assertEquals(stepFour, r.connection.value)
        assertEquals(SledWords.TRIGGER_NOT_SET_UP, failed.reason)
        assertEquals(SledFix.CONNECT, failed.fix)
    }

    @Test fun aVendorExceptionFromTheSeamMapsThroughConnectFailure() = runTest {
        ShadowLog.clear()
        val r = seamReader(backgroundScope)
        val openError = operationFailure(RFIDResults.RFID_COMM_OPEN_ERROR)
        r.onOpen = { _, _ -> throw openError }

        val result = r.connect(request)

        val failed = failedOf(result)
        assertTrue("an open error is worth another try", failed.retryable)
        assertEquals(SledWords.couldNotReach("RFD4031"), failed.reason)
        assertEquals(SledFix.CONNECT, failed.fix)
        assertEquals(failed, r.connection.value)
        assertTrue(
            "the result name goes to the log",
            ShadowLog.getLogsForTag(ZebraRfidReader.TAG).any { it.msg.contains("RFID_COMM_OPEN_ERROR") },
        )
        assertFalse("and never into the sentence", failed.reason.contains("RFID_"))
    }

    @Test fun aClassLoadingErrorFromTheSeamIsNotRetryable() = runTest {
        val r = seamReader(backgroundScope)
        r.onOpen = { _, _ -> throw NoClassDefFoundError("com/zebra/Missing") }

        val failed = failedOf(r.connect(request))

        assertEquals(RfidConnection.Failed(SledWords.CLASS_LOADING, retryable = false, fix = null), failed)
    }

    @Test fun vendorErrorOfReadsTheResultNameAndTheVendorText() {
        val error = vendorErrorOf(operationFailure(RFIDResults.RFID_API_COMMAND_TIMEOUT))
        assertEquals("RFID_API_COMMAND_TIMEOUT", error?.resultName)
        assertFalse(error!!.invalidUsage)
        val usage = vendorErrorOf(com.zebra.rfid.api3.InvalidUsageException("setX", "ERROR_PARAMETER_NULL"))
        assertTrue(usage!!.invalidUsage)
        assertNull(vendorErrorOf(IllegalStateException("not a vendor error")))
    }

    // ── batch mode (rows 9 and 9b) ──

    @Test fun theFirstBatchClearIsRetryableAndTheNextConnectCarriesTheNote() = runTest {
        for (purged in listOf(true, false)) {
            val r = seamReader(backgroundScope)
            var opens = 0
            r.onOpen = { sled, generation ->
                opens++
                if (opens == 1) VendorOpen.BatchCleared(purged) else VendorOpen.Up(SledInfo(generation, sled.name, sled.address))
            }

            val first = r.connect(request)

            val failed = failedOf(first)
            assertEquals(RfidConnection.Failed(SledWords.BATCH_CLEARED_RETRYING, retryable = true), failed)
            assertEquals(failed, r.connection.value)
            assertNull(r.connectNote.value)

            assertTrue(r.connect(request).isSuccess)
            assertEquals(
                if (purged) SledWords.BATCH_CLEARED_NOTE else SledWords.BATCH_NOT_CLEARED_NOTE,
                r.connectNote.value,
            )
            assertEquals(
                "the batch recovery's close is the cleanup, with no stop or save of its own",
                teardownPlan(linkUp = false, wroteLayout = false),
                r.plans.first(),
            )
            assertFalse(r.batchRecovery.value)

            assertTrue(r.connect(request).isSuccess)
            assertNull("the note belongs to one connect only", r.connectNote.value)
        }
    }

    @Test fun batchModeUnrecoverableCarriesTheHonestFinalMessage() {
        val message = BatchModeUnrecoverableException().message
        assertEquals(SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE, message)
        assertTrue(
            "must name the actual remedy, not just say it failed",
            message!!.contains("123RFID Mobile"),
        )
        assertTrue(
            "must say this should be a one-time fix, not a routine step to expect again",
            message.contains("one-time"),
        )
        assertTrue(
            "must say the app now prevents the sled from returning to this state on its own",
            message.contains("should not return to this state"),
        )
        assertTrue(message.endsWith("."))
    }

    @Test fun aBatchModeRecoveryThatExhaustsAllThreeAvenuesReportsTheFinalMessageRatherThanCrashingOrLooping() = runTest {
        // The name is kept from the earlier three-avenue recovery. Today there
        // is one recovery per batch result: the first clears the batch and
        // fails retryably; a second batch result in a row is the end state,
        // not retryable, with the honest message (ruling 28).
        val r = seamReader(backgroundScope)
        r.onOpen = { _, _ -> VendorOpen.BatchCleared(purged = true) }

        val first = r.connect(request)
        assertEquals(RfidConnection.Failed(SledWords.BATCH_CLEARED_RETRYING, retryable = true), failedOf(first))

        val second = r.connect(request)
        assertTrue("connect must not throw, it must report", second.isFailure)
        val e = second.exceptionOrNull() as SledConnectException
        assertTrue(
            "the end state carries BatchModeUnrecoverableException as its cause",
            e.cause is BatchModeUnrecoverableException,
        )
        assertEquals(RfidConnection.Failed(SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE), e.failed)
        assertFalse(e.failed.retryable)

        val state = r.connection.value
        assertTrue("expected a Failed state, got $state", state is RfidConnection.Failed)
        assertEquals(SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE, (state as RfidConnection.Failed).reason)
        assertEquals(2, r.openCalls)
    }

    @Test fun aSecondBatchResultInARowGetsOnlyAStopAndKeepsTheRecoverysNote() = runTest {
        // Ruling 28, one recovery then stop. Each open learns whether the open
        // before it was a batch result (lastOpenWasBatch), and
        // batchRecoveryPlan turns that into the steps it runs: the whole
        // recovery the first time, only a stop after that. A stuck sled gets
        // one purge and one save, not one per Connect press.
        val r = seamReader(backgroundScope)
        var opens = 0
        r.onOpen = { sled, generation ->
            opens++
            when (opens) {
                1 -> VendorOpen.BatchCleared(purged = true)
                2, 3 -> VendorOpen.BatchCleared(purged = false)   // a stop-only open purges nothing
                else -> VendorOpen.Up(SledInfo(generation, sled.name, sled.address))
            }
        }
        val unrecoverable = RfidConnection.Failed(SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE)

        assertEquals(RfidConnection.Failed(SledWords.BATCH_CLEARED_RETRYING, retryable = true), failedOf(r.connect(request)))
        assertEquals(unrecoverable, failedOf(r.connect(request)))
        assertEquals("a third batch result is the end state again, with no new recovery", unrecoverable, failedOf(r.connect(request)))
        assertTrue(r.connect(request).isSuccess)
        assertEquals("the note is the one recovery's, which purged", SledWords.BATCH_CLEARED_NOTE, r.connectNote.value)
        assertTrue(r.connect(request).isSuccess)

        assertEquals(listOf(false, true, true, true, false), r.lastOpenWasBatchSeen.toList())
        val full = BatchRecoveryPlan(stop = true, purge = true, disableBatchMode = true, saveConfig = true)
        val stopOnly = BatchRecoveryPlan(stop = true, purge = false, disableBatchMode = false, saveConfig = false)
        assertEquals(
            listOf(full, stopOnly, stopOnly),
            r.lastOpenWasBatchSeen.take(3).map { batchRecoveryPlan(secondInARow = it) },
        )
    }

    // ── tags and trigger pulls ──

    @Test fun tagsAndPullsFromAnOldGenerationAreDropped() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)
        val tags = mutableListOf<String>()
        val pulls = mutableListOf<TriggerPull>()
        val triggers = mutableListOf<TriggerEvent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { r.tags.toList(tags) }
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { r.pulls.toList(pulls) }
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { r.triggers.toList(triggers) }
        val g = r.currentGeneration

        r.onTag(g - 1, "OLD")
        r.onTrigger(g - 1, pressed = true, typeName = null)
        r.onTag(g, "NEW")
        r.onTrigger(g, pressed = true, typeName = null)
        runCurrent()

        assertEquals(listOf("NEW"), tags)
        assertEquals(listOf(TriggerEvent.PRESSED), pulls.map { it.event })
        assertEquals(listOf(TriggerEvent.PRESSED), triggers)
    }

    @Test fun onlyAScanTypeTriggerIsDroppedAndPullsAreStamped() = runTest {
        val r = seamReader(backgroundScope)
        assertTrue(r.connect(request).isSuccess)
        val pulls = mutableListOf<TriggerPull>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { r.pulls.toList(pulls) }
        val g = r.currentGeneration
        val before = System.currentTimeMillis()

        r.onTrigger(g, pressed = true, typeName = "HANDHELD_TRIGGER_SCAN")
        r.onTrigger(g, pressed = true, typeName = "HANDHELD_TRIGGER_RFID")
        r.onTrigger(g, pressed = false, typeName = "HANDHELD_TRIGGER_DUAL")
        r.onTrigger(g, pressed = true, typeName = null)
        runCurrent()
        val after = System.currentTimeMillis()

        assertEquals(
            listOf(TriggerEvent.PRESSED, TriggerEvent.RELEASED, TriggerEvent.PRESSED),
            pulls.map { it.event },
        )
        assertTrue("every pull is stamped on receipt: $pulls", pulls.all { it.atMs != null && it.atMs!! in before..after })
    }

    // ── connect notes ──
    //
    // The note-combining logic is pure, so it is proven here without a
    // real `RFIDReader`: two independently true notes from one connect
    // both survive.

    @Test fun combineConnectNotesAppendsToAnExistingNote() {
        assertEquals("first note. second note.", combineConnectNotes("first note.", "second note."))
    }

    @Test fun combineConnectNotesReturnsJustTheAdditionWhenNothingExistsYet() {
        assertEquals("only note.", combineConnectNotes(null, "only note."))
        assertEquals("only note.", combineConnectNotes("", "only note."))
        assertEquals("only note.", combineConnectNotes("   ", "only note."))
    }
}
