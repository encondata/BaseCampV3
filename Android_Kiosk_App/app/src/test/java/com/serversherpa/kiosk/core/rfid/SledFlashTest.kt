package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The full-screen sled flashes (task H7, Jimmy 2026-11-17): red "Sled disconnected" when a
 * connected sled's link drops by itself, green "Ready to scan" the first time a connection is
 * usable. The decider is fed snapshots of the connection, the info generation and readiness,
 * the way the controller's collector sees them.
 */
class SledFlashTest {
    private val connected = RfidConnection.Connected("RFD4031", 80)
    private val needsRegion = RfidConnection.NeedsRegion("RFD4031")
    private val dropped = RfidConnection.Failed(SledWords.couldNotReach("RFD4031"), retryable = true, fix = SledFix.CONNECT)

    /** One step of the controller's collector: [usesScanner] is the layout in force's rule. */
    private class Feed(private val enabled: () -> Boolean = { true }) {
        val decider = SledFlashDecider()
        val out = mutableListOf<SledFlash>()

        fun step(
            connection: RfidConnection,
            generation: Int?,
            usesScanner: Boolean = false,
            scanner: SledScannerState = SledScannerState.Off,
        ) {
            decider.next(connection, generation, sledReady(connection, usesScanner, scanner), enabled())?.let(out::add)
        }

        /** A connect that comes up as generation [g] (the reader publishes `info`, then `Connected`). */
        fun connect(g: Int, usesScanner: Boolean = false) {
            step(RfidConnection.Connecting, null, usesScanner)
            step(RfidConnection.Connecting, g, usesScanner)
            step(RFD_CONNECTED, g, usesScanner)
        }
    }

    @Test fun aDropFlashesRed() {
        val f = Feed()
        f.connect(1)
        f.out.clear()
        // The link drops by itself: a retryable failure with `info` kept.
        f.step(dropped, 1)
        assertEquals(listOf(SledFlash.DROPPED), f.out)
    }

    @Test fun aDropFromNeedsRegionFlashesRedToo() {
        val f = Feed()
        f.step(RfidConnection.Connecting, null)
        f.step(needsRegion, 1)
        assertEquals("NeedsRegion is not usable", emptyList<SledFlash>(), f.out)
        f.step(dropped, 1)
        assertEquals(listOf(SledFlash.DROPPED), f.out)
    }

    @Test fun disconnectStopSwitchOffAndBackgroundFlashNothing() {
        // Each of these ends `Disconnected` (Stop ends a schedule the same way): the reader
        // clears `info`, then publishes `Disconnected`.
        for (label in listOf("Disconnect", "Stop", "the reader switch off", "the app to the background")) {
            val f = Feed()
            f.connect(1)
            f.out.clear()
            f.step(connected, null)
            f.step(RfidConnection.Disconnected, null)
            assertEquals(label, emptyList<SledFlash>(), f.out)
        }
        // Stop during a reconnect wait after a drop: the drop flashed once, Stop adds nothing.
        val f = Feed()
        f.connect(1)
        f.step(dropped, 1)
        f.out.clear()
        f.step(dropped, null)
        f.step(RfidConnection.Disconnected, null)
        assertEquals(emptyList<SledFlash>(), f.out)
    }

    @Test fun aNeverUpFailureFlashesNothing() {
        val f = Feed()
        f.step(RfidConnection.Disconnected, null)
        f.step(RfidConnection.Connecting, null)
        f.step(dropped, null)
        // Even if `info` were seen, a link that was never up did not drop.
        f.step(dropped, 1)
        f.step(RfidConnection.Failed(SledWords.TRIGGER_NOT_SET_UP, retryable = true, fix = SledFix.CONNECT), null)
        assertEquals(emptyList<SledFlash>(), f.out)
    }

    @Test fun anRfidConnectFlashesGreenAtOnce() {
        val f = Feed()
        f.step(RfidConnection.Connecting, null)
        f.step(RfidConnection.Connecting, 1)
        assertEquals("not before Connected", emptyList<SledFlash>(), f.out)
        f.step(connected, 1)
        assertEquals(listOf(SledFlash.READY), f.out)
    }

    @Test fun aBarcodeConnectFlashesGreenOnlyAtScannerReady() {
        val f = Feed()
        f.connect(1, usesScanner = true)
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Opening)
        assertEquals("not while the scanner starts", emptyList<SledFlash>(), f.out)
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Ready)
        assertEquals(listOf(SledFlash.READY), f.out)
        // A battery update on the same link is not a second ready.
        f.step(RfidConnection.Connected("RFD4031", 79), 1, usesScanner = true, scanner = SledScannerState.Ready)
        assertEquals(listOf(SledFlash.READY), f.out)
    }

    @Test fun didNotStartFlashesNothingThenTryAgainToReadyFlashesGreen() {
        val f = Feed()
        f.connect(1, usesScanner = true)
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Opening)
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Unavailable(SledScannerFault.DID_NOT_START))
        assertEquals(emptyList<SledFlash>(), f.out)
        // Try again, on the same generation.
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Opening)
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Ready)
        assertEquals(listOf(SledFlash.READY), f.out)
    }

    @Test fun aSecondConnectFlashesGreenAgain() {
        val f = Feed()
        f.connect(1)
        // A drop, then the automatic reconnect.
        f.step(dropped, 1)
        f.connect(2)
        // A manual Disconnect, then Connect.
        f.step(connected, null)
        f.step(RfidConnection.Disconnected, null)
        f.connect(3)
        assertEquals(listOf(SledFlash.READY, SledFlash.DROPPED, SledFlash.READY, SledFlash.READY), f.out)
    }

    @Test fun aLayoutChangeWithinAConnectionFlashesNothing() {
        val f = Feed()
        f.connect(1)
        f.out.clear()
        // RFID to Barcode: the scanner starts, then is ready, on the same generation.
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Opening)
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Ready)
        // And back to RFID.
        f.step(connected, 1, usesScanner = false, scanner = SledScannerState.Off)
        assertEquals(emptyList<SledFlash>(), f.out)
    }

    @Test fun bluetoothOffIsADropAndFlashesRed() {
        val f = Feed()
        f.connect(1, usesScanner = true)
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Ready)
        f.out.clear()
        // Bluetooth off: the scanner goes Off at once, then the reader records the loss.
        f.step(connected, 1, usesScanner = true, scanner = SledScannerState.Off)
        f.step(dropped, 1, usesScanner = true, scanner = SledScannerState.Off)
        assertEquals(listOf(SledFlash.DROPPED), f.out)
    }

    @Test fun withTheSettingOffNothingFlashes() {
        var on = false
        val f = Feed { on }
        f.connect(1)
        f.step(dropped, 1)
        f.connect(2, usesScanner = true)
        f.step(connected, 2, usesScanner = true, scanner = SledScannerState.Ready)
        assertEquals(emptyList<SledFlash>(), f.out)
        // Turned on again mid-connection: the ready it already passed is not shown late.
        on = true
        f.step(connected, 2, usesScanner = true, scanner = SledScannerState.Ready)
        assertEquals(emptyList<SledFlash>(), f.out)
        f.step(dropped, 2)
        assertEquals(listOf(SledFlash.DROPPED), f.out)
    }

    @Test fun readyNeedsConnectedAndAReadyScannerWhenTheLayoutUsesIt() {
        assertTrue(sledReady(connected, usesScanner = false, scanner = SledScannerState.Off))
        assertTrue(sledReady(connected, usesScanner = true, scanner = SledScannerState.Ready))
        assertFalse(sledReady(connected, usesScanner = true, scanner = SledScannerState.Opening))
        assertFalse(sledReady(connected, usesScanner = true, scanner = SledScannerState.Unavailable(SledScannerFault.BLUETOOTH_OFF)))
        assertFalse(sledReady(needsRegion, usesScanner = false, scanner = SledScannerState.Off))
        assertFalse(sledReady(RfidConnection.Connecting, usesScanner = false, scanner = SledScannerState.Ready))
    }

    @Test fun theFlashSentencesKeepTheWordsRule() {
        for (s in listOf(SledWords.FLASH_DISCONNECTED, SledWords.FLASH_READY, SledWords.ROW_SLED_FLASH, SledWords.HINT_SLED_FLASH)) {
            assertEquals(s, emptyList<String>(), sledWordsViolations(s))
        }
        assertEquals("Sled disconnected", SledWords.FLASH_DISCONNECTED)
        assertEquals("Ready to scan", SledWords.FLASH_READY)
        assertEquals("Flash when the sled connects or drops", SledWords.ROW_SLED_FLASH)
        assertEquals("A full-screen red “Sled disconnected” or green “Ready to scan”.", SledWords.HINT_SLED_FLASH)
    }

    private companion object {
        val RFD_CONNECTED = RfidConnection.Connected("RFD4031", 80)
    }
}
