package com.serversherpa.kiosk.input.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What can be proven without hardware: the pure logic
 * [ZebraBarcodeEngine.attemptStandDown] feeds into — picking a scanner from
 * whatever the SDK reports ([chooseScanner]), the (trivial but real) XML
 * body the scan-disable/scan-enable opcodes are sent with
 * ([scanCommandInXml]), and the operator-facing note text
 * ([imagerStandDownNote]) for every outcome [ZebraBarcodeEngine.standDown]
 * can produce.
 *
 * What is NOT covered here, and can only be proven on real hardware: whether
 * `SDKHandler` can be constructed at all on a given device, whether
 * `dcssdkSetOperationalMode(DCSSDK_OPMODE_BT_NORMAL)` is really the right
 * mode for an RFD40, whether the sled shows up in
 * `dcssdkGetAvailableScannersList()`/`dcssdkGetActiveScannersList()` at all,
 * whether `dcssdkEstablishCommunicationSession` actually succeeds, and
 * whether `DCSSDK_DEVICE_SCAN_DISABLE` actually stops the imager from
 * firing. None of `SDKHandler`/`DCSScannerInfo`/`DCSSDKDefs` can be
 * constructed from a test the way `OperationFailureException` cannot in
 * `ZebraRfidReaderTest` — so, per that same file's precedent, this test
 * does not fake any of it.
 */
class ZebraBarcodeEngineTest {

    // ── chooseScanner ──

    @Test fun chooseScannerReturnsNullWhenNothingWasFound() {
        assertNull(chooseScanner(emptyList()))
    }

    @Test fun chooseScannerPicksTheOnlyCandidate() {
        val only = ScannerCandidate(scannerId = 7, name = "RFD40", model = "RFD40", serial = "abc123")
        assertEquals(only, chooseScanner(listOf(only)))
    }

    @Test fun chooseScannerPicksTheFirstOfSeveralCandidates() {
        val first = ScannerCandidate(scannerId = 1, name = "first", model = null, serial = null)
        val second = ScannerCandidate(scannerId = 2, name = "second", model = null, serial = null)
        assertEquals(
            "with no matching rule this app has evidence for, the first candidate wins — see chooseScanner's doc",
            first,
            chooseScanner(listOf(first, second)),
        )
    }

    // ── scanCommandInXml ──

    @Test fun scanCommandXmlIsEmpty() {
        // DCSSDK_DEVICE_SCAN_DISABLE/ENABLE take no parameters and are
        // addressed by the scannerID argument, not the XML body — see the
        // function's doc. Pinned explicitly so a future accidental change
        // (e.g. someone "helpfully" adding a body) fails a test, not just a
        // device.
        assertEquals("", scanCommandInXml())
    }

    // ── imagerStandDownNote ──

    @Test fun imagerStandDownNoteForSuccessSaysItWasSilenced() {
        val note = imagerStandDownNote(ImagerStandDownOutcome.Silenced)
        assertTrue(note.contains("stand down"))
        assertTrue(note.endsWith("."))
    }

    @Test fun imagerStandDownNoteForNoScannerFoundNamesTheProblemAndTheRisk() {
        val note = imagerStandDownNote(ImagerStandDownOutcome.NoScannerFound)
        assertTrue("must say the imager couldn't be reached", note.contains("couldn't be reached"))
        assertTrue("must warn it may still fire", note.contains("may still fire"))
        assertTrue(note.endsWith("."))
    }

    @Test fun imagerStandDownNoteForSessionFailedNamesTheVendorResult() {
        val note = imagerStandDownNote(ImagerStandDownOutcome.SessionFailed("DCSSDK_RESULT_SCANNER_NOT_AVAILABLE"))
        assertTrue(note.contains("DCSSDK_RESULT_SCANNER_NOT_AVAILABLE"))
        assertTrue(note.contains("may still fire"))
        assertTrue(note.endsWith("."))
    }

    @Test fun imagerStandDownNoteForCommandFailedNamesTheVendorResult() {
        val note = imagerStandDownNote(ImagerStandDownOutcome.CommandFailed("DCSSDK_RESULT_FAILURE"))
        assertTrue(note.contains("DCSSDK_RESULT_FAILURE"))
        assertTrue(note.contains("may still fire"))
        assertTrue(note.endsWith("."))
    }

    @Test fun imagerStandDownNoteForUnreachableNamesTheDetail() {
        val note = imagerStandDownNote(ImagerStandDownOutcome.Unreachable("NoClassDefFoundError"))
        assertTrue(note.contains("NoClassDefFoundError"))
        assertTrue(note.contains("couldn't be reached"))
        assertTrue(note.endsWith("."))
    }

    @Test fun everyOutcomeProducesADistinctSentence() {
        val notes = listOf(
            imagerStandDownNote(ImagerStandDownOutcome.Silenced),
            imagerStandDownNote(ImagerStandDownOutcome.NoScannerFound),
            imagerStandDownNote(ImagerStandDownOutcome.SessionFailed("X")),
            imagerStandDownNote(ImagerStandDownOutcome.CommandFailed("Y")),
            imagerStandDownNote(ImagerStandDownOutcome.Unreachable("Z")),
        )
        assertEquals("no two outcomes should read the same to the operator", notes.size, notes.toSet().size)
    }
}
