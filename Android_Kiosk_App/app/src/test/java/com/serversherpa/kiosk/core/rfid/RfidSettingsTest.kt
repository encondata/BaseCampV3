package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
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
        assertEquals(true, d.ledOnRead)
        assertEquals(true, d.dpo)
        assertEquals(null, d.region)
    }

    @Test fun roundTripsThroughJson() {
        val s = RfidSettings(
            enabled = true, triggerMode = RfidTriggerMode.TOGGLE, repeatPolicy = RepeatSweepPolicy.SKIP_AND_COUNT,
            beeper = SledBeeper.OFF, powerDbm = 12, session = RfidSession.S2, tagPopulation = 200,
            uniqueTagReport = false, ledOnRead = false, dpo = false, region = "USA",
        )
        assertEquals(s, parseRfidSettings(s.toJson()))
    }

    @Test fun junkAndMissingFieldsFallBackToTheDefaults() {
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings(null))
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings("not json"))
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings("{}"))
        // An unknown enum value is not a reason to lose the rest of the settings.
        val partial = parseRfidSettings("""{"enabled":true,"triggerMode":"nonsense","powerDbm":19}""")
        assertEquals(true, partial.enabled)
        assertEquals(RfidTriggerMode.HOLD, partial.triggerMode)
        assertEquals(19, partial.powerDbm)
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
