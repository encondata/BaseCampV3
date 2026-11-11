package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure sled types every other layer reads: which layout is in force, what a read-back names. */
class SledTest {
    @Test fun effectiveLayoutIsRfidOnAZebraHostOrForASledWithNoScanner() {
        assertEquals(SledTriggerLayout.RFID, effectiveLayout(SledTriggerLayout.BARCODE, zebraHost = true, hasScanner = null))
        assertEquals(SledTriggerLayout.RFID, effectiveLayout(SledTriggerLayout.SPLIT, zebraHost = false, hasScanner = false))
        assertEquals(SledTriggerLayout.BARCODE, effectiveLayout(SledTriggerLayout.BARCODE, zebraHost = false, hasScanner = null))
        assertEquals(SledTriggerLayout.SPLIT, effectiveLayout(SledTriggerLayout.SPLIT, zebraHost = false, hasScanner = true))
    }

    @Test fun readbackNamesOnlyTheThreeLayouts() {
        assertEquals(SledTriggerLayout.RFID, readbackOf(SledKey.RFID, SledKey.RFID, 4).layout)
        assertEquals(SledTriggerLayout.SPLIT, readbackOf(SledKey.RFID, SledKey.SLED_SCAN, 5).layout)
        val barcode = readbackOf(SledKey.SLED_SCAN, SledKey.SLED_SCAN, 10)
        assertEquals(SledTriggerLayout.BARCODE, barcode.layout)
        assertFalse(barcode.readsTags)
        val swapped = readbackOf(SledKey.SLED_SCAN, SledKey.RFID, 9)
        assertNull(swapped.layout)
        assertTrue(swapped.readsTags)
        assertEquals(9, swapped.raw)
    }

    @Test fun layoutKeysRoundTrip() {
        for (layout in SledTriggerLayout.entries) {
            val (upper, lower) = layout.keys()
            assertEquals(layout, layoutOf(upper, lower))
        }
        assertEquals(SledKey.RFID to SledKey.RFID, SledTriggerLayout.RFID.keys())
        assertEquals(SledKey.RFID to SledKey.SLED_SCAN, SledTriggerLayout.SPLIT.keys())
        assertEquals(SledKey.SLED_SCAN to SledKey.SLED_SCAN, SledTriggerLayout.BARCODE.keys())
    }

    @Test fun usesScannerFollowsTheLayoutAndTheReadback() {
        assertFalse(SledTriggerLayout.RFID.usesScanner())
        assertTrue(SledTriggerLayout.BARCODE.usesScanner())
        assertTrue(SledTriggerLayout.SPLIT.usesScanner())
        assertTrue(readbackOf(SledKey.RFID, SledKey.SLED_SCAN, 5).usesScanner())
        assertFalse(readbackOf(SledKey.RFID, SledKey.TERMINAL_SCAN, 6).usesScanner())
    }

    @Test fun theLayoutInForcePrefersAnAcceptedReadback() {
        assertTrue(layoutInForceReadsTags(readbackOf(SledKey.RFID, SledKey.RFID, 4), SledTriggerLayout.BARCODE, zebraHost = false, hasScanner = null))
        assertFalse(layoutInForceReadsTags(null, SledTriggerLayout.BARCODE, zebraHost = false, hasScanner = null))
        assertTrue(layoutInForceReadsTags(null, SledTriggerLayout.BARCODE, zebraHost = false, hasScanner = false))
        assertTrue(layoutInForceReadsTags(null, SledTriggerLayout.BARCODE, zebraHost = true, hasScanner = null))
        assertTrue(layoutInForceUsesScanner(null, SledTriggerLayout.SPLIT, zebraHost = false, hasScanner = null))
        assertFalse(layoutInForceUsesScanner(readbackOf(SledKey.RFID, SledKey.RFID, 4), SledTriggerLayout.SPLIT, zebraHost = false, hasScanner = null))
    }

    @Test fun theNoBeamKeysAreTheLayoutsKeysWithNoScanKey() {
        assertEquals(SledKey.RFID to SledKey.RFID, SledTriggerLayout.RFID.interimKeys())
        assertEquals(SledKey.RFID to SledKey.NO_ACTION, SledTriggerLayout.SPLIT.interimKeys())
        assertEquals(SledKey.NO_ACTION to SledKey.NO_ACTION, SledTriggerLayout.BARCODE.interimKeys())
        // The wire values the sled reads back for them.
        assertEquals(8, keyLayoutValue(SledKey.RFID, SledKey.NO_ACTION))
        assertEquals(28, keyLayoutValue(SledKey.NO_ACTION, SledKey.NO_ACTION))
    }

    @Test fun aReadbackIsTheNoBeamLayoutOnlyForALayoutThatUsesTheScanner() {
        val noBeamBarcode = readbackOf(SledKey.NO_ACTION, SledKey.NO_ACTION, 28)
        val noBeamSplit = readbackOf(SledKey.RFID, SledKey.NO_ACTION, 8)
        assertTrue(noBeamBarcode.isInterimFor(SledTriggerLayout.BARCODE))
        assertFalse(noBeamBarcode.isInterimFor(SledTriggerLayout.SPLIT))
        assertTrue(noBeamSplit.isInterimFor(SledTriggerLayout.SPLIT))
        assertFalse(noBeamSplit.isInterimFor(SledTriggerLayout.BARCODE))
        assertFalse("RFID has no stand-in", readbackOf(SledKey.RFID, SledKey.RFID, 4).isInterimFor(SledTriggerLayout.RFID))
        assertFalse("the real layout is not its own stand-in", readbackOf(SledKey.SLED_SCAN, SledKey.SLED_SCAN, 10).isInterimFor(SledTriggerLayout.BARCODE))
        assertNull("the no-beam pairs name no layout", noBeamBarcode.layout)
        assertNull(noBeamSplit.layout)
    }

    @Test fun theNoBeamLayoutCountsAsUsingTheScannerForTheLayoutItStandsIn() {
        val noBeamBarcode = readbackOf(SledKey.NO_ACTION, SledKey.NO_ACTION, 28)
        val noBeamSplit = readbackOf(SledKey.RFID, SledKey.NO_ACTION, 8)
        assertTrue(layoutInForceUsesScanner(noBeamBarcode, SledTriggerLayout.BARCODE, zebraHost = false, hasScanner = null))
        assertTrue(layoutInForceUsesScanner(noBeamSplit, SledTriggerLayout.SPLIT, zebraHost = false, hasScanner = true))
        assertFalse("asked for RFID", layoutInForceUsesScanner(noBeamBarcode, SledTriggerLayout.RFID, zebraHost = false, hasScanner = null))
        assertFalse("the effective layout is RFID on a Zebra host", layoutInForceUsesScanner(noBeamBarcode, SledTriggerLayout.BARCODE, zebraHost = true, hasScanner = null))
        assertFalse("or for a sled with no scanner", layoutInForceUsesScanner(noBeamSplit, SledTriggerLayout.SPLIT, zebraHost = false, hasScanner = false))
        assertFalse("another layout's stand-in", layoutInForceUsesScanner(noBeamSplit, SledTriggerLayout.BARCODE, zebraHost = false, hasScanner = null))
    }

    @Test fun duringTheNoBeamLayoutPullsSweepOnlyWhereATriggerStillReadsTags() {
        val noBeamBarcode = readbackOf(SledKey.NO_ACTION, SledKey.NO_ACTION, 28)
        val noBeamSplit = readbackOf(SledKey.RFID, SledKey.NO_ACTION, 8)
        assertFalse("Barcode: no trigger reads tags", layoutInForceReadsTags(noBeamBarcode, SledTriggerLayout.BARCODE, zebraHost = false, hasScanner = null))
        assertTrue("Both: the upper trigger still reads tags", layoutInForceReadsTags(noBeamSplit, SledTriggerLayout.SPLIT, zebraHost = false, hasScanner = null))
    }

    @Test fun sledNamesAreRecognizedByPrefix() {
        assertTrue(isSledName("RFD4031-G10B700-US"))
        assertTrue(isSledName("RFD9090"))
        assertTrue(isSledName("RFD8500 1234"))
        assertFalse(isSledName("ZD421"))
        assertFalse(isSledName(null))
        assertEquals(listOf("RFD40", "RFD90", "RFD8500"), SLED_NAME_PREFIXES)
    }

    @Test fun aConnectExceptionCarriesTheFailedStatesSentence() {
        val failed = RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH)
        val e = SledConnectException(failed)
        assertEquals(failed, e.failed)
        assertEquals(failed.reason, e.message)
    }

    @Test fun eachLayoutHasItsWireValueLabelAndHint() {
        assertEquals(listOf("rfid", "barcode", "split"), SledTriggerLayout.entries.map { it.wire })
        assertEquals(listOf("RFID", "Barcode", "Both"), SledTriggerLayout.entries.map { it.label })
        for (layout in SledTriggerLayout.entries) {
            assertEquals(layout, SledTriggerLayout.fromWire(layout.wire))
            assertEquals(SledWords.hint(layout), layout.hint)
        }
        assertNull(SledTriggerLayout.fromWire("nonsense"))
        assertNull(SledTriggerLayout.fromWire(null))
    }
}
