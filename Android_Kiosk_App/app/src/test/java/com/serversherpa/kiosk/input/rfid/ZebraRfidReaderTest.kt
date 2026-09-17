package com.serversherpa.kiosk.input.rfid

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidTriggerPersonality
import com.serversherpa.kiosk.core.rfid.ScannerPluginMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * There is no sled under a Robolectric test, so what is being proved here is
 * the contract the rest of the app leans on: with no reader present, nothing
 * throws, and the failure is a sentence rather than a stack trace.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ZebraRfidReaderTest {
    private fun reader(scope: kotlinx.coroutines.CoroutineScope) =
        ZebraRfidReader(ApplicationProvider.getApplicationContext(), scope)

    @Test fun startsDisconnected() = runTest {
        assertTrue(reader(backgroundScope).connection.value is RfidConnection.Disconnected)
    }

    @Test fun connectingWithNoReaderPresentFailsWithSomethingReadable() = runTest {
        val r = reader(backgroundScope)
        val result = r.connect(RfidTriggerPersonality.RFID, ScannerPluginMode.AUTO)
        assertTrue("connect must not throw, it must report", result.isFailure)
        val state = r.connection.value
        assertTrue("expected a Failed state, got $state", state is RfidConnection.Failed)
        val reason = (state as RfidConnection.Failed).reason
        assertTrue("the reason must be a sentence, got: $reason", reason.endsWith(".") && reason.length > 12)
    }

    @Test fun everyOperationOnADisconnectedReaderReportsRatherThanThrows() = runTest {
        val r = reader(backgroundScope)
        assertTrue(r.startInventory().isFailure)
        assertTrue(r.stopInventory().isFailure)
        assertTrue(r.apply(com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS).isFailure)
        r.disconnect()   // must not throw
    }

    // ── cancellation / stale-reader teardown (findings 1 and 2) ──
    //
    // Real `Readers`/`RFIDReader` objects can't be driven to a connected
    // state under Robolectric — `GetAvailableRFIDReaderList()` never finds a
    // device — so `openVendorConnection()`/`closeVendorConnection()` are
    // `protected open` specifically so a test double can substitute fake
    // vendor plumbing and exercise `connect()`'s surrounding state machine
    // instead. The double never touches `com.zebra.*`.

    /** Tracks "is a vendor connection currently open" with a plain boolean
     *  instead of real `Readers`/`RFIDReader` fields, and counts calls so a
     *  test can assert on ordering. [onOpen] runs after the fake reader is
     *  marked attached — mirroring the real class, where `reader`/`readers`
     *  are assigned before the rest of `openVendorConnection()` runs — so a
     *  test can throw from it to simulate a cancellation landing in that
     *  window. */
    private class FakeVendorZebraRfidReader(
        context: android.content.Context,
        scope: CoroutineScope,
        private val onOpen: () -> Unit = {},
    ) : ZebraRfidReader(context, scope) {
        var openCalls = 0
            private set
        var closeCalls = 0
            private set
        var attached = false
            private set

        override fun hasOpenVendorConnection(): Boolean = attached

        override fun openVendorConnection(triggerPersonality: RfidTriggerPersonality, scannerPluginMode: ScannerPluginMode): String {
            openCalls++
            attached = true
            onOpen()
            return "Fake RFD40"
        }

        override fun closeVendorConnection() {
            closeCalls++
            attached = false
        }
    }

    private fun fakeReader(scope: CoroutineScope, onOpen: () -> Unit = {}) =
        FakeVendorZebraRfidReader(ApplicationProvider.getApplicationContext(), scope, onOpen)

    @Test fun aConnectCancelledPartwayLeavesADefiniteStateAndNoAttachedReader() = runTest {
        // Simulates the 15s RfidController timeout interrupting connect()
        // after the vendor reader is already connected and listening (attached
        // = true) but before openVendorConnection() has returned.
        val r = fakeReader(backgroundScope) { throw CancellationException("simulated timeout") }

        val thrown = runCatching { r.connect(RfidTriggerPersonality.RFID, ScannerPluginMode.AUTO) }.exceptionOrNull()
        assertTrue(
            "connect() must rethrow the cancellation rather than swallow it, got $thrown",
            thrown is CancellationException,
        )

        val state = r.connection.value
        assertTrue(
            "must land in a definite state, not stuck on Connecting — got $state",
            state !is RfidConnection.Connecting,
        )
        assertTrue("expected Failed, got $state", state is RfidConnection.Failed)

        assertFalse("the cancelled connect must not leave a vendor reader attached", r.attached)
        assertEquals("cleanup must actually run, not just clear local state", 1, r.closeCalls)
    }

    @Test fun aConnectFollowingADisconnectionEventTearsDownThePreviousReaderFirst() = runTest {
        val r = fakeReader(backgroundScope)

        val first = r.connect(RfidTriggerPersonality.RFID, ScannerPluginMode.AUTO)
        assertTrue(first.isSuccess)
        assertEquals(1, r.openCalls)
        assertEquals(0, r.closeCalls)

        // A DISCONNECTION_EVENT sets `_connection` to Failed but — per finding
        // 2 — never tears the reader down itself, so the stale reader is still
        // attached here, exactly like the real class after that event.
        assertTrue(r.attached)

        val second = r.connect(RfidTriggerPersonality.RFID, ScannerPluginMode.AUTO)
        assertTrue(second.isSuccess)
        assertEquals(
            "connect() must build a new reader after tearing the old one down",
            2,
            r.openCalls,
        )
        assertEquals(
            "the stale reader must be torn down exactly once before the new one is built",
            1,
            r.closeCalls,
        )
        assertTrue("the new reader is live", r.attached)
    }

    // ── connect-failure message building ──
    //
    // `OperationFailureException`/`InvalidUsageException` can't be
    // meaningfully constructed here — both come from `com.zebra.*`, and
    // building one means supplying a real `RFIDResults`/status-code the
    // vendor SDK itself normally provides, not this app (the 2.0.5.292
    // `.aar` made `OperationFailureException`'s constructor `public` —
    // confirmed via `javap`, where 2.0.2.82 had it package-private — but
    // that alone doesn't give a test anything meaningful to pass it) — so
    // these exercise the pure formatting functions
    // `ZebraRfidReader.kt` pulls the real `readable(Throwable)` logic out
    // into: [operationFailureMessage], [invalidUsageMessage], and
    // [genericMessage] take the already-unpacked `String?` values
    // (`getResults()?.toString()`, `getStatusDescription()`, `getInfo()`,
    // `getVendorMessage()`, `e.message`) rather than the vendor exception
    // types themselves. What is NOT covered by these tests: that `readable`
    // actually calls `getResults()`/`getStatusDescription()`/etc. correctly
    // on a real `OperationFailureException`/`InvalidUsageException`, and
    // that the `Log.w(...)` call fires with the right arguments — neither
    // is exercisable without a constructible vendor exception or a real
    // device.

    @Test fun regionNotConfiguredGetsItsOwnActionableSentence() {
        val message = operationFailureMessage(
            resultsName = "RFID_READER_REGION_NOT_CONFIGURED",
            statusDescription = "some status text that must not win",
            vendorMessage = "some vendor text that must not win",
        )
        assertTrue(message.contains("RFID_READER_REGION_NOT_CONFIGURED"))
        assertTrue("must tell the operator where to fix it", message.contains("Admin tab"))
        assertTrue("must not fall through to the generic detail path", !message.contains("must not win"))
        assertTrue(message.endsWith("."))
    }

    @Test fun operationFailurePrefersResultsAndStatusDescriptionTogether() {
        val message = operationFailureMessage(
            resultsName = "RFID_COMM_NO_CONNECTION",
            statusDescription = "Failed to establish secure connection",
            vendorMessage = "some vendor text that must not win",
        )
        assertEquals(
            "Couldn't connect to the reader (RFID_COMM_NO_CONNECTION: Failed to establish secure connection).",
            message,
        )
    }

    @Test fun operationFailureFallsBackToVendorMessageWhenNoStatusDescription() {
        val message = operationFailureMessage(
            resultsName = "RFID_API_COMMAND_TIMEOUT",
            statusDescription = "   ",
            vendorMessage = "timed out waiting for the radio",
        )
        assertEquals(
            "Couldn't connect to the reader (RFID_API_COMMAND_TIMEOUT: timed out waiting for the radio).",
            message,
        )
    }

    @Test fun operationFailureWithOnlyAResultsNameStillNamesIt() {
        val message = operationFailureMessage(
            resultsName = "RFID_RECONNECT_FAILED",
            statusDescription = null,
            vendorMessage = null,
        )
        assertEquals("Couldn't connect to the reader (RFID_RECONNECT_FAILED).", message)
    }

    @Test fun operationFailureWithOnlyDetailAndNoResultsNameStillReports() {
        val message = operationFailureMessage(
            resultsName = null,
            statusDescription = "radio busy",
            vendorMessage = null,
        )
        assertEquals("Couldn't connect to the reader (radio busy).", message)
    }

    @Test fun operationFailureWithNothingAtAllStillEndsInASentence() {
        val message = operationFailureMessage(resultsName = null, statusDescription = null, vendorMessage = null)
        assertEquals("Couldn't connect to the reader.", message)
    }

    @Test fun invalidUsagePrefersInfoOverVendorMessage() {
        val message = invalidUsageMessage(info = "reader not ready", vendorMessage = "must not win")
        assertEquals("Couldn't connect to the reader (reader not ready).", message)
    }

    @Test fun invalidUsageFallsBackToVendorMessageWhenInfoIsBlank() {
        val message = invalidUsageMessage(info = "  ", vendorMessage = "bad state transition")
        assertEquals("Couldn't connect to the reader (bad state transition).", message)
    }

    @Test fun invalidUsageWithNothingAtAllStillEndsInASentence() {
        val message = invalidUsageMessage(info = null, vendorMessage = null)
        assertEquals("Couldn't connect to the reader.", message)
    }

    @Test fun genericMessageKeepsAnAlreadyReadableSentenceAsIs() {
        val message = genericMessage("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.")
        assertEquals("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.", message)
    }

    @Test fun genericMessageWrapsAShortOrUnpunctuatedRawMessage() {
        assertEquals("Couldn't connect to the reader (bad state).", genericMessage("bad state"))
    }

    @Test fun genericMessageFallsBackWhenThereIsNoMessageAtAll() {
        assertEquals("Couldn't connect to the reader.", genericMessage(null))
        assertEquals("Couldn't connect to the reader.", genericMessage(""))
        assertEquals("Couldn't connect to the reader.", genericMessage("   "))
    }

    // ── batch-mode recovery (second attempt) ──
    //
    // The recovery sequence itself — calling the real `PostConnectReaderUpdate()`/
    // `reconnect()` on a real `RFIDReader` stuck reporting
    // `RFID_BATCHMODE_IN_PROGRESS` — cannot be exercised here: there is no
    // sled under Robolectric, and there is no meaningful way to build a real
    // `OperationFailureException` outside `com.zebra.*` (see the note above). What
    // *can* be proven without hardware: the pure usability decision
    // ([batchModeRecoveryUsable]) the recovery logs feed into, and that a
    // recovery which gives up ([BatchModeUnrecoverableException]) reaches
    // the operator as the exact honest final message rather than a generic
    // failure or a crash — that plumbing is real Kotlin code this test can
    // drive end to end via [FakeVendorZebraRfidReader].

    @Test fun batchModeRecoveryUsableRequiresConnectedAndBothFieldsPresent() {
        assertTrue(batchModeRecoveryUsable(isConnected = true, actionsPresent = true, configPresent = true))
        assertFalse(
            "not connected must never count as usable, even with both fields present",
            batchModeRecoveryUsable(isConnected = false, actionsPresent = true, configPresent = true),
        )
        assertFalse(
            "a null Actions must never count as usable",
            batchModeRecoveryUsable(isConnected = true, actionsPresent = false, configPresent = true),
        )
        assertFalse(
            "a null Config must never count as usable",
            batchModeRecoveryUsable(isConnected = true, actionsPresent = true, configPresent = false),
        )
    }

    @Test fun batchModeUnrecoverableCarriesTheHonestFinalMessage() {
        val message = BatchModeUnrecoverableException().message
        assertEquals(BATCH_MODE_UNRECOVERABLE_MESSAGE, message)
        assertTrue(
            "must name the actual remedy, not just say it failed",
            message!!.contains("123RFID Mobile"),
        )
        assertTrue(message.endsWith("."))
    }

    @Test fun aBatchModeRecoveryThatExhaustsBothAvenuesReportsTheFinalMessageRatherThanCrashingOrLooping() = runTest {
        // Simulates recoverFromBatchMode() having tried
        // PostConnectReaderUpdate() and reconnect() and given up — the one
        // path openVendorConnection() itself cannot swallow or retry.
        val r = fakeReaderThatThrows(backgroundScope, BatchModeUnrecoverableException())

        val result = r.connect(RfidTriggerPersonality.RFID, ScannerPluginMode.AUTO)
        assertTrue("connect must not throw, it must report", result.isFailure)
        assertTrue(
            "must surface as the exact exception recoverFromBatchMode throws",
            result.exceptionOrNull() is BatchModeUnrecoverableException,
        )

        val state = r.connection.value
        assertTrue("expected a Failed state, got $state", state is RfidConnection.Failed)
        assertEquals(BATCH_MODE_UNRECOVERABLE_MESSAGE, (state as RfidConnection.Failed).reason)
    }

    // ── trigger-mode setup (barcode-vs-RFID personality) ──
    //
    // The sequence itself — calling the real `Config.setTriggerMode()`
    // against a real reader that is actually running its barcode engine —
    // cannot be exercised here: there is no sled under Robolectric,
    // `setTriggerMode`'s boolean result depends on real vendor/firmware
    // state, and `ZebraRfidReader.configureTriggerMode` takes a real
    // `RFIDReader`, which can't be constructed or faked from a test (see the
    // class doc's note on why `openVendorConnection`/`closeVendorConnection`
    // are the seam instead). What *can* be proven without hardware: the pure
    // resolution of `ScannerPluginMode.AUTO` into a concrete
    // `updateScannerPlugin` flag given whether DataWedge is present, the
    // note-combining logic, and the operator-facing note text
    // `configureTriggerMode` leaves behind for both an accepted and a
    // refused combination.

    @Test fun resolveScannerPluginFlagFollowsDataWedgePresenceOnlyWhenAutomatic() {
        assertTrue(
            "AUTO with DataWedge present must resolve to true",
            resolveScannerPluginFlag(ScannerPluginMode.AUTO, dataWedgePresent = true),
        )
        assertFalse(
            "AUTO with DataWedge absent must resolve to false",
            resolveScannerPluginFlag(ScannerPluginMode.AUTO, dataWedgePresent = false),
        )
        assertTrue(
            "ON must resolve to true regardless of DataWedge",
            resolveScannerPluginFlag(ScannerPluginMode.ON, dataWedgePresent = false),
        )
        assertFalse(
            "OFF must resolve to false regardless of DataWedge",
            resolveScannerPluginFlag(ScannerPluginMode.OFF, dataWedgePresent = true),
        )
    }

    @Test fun combineConnectNotesAppendsToAnExistingNote() {
        assertEquals("first note. second note.", combineConnectNotes("first note.", "second note."))
    }

    @Test fun combineConnectNotesReturnsJustTheAdditionWhenNothingExistsYet() {
        assertEquals("only note.", combineConnectNotes(null, "only note."))
        assertEquals("only note.", combineConnectNotes("", "only note."))
        assertEquals("only note.", combineConnectNotes("   ", "only note."))
    }

    @Test fun triggerModeOutcomeNoteNamesTheCombinationWhenAccepted() {
        val message = triggerModeOutcomeNote(RfidTriggerPersonality.RFID, updateScannerPlugin = true, accepted = true)
        assertTrue("must say which personality took", message.contains("RFID"))
        assertTrue("must say the plugin flag used", message.contains("on"))
        assertTrue(message.endsWith("."))
    }

    @Test fun triggerModeOutcomeNoteNamesTheCombinationWhenRefused() {
        val message = triggerModeOutcomeNote(RfidTriggerPersonality.BARCODE, updateScannerPlugin = false, accepted = false)
        assertTrue("must say what mode was being attempted", message.contains("barcode"))
        assertTrue("must say the practical consequence", message.contains("trigger"))
        assertTrue(message.endsWith("."))
    }

    private class ThrowingVendorZebraRfidReader(
        context: android.content.Context,
        scope: CoroutineScope,
        private val failure: Throwable,
    ) : ZebraRfidReader(context, scope) {
        override fun hasOpenVendorConnection(): Boolean = false

        override fun openVendorConnection(triggerPersonality: RfidTriggerPersonality, scannerPluginMode: ScannerPluginMode): String =
            throw failure

        override fun closeVendorConnection() = Unit
    }

    private fun fakeReaderThatThrows(scope: CoroutineScope, failure: Throwable) =
        ThrowingVendorZebraRfidReader(ApplicationProvider.getApplicationContext(), scope, failure)
}
