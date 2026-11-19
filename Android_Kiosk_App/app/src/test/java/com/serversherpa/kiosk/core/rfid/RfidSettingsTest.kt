package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RfidSettingsTest {
    @Test fun defaultsMatchTheSpec() {
        val d = DEFAULT_RFID_SETTINGS
        assertEquals(false, d.enabled)
        assertEquals(RfidTriggerMode.HOLD, d.triggerMode)
        assertEquals(RepeatSweepPolicy.ALWAYS_QUEUE, d.repeatPolicy)
        assertEquals(SledBeeper.MEDIUM, d.beeper)
        assertEquals(27, d.powerDbm)
        assertEquals(RfidSession.S1, d.session)
        assertEquals(30, d.tagPopulation)
        assertEquals(true, d.uniqueTagReport)
        assertEquals(true, d.dpo)
        assertEquals(null, d.region)
        assertEquals(SledTriggerLayout.RFID, d.triggerLayout)
        assertEquals(null, d.readerAddress)
    }

    @Test fun roundTripsThroughJson() {
        val s = RfidSettings(
            enabled = true, triggerMode = RfidTriggerMode.TOGGLE, repeatPolicy = RepeatSweepPolicy.SKIP_AND_COUNT,
            beeper = SledBeeper.OFF, powerDbm = 12, session = RfidSession.S2, tagPopulation = 200,
            uniqueTagReport = false, dpo = false, region = "USA",
            triggerLayout = SledTriggerLayout.SPLIT, readerAddress = "00:11:22:33:44:55",
        )
        assertEquals(s, parseRfidSettings(s.toJson()))
    }

    @Test fun junkAndMissingFieldsFallBackToTheDefaults() {
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings(null))
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings("not json"))
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings("{}"))
        // An unknown enum value is not a reason to lose the rest of the settings.
        val partial = parseRfidSettings(
            """{"enabled":true,"triggerMode":"nonsense","powerDbm":19,""" +
                """"triggerLayout":"nonsense","readerAddress":17}""",
        )
        assertEquals(true, partial.enabled)
        assertEquals(RfidTriggerMode.HOLD, partial.triggerMode)
        assertEquals(19, partial.powerDbm)
        assertEquals(SledTriggerLayout.RFID, partial.triggerLayout)
        assertEquals(null, partial.readerAddress)
    }

    /** A kiosk that had "Trigger drives: Barcode" comes up in the Barcode layout (ruling 16). */
    @Test fun anOldTriggerPersonalityOfBarcodeReadsAsTheBarcodeLayout() {
        assertEquals(SledTriggerLayout.BARCODE, parseRfidSettings("""{"triggerPersonality":"barcode"}""").triggerLayout)
        assertEquals(SledTriggerLayout.RFID, parseRfidSettings("""{"triggerPersonality":"rfid"}""").triggerLayout)
    }

    @Test fun triggerLayoutWinsOverTheOldKey() {
        val s = parseRfidSettings("""{"triggerLayout":"split","triggerPersonality":"barcode"}""")
        assertEquals(SledTriggerLayout.SPLIT, s.triggerLayout)
        val rfid = parseRfidSettings("""{"triggerLayout":"rfid","triggerPersonality":"barcode"}""")
        assertEquals(SledTriggerLayout.RFID, rfid.triggerLayout)
    }

    @Test fun anUnknownTriggerLayoutFallsBackToTheOldKeyThenTheDefault() {
        assertEquals(
            SledTriggerLayout.BARCODE,
            parseRfidSettings("""{"triggerLayout":"sideways","triggerPersonality":"barcode"}""").triggerLayout,
        )
        assertEquals(
            SledTriggerLayout.RFID,
            parseRfidSettings("""{"triggerLayout":"sideways","triggerPersonality":"sideways"}""").triggerLayout,
        )
        assertEquals(SledTriggerLayout.RFID, parseRfidSettings("""{"triggerLayout":"sideways"}""").triggerLayout)
    }

    /** Documents from before this build still carry the removed keys; they are ignored. */
    @Test fun oldDocumentsWithRemovedKeysStillParse() {
        val s = parseRfidSettings("""{"scannerPluginMode":"on","ledOnRead":false,"powerDbm":20}""")
        assertEquals(20, s.powerDbm)
        assertEquals(DEFAULT_RFID_SETTINGS.copy(powerDbm = 20), s)
    }

    @Test fun jsonOmitsReaderAddressWhenNull() {
        val json = DEFAULT_RFID_SETTINGS.toJson()
        assertTrue(json, json.contains("\"triggerLayout\":\"rfid\""))
        assertFalse(json, json.contains("readerAddress"))
        assertFalse(json, json.contains("triggerPersonality"))
        assertFalse(json, json.contains("scannerPluginMode"))
        assertFalse(json, json.contains("ledOnRead"))
        val withAddress = DEFAULT_RFID_SETTINGS.copy(readerAddress = "00:11:22:33:44:55").toJson()
        assertTrue(withAddress, withAddress.contains("\"readerAddress\":\"00:11:22:33:44:55\""))
    }

    /** A saved file from an older build, or a slider bug, must not ask the
     *  reader for an illegal power. */
    @Test fun outOfRangeNumbersAreClamped() {
        assertEquals(RFID_POWER_MAX, parseRfidSettings("""{"powerDbm":99}""").powerDbm)
        assertEquals(RFID_POWER_MIN, parseRfidSettings("""{"powerDbm":-4}""").powerDbm)
        assertEquals(RFID_POPULATION_MAX, parseRfidSettings("""{"tagPopulation":99999}""").tagPopulation)
        assertEquals(RFID_POPULATION_MIN, parseRfidSettings("""{"tagPopulation":0}""").tagPopulation)
    }

    @Test fun powerConvertsToTheTenthsOfADbmTheSdkWants() {
        assertEquals(270, powerToTenths(27))
        assertEquals(50, powerToTenths(5))
        assertEquals(300, powerToTenths(99))
    }

    /** A field holding a JSON object must fall back to its default, and must not
     *  take the rest of the document down with it. */
    @Test fun objectValuedFieldFallsBackWithoutLosingOtherFields() {
        val result = parseRfidSettings("""{"enabled":{"nested":true},"powerDbm":19}""")
        assertEquals(DEFAULT_RFID_SETTINGS.enabled, result.enabled)
        assertEquals(19, result.powerDbm)
    }

    /** Same as above, but for a JSON array value instead of an object. */
    @Test fun arrayValuedFieldFallsBackWithoutLosingOtherFields() {
        val result = parseRfidSettings("""{"enabled":[1,2,3],"powerDbm":21}""")
        assertEquals(DEFAULT_RFID_SETTINGS.enabled, result.enabled)
        assertEquals(21, result.powerDbm)
    }

    /** A quoted "true" is a string, not a boolean, and must not be accepted. */
    @Test fun quotedBooleanFallsBackToTheDefault() {
        val result = parseRfidSettings("""{"enabled":"true"}""")
        assertEquals(DEFAULT_RFID_SETTINGS.enabled, result.enabled)
    }
}
