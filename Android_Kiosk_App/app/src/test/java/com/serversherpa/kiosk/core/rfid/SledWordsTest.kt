package com.serversherpa.kiosk.core.rfid

import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every sentence an operator reads about the sled (spec, Words). */
class SledWordsTest {
    /** Every static String on [SledWords], by name. */
    private fun constants(): Map<String, String> =
        SledWords::class.java.declaredFields
            .filter { Modifier.isStatic(it.modifiers) && it.type == String::class.java }
            .associate { field ->
                field.isAccessible = true
                field.name to field.get(null) as String
            }

    private val name = "RFD4031-G10B700-US"
    private val keyPairs = SledKey.entries.flatMap { upper -> SledKey.entries.map { lower -> upper to lower } }
    private val rowLabels = listOf(
        SledWords.ROW_SLED_BEEPER, SledWords.ROW_TRANSMIT_POWER, SledWords.ROW_TAG_POPULATION,
        SledWords.ROW_UNIQUE, SledWords.ROW_DPO,
    )

    /** What every sentence function says for representative inputs. */
    private fun functionOutputs(): List<String> = buildList {
        add(SledWords.connected(name, 74)); add(SledWords.connected(name, null))
        add(SledWords.connectingTo(name)); add(SledWords.connectingTo(null))
        add(SledWords.couldNotReach(name)); add(SledWords.couldNotReach(null))
        add(SledWords.couldNotReach(name, severalPaired = true)); add(SledWords.couldNotReach(null, severalPaired = true))
        add(SledWords.duplicateName(name)); add(SledWords.noRegion(name))
        for (layout in SledTriggerLayout.entries) add(SledWords.hint(layout))
        for ((upper, lower) in keyPairs) {
            add(SledWords.reports(readbackOf(upper, lower, null)))
            add(SledWords.didNotTake(readbackOf(upper, lower, null)))
        }
        add(SledWords.refused(listOf("Transmit power", "Tag population")))
        add(SledWords.refused(rowLabels))
        add(SledWords.refused(rowLabels, othersApplied = false))
        for (label in rowLabels) add(SledWords.refused(listOf(label)))
        add(SledWords.refused(emptyList()))
        add(SledWords.powerCap(27))
        add(SledWords.activeRegion("ETSI"))
        add(SledWords.enrollOtherAssetId("Dell R740")); add(SledWords.enrollOtherAssetId(null))
        add(SledWords.enrollOtherSerial("Dell R740")); add(SledWords.enrollOtherSerial(null))
    }

    private val everyState = listOf(
        RfidConnection.Disabled, RfidConnection.Disconnected, RfidConnection.Connecting,
        RfidConnection.Connected(name, 74), RfidConnection.Connected(name, null),
        RfidConnection.NeedsRegion(name),
        RfidConnection.Failed(SledWords.couldNotReach(name), retryable = true, fix = SledFix.CONNECT),
    )

    @Test fun noOperatorSentenceNamesTheSdk() {
        val constants = constants()
        assertTrue("reflection found SledWords' constants", constants.size > 50)
        assertTrue(constants.containsKey("BATCH_MODE_UNRECOVERABLE_MESSAGE"))
        val texts = constants.filterKeys { it != "ROW_SESSION" }.values +
            functionOutputs() +
            everyState.map { connectionLine(it) }
        val problems = texts.mapNotNull { text ->
            sledWordsViolations(text).takeIf { it.isNotEmpty() }?.let { "$it in: $text" }
        }
        assertEquals(emptyList<String>(), problems)
    }

    @Test fun theSessionRowLabelIsTheOneAllowedUse() {
        assertEquals("Session", SledWords.ROW_SESSION)
        assertEquals(listOf("session"), sledWordsViolations(SledWords.ROW_SESSION))
        assertEquals(emptyList<String>(), sledWordsViolations(SledWords.ROW_SESSION, allowSessionLabel = true))
        assertEquals(
            emptyList<String>(),
            sledWordsViolations(SledWords.refused(listOf(SledWords.ROW_SESSION)), allowSessionLabel = true),
        )
    }

    @Test fun theCheckCatchesEveryForbiddenToken() {
        assertEquals(listOf("RFID_"), sledWordsViolations("Failed with RFID_API_COMMAND_TIMEOUT."))
        assertEquals(listOf("DCSSDK_", "SDK"), sledWordsViolations("DCSSDK_RESULT_FAILURE"))
        assertEquals(listOf("ENUM_"), sledWordsViolations("ENUM_TRANSPORT.BLUETOOTH"))
        // The result-name prefixes are matched case-sensitively.
        assertEquals(emptyList<String>(), sledWordsViolations("rfid_ enum_"))
        for (word in listOf("the sdk", "Key Layout", "a session", "the imager", "the Plugin", "a read-back", "hid")) {
            assertEquals(word, 1, sledWordsViolations(word).size)
        }
        assertEquals(emptyList<String>(), sledWordsViolations("Upper and lower triggers read tags."))
    }

    @Test fun todaysPinnedSentencesAreByteForByte() {
        assertEquals(
            "Android needs Bluetooth and location permission before the sled can connect. Grant them in this app's settings.",
            SledWords.PERMISSION_MISSING,
        )
        assertEquals("Open app settings", SledWords.OPEN_APP_SETTINGS)
        assertEquals("Off. Turn the reader on to use the sled.", SledWords.OFF)
        assertEquals("Not connected.", SledWords.NOT_CONNECTED)
        assertEquals("Connecting…", SledWords.CONNECTING)
        assertEquals("Connected to RFD4030 · battery 74%", SledWords.connected("RFD4030", 74))
        assertEquals("Connected to RFD4030", SledWords.connected("RFD4030", null))
    }

    @Test fun refusedNamesEachRowLabel() {
        assertEquals(
            "The sled didn't accept: transmit power. The other settings were applied.",
            SledWords.refused(listOf("Transmit power")),
        )
        assertEquals(
            "The sled didn't accept: sled beeper and transmit power. The other settings were applied.",
            SledWords.refused(listOf("Sled beeper", "Transmit power")),
        )
        assertEquals(
            "The sled didn't accept: sled beeper, transmit power, and tag population. The other settings were applied.",
            SledWords.refused(listOf("Sled beeper", "Transmit power", "Tag population")),
        )
        assertEquals(
            "The sled didn't accept: report each tag once.",
            SledWords.refused(listOf(SledWords.ROW_UNIQUE), othersApplied = false),
        )
        assertEquals(SledWords.SETTINGS_NOT_APPLIED, SledWords.refused(emptyList()))
    }

    @Test fun couldNotReachNamesTheSledOrSaysTheSled() {
        assertEquals(
            "Couldn't reach RFD4031. Make sure it is on, charged and close by, then tap Connect.",
            SledWords.couldNotReach("RFD4031"),
        )
        assertTrue(SledWords.couldNotReach("RFD4031").startsWith("Couldn't reach RFD4031."))
        assertTrue(SledWords.couldNotReach(null).startsWith("Couldn't reach the sled."))
        val several = SledWords.couldNotReach(null, severalPaired = true)
        assertTrue(several.endsWith(" " + SledWords.USE_A_DIFFERENT_SLED))
        assertEquals(SledWords.couldNotReach(null) + " " + SledWords.USE_A_DIFFERENT_SLED, several)
        assertEquals("Connecting to RFD4031…", SledWords.connectingTo("RFD4031"))
        assertEquals("Connecting to the sled…", SledWords.connectingTo(null))
    }

    @Test fun reportsBuildsTheThreeHintsExactly() {
        assertEquals("Upper and lower triggers read tags.", SledWords.hint(SledTriggerLayout.RFID))
        assertEquals("Upper and lower triggers scan barcodes.", SledWords.hint(SledTriggerLayout.BARCODE))
        assertEquals("Upper trigger reads tags. Lower trigger scans barcodes.", SledWords.hint(SledTriggerLayout.SPLIT))
        assertEquals(
            "Upper trigger reads tags. Lower trigger is not assigned.",
            SledWords.reports(readbackOf(SledKey.RFID, SledKey.TERMINAL_SCAN, 6)),
        )
        // 28 is NO_ACTION / NO_ACTION by the value rule (upper * 5 + 4 + lower).
        assertEquals(
            "Upper and lower triggers are not assigned.",
            SledWords.reports(readbackOf(SledKey.NO_ACTION, SledKey.NO_ACTION, 28)),
        )
        assertEquals(
            "Upper trigger scans barcodes. Lower trigger reads tags.",
            SledWords.reports(readbackOf(SledKey.SLED_SCAN, SledKey.RFID, 9)),
        )
        assertEquals(
            "The sled didn't take that. It is set to: Upper trigger reads tags. Lower trigger is not assigned.",
            SledWords.didNotTake(readbackOf(SledKey.RFID, SledKey.TERMINAL_SCAN, 6)),
        )
    }

    @Test fun theBatchMessageKeepsItsPinnedPhrases() {
        val message = SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE
        assertTrue(message.contains("123RFID Mobile"))
        assertTrue(message.contains("one-time"))
        assertTrue(message.contains("should not return to this state"))
        assertTrue(message.contains("earlier offline use"))
        assertFalse(message.contains("session", ignoreCase = true))
        assertTrue(message.endsWith("."))
    }

    @Test fun enrollSentencesUseTheAssetNameOrAnotherAsset() {
        assertEquals("That's the asset ID for Dell R740, not an RFID tag.", SledWords.enrollOtherAssetId("Dell R740"))
        assertEquals("That's the asset ID for another asset, not an RFID tag.", SledWords.enrollOtherAssetId(null))
        assertEquals("That's the serial for Dell R740, not an RFID tag.", SledWords.enrollOtherSerial("Dell R740"))
        assertEquals("That's the serial for another asset, not an RFID tag.", SledWords.enrollOtherSerial(null))
        assertEquals("That's this asset's own asset ID, not an RFID tag.", SledWords.ENROLL_OWN_ASSET_ID)
        assertEquals("That's this asset's own serial, not an RFID tag.", SledWords.ENROLL_OWN_SERIAL)
    }

    @Test fun connectionLineHasASentenceForEveryState() {
        assertEquals(SledWords.noRegion("RFD4031"), connectionLine(RfidConnection.NeedsRegion("RFD4031")))
        assertEquals(
            "RFD4031 has no region set, so it can't read tags. An admin sets it in Settings › Admin.",
            SledWords.noRegion("RFD4031"),
        )
        assertEquals(SledWords.OFF, connectionLine(RfidConnection.Disabled))
        assertEquals(SledWords.NOT_CONNECTED, connectionLine(RfidConnection.Disconnected))
        assertEquals(SledWords.CONNECTING, connectionLine(RfidConnection.Connecting))
        assertEquals(SledWords.connected("RFD4031", 74), connectionLine(RfidConnection.Connected("RFD4031", 74)))
        assertEquals(SledWords.PASSWORD, connectionLine(RfidConnection.Failed(SledWords.PASSWORD)))
        for (state in everyState) assertTrue("$state reads as a sentence", connectionLine(state).isNotBlank())
    }
}
