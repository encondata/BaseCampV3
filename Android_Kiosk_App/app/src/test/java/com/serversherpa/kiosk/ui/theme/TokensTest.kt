package com.serversherpa.kiosk.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TokensTest {
    @Test fun namedAccents() {
        assertEquals(Color(0xFF35E0C8), accentFor("aqua").first)
        assertEquals(Color(0xFF6AF0DD), accentFor("aqua").second)
        assertEquals(Color(0xFF3DDC84), accentFor("GREEN").first)
    }

    @Test fun customHexAccent() {
        assertEquals(Color(0xFF123456), accentFor("#123456").first)
    }

    @Test fun unknownFallsBackToAmber() {
        assertEquals(Color(0xFFFFA12E), accentFor("mauve").first)
        assertEquals(Color(0xFFFFA12E), accentFor("#12").first)
    }
}
