package com.serversherpa.kiosk.core.rfid

import com.serversherpa.kiosk.core.rfid.SledRouteKind.ENROLL_OR_PRINT
import com.serversherpa.kiosk.core.rfid.SledRouteKind.OTHER
import com.serversherpa.kiosk.core.rfid.SledRouteKind.SCAN_OR_LOOKUP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Spec test 8: the keep-display-on table, first matching row wins. */
class SledDisplayTest {
    private val connected = RfidConnection.Connected("RFD4031", 80)
    private val failed = RfidConnection.Failed("The sled disconnected.", retryable = true)
    private val offStates = listOf(failed, RfidConnection.NeedsRegion("RFD4031"), RfidConnection.Disconnected, RfidConnection.Disabled)

    private fun on(
        kind: SledRouteKind, connection: RfidConnection, enabled: Boolean = true, reconnecting: Boolean = false,
        usesScanner: Boolean = false, idleMs: Long = 0,
    ) = keepDisplayOn(kind, enabled, connection, reconnecting, usesScanner, idleMs)

    @Test fun theIdleLimitIsTenMinutes() {
        assertEquals(600_000L, SLED_DISPLAY_IDLE_MS)
    }

    // Row 1: Scanning, Asset Lookup.

    @Test fun scanningOrLookupStaysOnWhileConnectedConnectingOrReconnecting() {
        assertTrue(on(SCAN_OR_LOOKUP, connected))
        assertTrue(on(SCAN_OR_LOOKUP, RfidConnection.Connecting))
        assertTrue(on(SCAN_OR_LOOKUP, RfidConnection.Disconnected, reconnecting = true))
    }

    @Test fun failedWhileReconnectingOnScanningStaysOn() {
        // The third row never overrides the first.
        assertTrue(on(SCAN_OR_LOOKUP, failed, reconnecting = true))
        assertTrue(on(SCAN_OR_LOOKUP, RfidConnection.NeedsRegion("RFD4031"), reconnecting = true))
    }

    @Test fun scanningOrLookupReleasesAtTenIdleMinutes() {
        assertTrue(on(SCAN_OR_LOOKUP, connected, idleMs = 599_999))
        assertFalse(on(SCAN_OR_LOOKUP, connected, idleMs = 600_000))
        assertFalse(on(SCAN_OR_LOOKUP, failed, reconnecting = true, idleMs = 600_000))
    }

    @Test fun scanningOrLookupIsOffWithTheReaderOff() {
        assertFalse(on(SCAN_OR_LOOKUP, connected, enabled = false))
        assertFalse(on(SCAN_OR_LOOKUP, RfidConnection.Connecting, enabled = false, reconnecting = true))
    }

    @Test fun scanningOrLookupDoesNotNeedTheScanner() {
        assertTrue(on(SCAN_OR_LOOKUP, connected, usesScanner = false))
        assertTrue(on(SCAN_OR_LOOKUP, connected, usesScanner = true))
    }

    // Row 2: RFID Enroll, Print Labels.

    @Test fun enrollOrPrintStaysOnOnlyWhileConnectedAndTheLayoutUsesTheScanner() {
        assertTrue(on(ENROLL_OR_PRINT, connected, usesScanner = true))
        assertFalse(on(ENROLL_OR_PRINT, connected, usesScanner = false))
        assertFalse(on(ENROLL_OR_PRINT, RfidConnection.Connecting, usesScanner = true))
        assertFalse(on(ENROLL_OR_PRINT, failed, reconnecting = true, usesScanner = true))
        assertFalse(on(ENROLL_OR_PRINT, connected, enabled = false, usesScanner = true))
    }

    @Test fun enrollOrPrintReleasesAtTenIdleMinutes() {
        assertTrue(on(ENROLL_OR_PRINT, connected, usesScanner = true, idleMs = 599_999))
        assertFalse(on(ENROLL_OR_PRINT, connected, usesScanner = true, idleMs = 600_000))
    }

    // Row 3: not reconnecting, and Failed, NeedsRegion, Disconnected or the reader off.

    @Test fun everyOffStateIsOffWhenNotReconnecting() {
        for (kind in SledRouteKind.entries) for (state in offStates) {
            assertFalse("$kind $state", on(kind, state, usesScanner = true))
        }
        for (kind in SledRouteKind.entries) {
            assertFalse("$kind reader off", on(kind, connected, enabled = false, usesScanner = true))
        }
    }

    @Test fun afterTheReconnectGaveUpTheDisplayIsReleased() {
        assertFalse(on(SCAN_OR_LOOKUP, failed, reconnecting = false))
    }

    // Row 4: any other screen.

    @Test fun anyOtherScreenIsOff() {
        assertFalse(on(OTHER, connected, usesScanner = true))
        assertFalse(on(OTHER, RfidConnection.Connecting, reconnecting = true))
        assertFalse(on(OTHER, failed, reconnecting = true, usesScanner = true))
    }
}
