package com.serversherpa.kiosk.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The portal's status tones (styles/directory.css for light paper, portal-theme.css for dark). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TintedButtonTest {
    @get:Rule val compose = createComposeRule()

    @Test fun light_uses_the_portals_darker_tones() {
        assertEquals(Color(0xFF178A4C), ButtonTint.GREEN.colors(isDark = false).text)
        assertEquals(Color(0xFFC03540), ButtonTint.RED.colors(isDark = false).text)
    }

    @Test fun dark_uses_the_portals_bright_tones() {
        assertEquals(Color(0xFF3DDC84), ButtonTint.GREEN.colors(isDark = true).text)
        assertEquals(Color(0xFFFF5D6C), ButtonTint.RED.colors(isDark = true).text)
    }

    @Test fun clicks_like_a_mini_button() {
        var clicks = 0
        compose.setContent { KioskTheme { TintedButton("Mark read", { clicks++ }, ButtonTint.GREEN) } }
        compose.onNodeWithText("Mark read").assertIsEnabled().performClick()
        assertEquals(1, clicks)
    }

    @Test fun disables_like_a_mini_button() {
        compose.setContent { KioskTheme { TintedButton("Hide", {}, ButtonTint.RED, enabled = false) } }
        compose.onNodeWithText("Hide").assertIsNotEnabled()
    }
}
