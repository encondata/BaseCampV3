package com.serversherpa.kiosk.input.rfid

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.RfidConnection
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
        val result = r.connect()
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

        override fun openVendorConnection(): String {
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

        val thrown = runCatching { r.connect() }.exceptionOrNull()
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

        val first = r.connect()
        assertTrue(first.isSuccess)
        assertEquals(1, r.openCalls)
        assertEquals(0, r.closeCalls)

        // A DISCONNECTION_EVENT sets `_connection` to Failed but — per finding
        // 2 — never tears the reader down itself, so the stale reader is still
        // attached here, exactly like the real class after that event.
        assertTrue(r.attached)

        val second = r.connect()
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
}
