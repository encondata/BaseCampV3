package com.serversherpa.kiosk.nettest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure Internet Test model: Apple's presets, the saved settings, the two-hour expiry. */
class ModelTest {
    private fun profile(
        down: Int?, downMs: Int, downPct: Double,
        up: Int?, upMs: Int, upPct: Double,
        dnsMs: Int,
    ) = LinkProfile(down, up, downMs, upMs, downPct, upPct, dnsMs)

    @Test fun presetsMatchApple() {
        data class Row(val preset: Preset, val id: String, val label: String, val profile: LinkProfile?)
        val rows = listOf(
            Row(Preset.OFF, "off", "Off", null),
            Row(Preset.WIFI, "wifi", "Wi-Fi", profile(40_000, 1, 0.0, 33_000, 1, 0.0, 0)),
            Row(Preset.WIFI_AC, "wifi-ac", "Wi-Fi 802.11ac", profile(250_000, 1, 0.0, 100_000, 1, 0.0, 0)),
            Row(Preset.LTE, "lte", "LTE", profile(50_000, 50, 0.0, 10_000, 50, 0.0, 0)),
            Row(Preset.DSL, "dsl", "DSL", profile(2_000, 5, 0.05, 256, 5, 0.039, 0)),
            Row(Preset.THREE_G, "3g", "3G", profile(780, 100, 0.0, 330, 100, 0.0, 0)),
            Row(Preset.EDGE, "edge", "Edge", profile(240, 400, 0.0, 200, 400, 0.0, 0)),
            Row(Preset.VERY_BAD, "very-bad", "Very Bad Network", profile(1_000, 500, 10.0, 1_000, 500, 10.0, 0)),
            Row(Preset.HIGH_LATENCY_DNS, "high-latency-dns", "High Latency DNS", profile(null, 0, 0.0, null, 0, 0.0, 3_000)),
            Row(Preset.LOSS_100, "loss-100", "100% Loss", profile(null, 0, 100.0, null, 0, 100.0, 0)),
            Row(Preset.CUSTOM, "custom", "Custom", null),
        )
        assertEquals("every preset has a row", Preset.entries.toList(), rows.map { it.preset })
        for (row in rows) {
            assertEquals("${row.preset} id", row.id, row.preset.id)
            assertEquals("${row.preset} label", row.label, row.preset.label)
            assertEquals("${row.preset} profile", row.profile, row.preset.profile)
        }
        assertEquals(
            listOf(
                Preset.OFF, Preset.WIFI, Preset.WIFI_AC, Preset.LTE, Preset.DSL, Preset.THREE_G,
                Preset.EDGE, Preset.VERY_BAD, Preset.HIGH_LATENCY_DNS, Preset.LOSS_100, Preset.CUSTOM,
            ),
            Dial.INTERNET.presets,
        )
        assertEquals(
            listOf(Preset.OFF, Preset.WIFI, Preset.VERY_BAD, Preset.LOSS_100, Preset.CUSTOM),
            Dial.LOCAL.presets,
        )
    }

    @Test fun defaultCustomIsTheDocumentedStartingPoint() {
        assertEquals(LinkProfile(256, 128, 300, 300, 5.0, 5.0), DEFAULT_CUSTOM)
        assertEquals(0, DEFAULT_CUSTOM.dnsDelayMs)
        assertEquals(DEFAULT_CUSTOM, DialSetting().custom)
        assertEquals("off", DialSetting().preset)
    }

    @Test fun clampRules() {
        val wild = LinkProfile(
            downKbps = 0, upKbps = -5, downDelayMs = 90_000, upDelayMs = -1,
            downDropPct = 140.0, upDropPct = -2.0, dnsDelayMs = 70_000,
        )
        assertEquals(LinkProfile(null, null, 60_000, 0, 100.0, 0.0, 60_000), wild.clamped())
    }

    @Test fun clampKeepsGoodValuesAndCapsSpeed() {
        val fine = LinkProfile(1_000, 500, 250, 40, 12.5, 0.5, 1_500)
        assertEquals(fine, fine.clamped())
        val huge = LinkProfile(downKbps = 5_000_000, upKbps = 1_000_000)
        assertEquals(1_000_000, huge.clamped().downKbps)
        assertEquals(1_000_000, huge.clamped().upKbps)
        assertEquals(LinkProfile(), LinkProfile().clamped())
        // Edges: 1 kbps is a real limit; the delay and drop ceilings are inclusive.
        val edges = LinkProfile(1, 1, 60_000, 60_000, 100.0, 0.0, 60_000)
        assertEquals(edges, edges.clamped())
        assertEquals(0.0, LinkProfile(downDropPct = Double.NaN, upDropPct = Double.NaN).clamped().downDropPct, 0.0)
    }

    @Test fun everyPresetIsAlreadyWithinTheClampBounds() {
        for (p in Preset.entries) {
            val profile = p.profile ?: continue
            assertEquals("$p", profile, profile.clamped())
        }
    }

    @Test fun activeProfileRules() {
        val internet3g = InternetTestSettings(
            enabled = true,
            internet = DialSetting(preset = "3g"),
            local = DialSetting(preset = "off"),
        )
        assertEquals(Preset.THREE_G.profile, internet3g.activeProfile(Dial.INTERNET))
        assertNull(internet3g.activeProfile(Dial.LOCAL))

        // The switch off beats any preset, on both dials.
        val switchedOff = internet3g.copy(enabled = false, local = DialSetting(preset = "loss-100"))
        assertNull(switchedOff.activeProfile(Dial.INTERNET))
        assertNull(switchedOff.activeProfile(Dial.LOCAL))

        // Custom is clamped on the way out.
        val wild = LinkProfile(downKbps = 0, upKbps = -5, downDelayMs = 90_000, downDropPct = 140.0)
        val custom = InternetTestSettings(
            enabled = true,
            internet = DialSetting(preset = "custom", custom = wild),
            local = DialSetting(preset = "custom"),
        )
        assertEquals(wild.clamped(), custom.activeProfile(Dial.INTERNET))
        assertEquals(DEFAULT_CUSTOM.clamped(), custom.activeProfile(Dial.LOCAL))
        assertEquals(custom.internet, custom.dial(Dial.INTERNET))
        assertEquals(custom.local, custom.dial(Dial.LOCAL))
    }

    @Test fun roundTripAndCorruptJson() {
        val s = InternetTestSettings(
            enabled = true,
            armedAtMs = 1_760_000_000_000L,
            internet = DialSetting(preset = "custom", custom = LinkProfile(512, null, 120, 80, 2.5, 0.0, 900)),
            local = DialSetting(preset = "very-bad"),
        )
        assertEquals(s, InternetTestSettings.decode(s.encode()))
        assertEquals(InternetTestSettings(), InternetTestSettings.decode(InternetTestSettings().encode()))

        val defaults = InternetTestSettings()
        assertEquals(defaults, InternetTestSettings.decode("{not json"))
        assertEquals(defaults, InternetTestSettings.decode(null))
        assertEquals(defaults, InternetTestSettings.decode(""))
        assertEquals(defaults, InternetTestSettings.decode("[1,2,3]"))
        assertEquals(defaults, InternetTestSettings.decode("""{"enabled":"banana"}"""))

        val unknown = InternetTestSettings.decode(
            """{"enabled":true,"internet":{"preset":"zzz"},"local":{"preset":"wifi"}}""",
        )
        assertEquals("off", unknown.internet.preset)
        assertEquals("wifi", unknown.local.preset)
        assertTrue(unknown.enabled)
        assertNull(unknown.activeProfile(Dial.INTERNET))
        assertEquals(Preset.WIFI.profile, unknown.activeProfile(Dial.LOCAL))

        // Unknown keys from a newer build are ignored, not fatal.
        assertEquals(
            Preset.LTE.id,
            InternetTestSettings.decode("""{"future":1,"internet":{"preset":"lte","x":2}}""").internet.preset,
        )
    }

    @Test fun aPresetTheLocalDialDoesNotOfferReadsAsOff() {
        val s = InternetTestSettings.decode("""{"enabled":true,"local":{"preset":"3g"}}""")
        assertEquals("off", s.local.preset)
        assertNull(s.activeProfile(Dial.LOCAL))
    }

    @Test fun expiryRules() {
        assertTrue(isExpired(null, 5))
        assertFalse(isExpired(1_000, 1_000 + 7_199_999))
        assertTrue(isExpired(1_000, 1_000 + 7_200_000))
        // A clock moved backward counts as expired.
        assertTrue(isExpired(10_000, 9_999))
        // Armed and checked in the same instant is still live.
        assertFalse(isExpired(10_000, 10_000))
        assertEquals(7_200_000L, TEST_LIFETIME_MS)
        assertEquals(1_000L + 7_200_000L, turnsOffAtMs(1_000))
    }
}
