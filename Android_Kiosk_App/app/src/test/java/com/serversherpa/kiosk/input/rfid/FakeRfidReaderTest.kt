package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Pins the fake down to what a real RFD40 would actually allow, so a
 * controller bug that skips connecting fails here instead of only on
 * hardware, and a test that emits before its collector subscribes finds out
 * loudly instead of silently losing the tag.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FakeRfidReaderTest {

    @Test fun startInventoryFailsWhileDisconnected() = runTest {
        val reader = FakeRfidReader()

        val result = reader.startInventory()

        assertTrue(result.isFailure)
        assertFalse(reader.inventoryRunning)
    }

    @Test fun applyFailsWhileDisconnected() = runTest {
        val reader = FakeRfidReader()

        val result = reader.apply(DEFAULT_RFID_SETTINGS)

        assertTrue(result.isFailure)
        assertNull(reader.applied)
    }

    @Test fun startInventoryAndApplySucceedAfterConnecting() = runTest {
        val reader = FakeRfidReader()

        val connected = reader.connect()
        assertTrue(connected.isSuccess)

        val started = reader.startInventory()
        val applied = reader.apply(DEFAULT_RFID_SETTINGS)

        assertTrue(started.isSuccess)
        assertTrue(reader.inventoryRunning)
        assertTrue(applied.isSuccess)
        assertEquals(DEFAULT_RFID_SETTINGS, reader.applied)
    }

    @Test fun aFailedConnectLeavesTheReaderFailedAndStillRefusesInventory() = runTest {
        val reader = FakeRfidReader()
        reader.connectResult = Result.failure(IllegalStateException("No sled paired."))

        val connected = reader.connect()
        assertTrue(connected.isFailure)
        assertTrue(reader.connection.value is RfidConnection.Failed)

        val started = reader.startInventory()
        assertTrue(started.isFailure)
        assertFalse(reader.inventoryRunning)
    }

    @Test fun emitTagThrowsWhenNothingIsCollecting() = runTest {
        val reader = FakeRfidReader()

        assertThrows(IllegalStateException::class.java) {
            reader.emitTag("100348")
        }
    }

    @Test fun emitTriggerThrowsWhenNothingIsCollecting() = runTest {
        val reader = FakeRfidReader()

        assertThrows(IllegalStateException::class.java) {
            reader.emitTrigger(TriggerEvent.PRESSED)
        }
    }
}
