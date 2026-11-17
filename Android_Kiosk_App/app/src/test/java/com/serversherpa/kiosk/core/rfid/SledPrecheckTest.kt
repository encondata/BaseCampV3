package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

/** The pre-check before any vendor object: one test per row of the spec's table. */
class SledPrecheckTest {
    private val sledA = BondedDevice("RFD40+_2234", "AA:BB:CC:00:00:01")
    private val sledB = BondedDevice("RFD9090_7710", "AA:BB:CC:00:00:02")
    private val headset = BondedDevice("Pixel Buds", "11:22:33:44:55:66")

    private fun check(
        bonded: List<BondedDevice>,
        saved: String? = null,
        bluetoothOn: Boolean = true,
        nearbyGranted: Boolean = true,
    ) = precheck(bluetoothOn, nearbyGranted, bonded, saved)

    private fun refused(reason: String, fix: SledFix) =
        Precheck.Refused(RfidConnection.Failed(reason, retryable = false, fix = fix))

    private fun candidate(d: BondedDevice) = SledCandidate(d.name!!, d.address)

    @Test fun bluetoothOffAsksToTurnItOn() {
        // Checked first: nothing else matters while Bluetooth is off.
        assertEquals(
            refused(SledWords.BLUETOOTH_OFF, SledFix.TURN_ON_BLUETOOTH),
            check(listOf(sledA), bluetoothOn = false, nearbyGranted = false),
        )
    }

    @Test fun missingNearbyAsksToAllow() {
        assertEquals(
            refused(SledWords.PERMISSION_MISSING, SledFix.ALLOW),
            check(listOf(BondedDevice(null, "00:00:00:00:00:00")), nearbyGranted = false),
        )
    }

    @Test fun aNamelessBondedDeviceBlocksTheConnect() {
        assertEquals(
            refused(SledWords.NAMELESS_DEVICE, SledFix.BLUETOOTH_SETTINGS),
            check(listOf(sledA, BondedDevice(null, "00:00:00:00:00:09")), saved = sledA.address),
        )
    }

    @Test fun noSledPairedPointsToBluetoothSettings() {
        assertEquals(refused(SledWords.NO_SLED_PAIRED, SledFix.BLUETOOTH_SETTINGS), check(emptyList()))
        // Names match the prefixes exactly, case included.
        assertEquals(
            refused(SledWords.NO_SLED_PAIRED, SledFix.BLUETOOTH_SETTINGS),
            check(listOf(headset, BondedDevice("rfd40+_2234", "AA:BB:CC:00:00:07"))),
        )
    }

    @Test fun theSavedSledIsChosenIgnoringCase() {
        assertEquals(
            Precheck.Chosen(candidate(sledB), autoChosen = false, severalPaired = true),
            check(listOf(sledA, headset, sledB), saved = sledB.address.lowercase()),
        )
        assertEquals(
            Precheck.Chosen(candidate(sledA), autoChosen = false, severalPaired = false),
            check(listOf(sledA, headset), saved = sledA.address),
        )
    }

    @Test fun aSavedAddressNotPairedCountsAsNoneSaved() {
        assertEquals(
            Precheck.Chosen(candidate(sledA), autoChosen = true, severalPaired = false),
            check(listOf(sledA), saved = "FF:FF:FF:FF:FF:FF"),
        )
        // A saved address that belongs to a paired device that is not a sled is not a sled either.
        assertEquals(
            refused(SledWords.SEVERAL_PAIRED, SledFix.CHOOSE_SLED),
            check(listOf(sledA, sledB, headset), saved = headset.address),
        )
    }

    @Test fun oneSledIsChosenAutomatically() {
        assertEquals(
            Precheck.Chosen(candidate(sledA), autoChosen = true, severalPaired = false),
            check(listOf(headset, sledA)),
        )
    }

    @Test fun severalWithNoneSavedAskToChoose() {
        assertEquals(refused(SledWords.SEVERAL_PAIRED, SledFix.CHOOSE_SLED), check(listOf(sledA, sledB)))
    }

    @Test fun twoDevicesSharingTheSledsNameBlockIt() {
        val twin = BondedDevice(sledA.name, "AA:BB:CC:00:00:99")
        assertEquals(
            refused(SledWords.duplicateName(sledA.name!!), SledFix.BLUETOOTH_SETTINGS),
            check(listOf(sledA, twin), saved = sledA.address),
        )
        // A non-sled device sharing the name blocks it as well (the vendor connects by name).
        val sameNamedOther = BondedDevice(sledB.name, "11:22:33:44:55:77")
        assertEquals(
            refused(SledWords.duplicateName(sledB.name!!), SledFix.BLUETOOTH_SETTINGS),
            check(listOf(sledA, sledB, sameNamedOther), saved = sledB.address),
        )
        // Only the chosen sled's name counts: a twin of another sled does not block this one.
        assertEquals(
            Precheck.Chosen(candidate(sledB), autoChosen = false, severalPaired = true),
            check(listOf(sledA, twin, sledB), saved = sledB.address),
        )
    }

    @Test fun pairedSledsKeepOnlySledNames() {
        val rfd8500 = BondedDevice("RFD8500_123", "AA:BB:CC:00:00:03")
        assertEquals(
            listOf(candidate(sledA), candidate(sledB), candidate(rfd8500)),
            pairedSledsOf(listOf(headset, sledA, BondedDevice(null, "0"), sledB, BondedDevice("xRFD40", "1"), rfd8500)),
        )
        assertEquals(emptyList<SledCandidate>(), pairedSledsOf(emptyList()))
    }

    @Test fun everyRefusalReasonIsASledWordsSentence() {
        val refusals = listOf(
            check(listOf(sledA), bluetoothOn = false),
            check(listOf(sledA), nearbyGranted = false),
            check(listOf(BondedDevice(null, "0"))),
            check(listOf(headset)),
            check(listOf(sledA, sledB)),
            check(listOf(sledA, BondedDevice(sledA.name, "2")), saved = sledA.address),
        )
        val sentences = setOf(
            SledWords.BLUETOOTH_OFF,
            SledWords.PERMISSION_MISSING,
            SledWords.NAMELESS_DEVICE,
            SledWords.NO_SLED_PAIRED,
            SledWords.SEVERAL_PAIRED,
            SledWords.duplicateName(sledA.name!!),
        )
        for (result in refusals) {
            val failed = (result as Precheck.Refused).failed
            assertEquals(failed.reason, true, failed.reason in sentences)
            assertEquals(failed.reason, false, failed.retryable)
            assertEquals(failed.reason, emptyList<String>(), sledWordsViolations(failed.reason))
        }
        assertEquals(sentences, refusals.map { (it as Precheck.Refused).failed.reason }.toSet())
    }
}
