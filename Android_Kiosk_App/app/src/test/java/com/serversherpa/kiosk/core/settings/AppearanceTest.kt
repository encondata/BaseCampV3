package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class AppearanceTest {
    @Test fun defaults() {
        assertEquals(Hsl(150.0, 60.0, 45.0), DEFAULT_APPEARANCE.goodScan)
        assertEquals(Hsl(0.0, 70.0, 50.0), DEFAULT_APPEARANCE.notFoundScan)
        assertEquals(Hsl(38.0, 92.0, 50.0), DEFAULT_APPEARANCE.duplicateScan)
        assertEquals(350, DEFAULT_APPEARANCE.flashMs)
    }

    @Test fun parsePerFieldFallback() {
        val a = parseAppearance("""{"good_scan":{"h":10,"s":20,"l":30},"not_found_scan":{"h":999,"s":1,"l":1},"flash_ms":5000}""")
        assertEquals(Hsl(10.0, 20.0, 30.0), a.goodScan)
        assertEquals(DEFAULT_APPEARANCE.notFoundScan, a.notFoundScan)   // out of range → default
        assertEquals(DEFAULT_APPEARANCE.duplicateScan, a.duplicateScan) // missing → default
        assertEquals(2000, a.flashMs)                                    // clamped
        assertEquals(DEFAULT_APPEARANCE, parseAppearance(null))
        assertEquals(DEFAULT_APPEARANCE, parseAppearance("not json"))
    }

    @Test fun roundTrip() {
        val a = DEFAULT_APPEARANCE.copy(flashMs = 700, goodScan = Hsl(1.0, 2.0, 3.0))
        assertEquals(a, parseAppearance(a.toJson()))
    }

    @Test fun hslConversion() {
        assertEquals(0xFF2EB873.toInt(), hslToArgb(Hsl(150.0, 60.0, 45.0)))
        assertEquals(0xFFD92626.toInt(), hslToArgb(Hsl(0.0, 70.0, 50.0)))
        assertEquals("hsl(150 60% 45%)", hslCss(Hsl(150.0, 60.0, 45.0)))
    }

    @Test fun clamp() {
        assertEquals(100, clampFlashMs(3))
        assertEquals(2000, clampFlashMs(99999))
        assertEquals(350, clampFlashMs(null))
    }
}
