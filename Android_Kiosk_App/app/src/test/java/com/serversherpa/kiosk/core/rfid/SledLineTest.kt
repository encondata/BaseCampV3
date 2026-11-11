package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Spec test 35: the sled line every screen shows, and the scan-screen slot's priority and tone. */
class SledLineTest {
    private val name = "RFD4031-G10B700-US"
    private val connected = RfidConnection.Connected(name, 74)

    private fun line(
        c: RfidConnection,
        reconnecting: Boolean = false,
        enabled: Boolean = true,
        permissionMissing: Boolean = false,
        retry: SledRetry? = null,
    ): SledLine = sledLine(c, reconnecting, enabled, permissionMissing, retry).also {
        assertEquals("words rule: ${it.text}", emptyList<String>(), sledWordsViolations(it.text))
    }

    // ── sledLine, row by row, in the order it tries them ──

    @Test fun theReaderOffSaysOffWhateverTheState() {
        assertEquals(SledLine(SledWords.OFF, null, false), line(connected, reconnecting = true, enabled = false, permissionMissing = true))
    }

    @Test fun aReconnectAfterTheTriggerFailedSaysTheTriggerIsBeingTriedAgain() {
        val retry = SledRetry(afterDrop = true, name = name, lastReason = SledWords.TRIGGER_NOT_SET_UP)
        assertEquals(
            SledLine(SledWords.TRIGGER_NOT_SET_UP_RETRYING, null, true),
            line(RfidConnection.Failed(SledWords.TRIGGER_NOT_SET_UP, retryable = true), reconnecting = true, retry = retry),
        )
    }

    @Test fun aReconnectAfterADropSaysTheSledDisconnected() {
        val retry = SledRetry(afterDrop = true, name = name, lastReason = "The link dropped.")
        assertEquals(SledLine(SledWords.RECONNECTING_AFTER_DROP, null, true), line(RfidConnection.Connecting, reconnecting = true, retry = retry))
    }

    @Test fun aReconnectOfAConnectThatNeverCameUpNamesTheSled() {
        val retry = SledRetry(afterDrop = false, name = name, lastReason = null)
        assertEquals(SledLine(SledWords.connectingTo(name), null, true), line(RfidConnection.Disconnected, reconnecting = true, retry = retry))
    }

    /** Preflight ruling 13: reconnecting with no retry known reads "Connecting to the sled…", with Stop. */
    @Test fun aReconnectWithNoRetryKnownSaysConnectingToTheSled() {
        assertEquals(SledLine(SledWords.connectingTo(null), null, true), line(RfidConnection.Connecting, reconnecting = true))
        assertEquals("Connecting to the sled…", SledWords.connectingTo(null))
    }

    @Test fun connectedNamesTheSledAndItsBattery() {
        assertEquals(SledLine(SledWords.connected(name, 74), null, false), line(connected, permissionMissing = true))
    }

    @Test fun noRegionNamesTheSled() {
        assertEquals(SledLine(SledWords.noRegion(name), null, false), line(RfidConnection.NeedsRegion(name), permissionMissing = true))
    }

    @Test fun connectingSaysConnecting() {
        assertEquals(SledLine(SledWords.CONNECTING, null, false), line(RfidConnection.Connecting, permissionMissing = true))
    }

    @Test fun aMissingPermissionWinsOverAFailureAndOffersOpenAppSettings() {
        val failed = RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH)
        assertEquals(SledLine(SledWords.PERMISSION_MISSING, SledFix.ALLOW, false), line(failed, permissionMissing = true))
        assertEquals(SledLine(SledWords.PERMISSION_MISSING, SledFix.ALLOW, false), line(RfidConnection.Disconnected, permissionMissing = true))
    }

    @Test fun aFailureSaysItsReasonWithItsFix() {
        val failed = RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH)
        assertEquals(SledLine(SledWords.BLUETOOTH_OFF, SledFix.TURN_ON_BLUETOOTH, false), line(failed))
        assertEquals(SledLine(SledWords.couldNotReach(name), null, false), line(RfidConnection.Failed(SledWords.couldNotReach(name))))
    }

    @Test fun disconnectedSaysNotConnectedWithConnect() {
        assertEquals(SledLine(SledWords.NOT_CONNECTED, SledFix.CONNECT, false), line(RfidConnection.Disconnected))
        // Nobody writes Disabled; with the reader on it reads as not connected.
        assertEquals(SledLine(SledWords.NOT_CONNECTED, SledFix.CONNECT, false), line(RfidConnection.Disabled))
    }

    // ── scanSlotLine: priority ──

    private fun slot(
        c: RfidConnection,
        scanner: SledScannerState = SledScannerState.Off,
        readError: String? = null,
        reconnecting: Boolean = false,
        textAtOpen: String? = null,
    ): SlotLine? = scanSlotLine(sledLine(c, reconnecting, enabled = true, permissionMissing = false), c, scanner, readError, textAtOpen)

    @Test fun nothingShowsWhileConnectedAndWorking() {
        assertNull(slot(connected))
        assertNull(slot(connected, scanner = SledScannerState.Ready))
        // Bluetooth off is the connection line's to say.
        assertNull(slot(connected, scanner = SledScannerState.Unavailable(SledScannerFault.BLUETOOTH_OFF)))
    }

    @Test fun theConnectionComesBeforeTheScannerAndTheReadError() {
        val failed = RfidConnection.Failed(SledWords.couldNotReach(name), fix = SledFix.CONNECT)
        val s = slot(failed, scanner = SledScannerState.Opening, readError = SledWords.READ_DID_NOT_START)!!
        assertEquals(SledWords.couldNotReach(name), s.text)
        assertEquals(SledFix.CONNECT, s.fix)
        assertFalse(s.offersStop)
    }

    @Test fun aReconnectComesFirstEvenWhileTheStateStillSaysConnected() {
        val s = slot(connected, scanner = SledScannerState.Opening, readError = SledWords.READ_DID_NOT_START, reconnecting = true)!!
        assertEquals(SledWords.connectingTo(null), s.text)
        assertTrue(s.offersStop)
    }

    @Test fun theRegionComesBeforeTheScannerAndTheReadError() {
        val s = slot(RfidConnection.NeedsRegion(name), scanner = SledScannerState.Opening, readError = SledWords.READ_DID_NOT_START)!!
        assertEquals(SledWords.noRegion(name), s.text)
        assertNull(s.fix)
    }

    @Test fun theScannerComesBeforeTheReadError() {
        val starting = slot(connected, scanner = SledScannerState.Opening, readError = SledWords.READ_DID_NOT_START)!!
        assertEquals(SledWords.SCANNER_STARTING, starting.text)
        val didNotStart = slot(connected, SledScannerState.Unavailable(SledScannerFault.DID_NOT_START), SledWords.READ_DID_NOT_START)!!
        assertEquals(SledWords.SCANNER_DID_NOT_START, didNotStart.text)
        val stopped = slot(connected, SledScannerState.Unavailable(SledScannerFault.STOPPED_RESPONDING), SledWords.READ_DID_NOT_START)!!
        assertEquals(SledWords.SCANNER_STOPPED_RESPONDING, stopped.text)
    }

    @Test fun aReadErrorShowsWhenNothingElseDoes() {
        assertEquals(SledWords.MAY_STILL_BE_READING, slot(connected, SledScannerState.Ready, SledWords.MAY_STILL_BE_READING)?.text)
    }

    // ── scanSlotLine: tone ──

    @Test fun aLineThatWasAlreadyThereAtOpenIsMutedAndAnyOtherIsRed() {
        val failed = RfidConnection.Failed(SledWords.couldNotReach(name))
        assertFalse(slot(failed, textAtOpen = SledWords.couldNotReach(name))!!.red)
        assertTrue(slot(failed, textAtOpen = null)!!.red)
        assertTrue(slot(failed, textAtOpen = SledWords.NOT_CONNECTED)!!.red)
        val stopped = SledScannerState.Unavailable(SledScannerFault.STOPPED_RESPONDING)
        assertFalse(slot(connected, stopped, textAtOpen = SledWords.SCANNER_STOPPED_RESPONDING)!!.red)
        assertTrue(slot(connected, stopped, textAtOpen = null)!!.red)
    }

    @Test fun startingTheScannerIsAlwaysMuted() {
        assertFalse(slot(connected, SledScannerState.Opening, textAtOpen = null)!!.red)
        assertFalse(slot(connected, SledScannerState.Opening, textAtOpen = SledWords.NOT_CONNECTED)!!.red)
    }

    @Test fun aReadErrorIsAlwaysRed() {
        assertTrue(slot(connected, readError = SledWords.READ_DID_NOT_START, textAtOpen = SledWords.READ_DID_NOT_START)!!.red)
        assertTrue(slot(connected, readError = SledWords.READ_DID_NOT_START, textAtOpen = null)!!.red)
    }
}
