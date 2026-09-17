package com.serversherpa.kiosk.input.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What can be proven without hardware: the pure logic
 * [ZebraBarcodeEngine.attemptStandDown] feeds into — matching a scanner the
 * SDK reports against this kiosk's own sled identity ([chooseScanner]; see
 * its doc for the exact rule and the real field bug — a stranger's dive
 * computer being chosen instead of the actual sled — it exists to fix), the
 * (trivial but real) XML body the scan-disable/scan-enable opcodes are sent
 * with ([scanCommandInXml]), and the operator-facing note text
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
    //
    // chooseScanner now takes the target SledIdentity to match against —
    // see its doc for the exact matching rule (normalized serial equals
    // normalized address OR normalized serial, name never used to select).
    // Every discriminating test below places a non-matching "stranger"
    // candidate ahead of the real sled in the list, so a revert back to the
    // old, target-blind firstOrNull() behavior this task removed — the
    // real bug: "chose scanner id=1 name=HSLT_a844 ... first taken" over
    // the actual sled further down the list — would return the stranger and
    // fail the assertion, not just happen to pass anyway.

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

    @Test fun imagerStandDownNoteForNotIdentifiedNamesTheProblemAndTheRisk() {
        val note = imagerStandDownNote(ImagerStandDownOutcome.NotIdentified)
        assertTrue("must say the imager couldn't be identified", note.contains("couldn't be identified"))
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
            imagerStandDownNote(ImagerStandDownOutcome.NotIdentified),
            imagerStandDownNote(ImagerStandDownOutcome.SessionFailed("X")),
            imagerStandDownNote(ImagerStandDownOutcome.CommandFailed("Y")),
            imagerStandDownNote(ImagerStandDownOutcome.Unreachable("Z")),
        )
        assertEquals("no two outcomes should read the same to the operator", notes.size, notes.toSet().size)
    }
}
