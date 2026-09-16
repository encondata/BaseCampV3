package com.serversherpa.kiosk.input.rfid

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.RfidConnection
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
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
}
