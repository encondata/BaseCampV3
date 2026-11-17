package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A long hint never wraps the scan box onto a second line (Jimmy, on the Pixel with the camera button). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScanInputWrapTest {
    private val compose = createComposeRule()
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    private fun heights(placeholder: String): Pair<Int, Int> {
        compose.setContent {
            KioskTheme {
                Column {
                    Box(Modifier.testTag("short")) { ScanInput("", {}, {}, placeholder = "Scan", keepFocus = false, trailingIcon = { CameraFieldButton(true) {} }) }
                    Box(Modifier.testTag("long")) { ScanInput("", {}, {}, placeholder = placeholder, keepFocus = false, trailingIcon = { CameraFieldButton(true) {} }) }
                }
            }
        }
        return compose.onNodeWithTag("short").fetchSemanticsNode().size.height to
            compose.onNodeWithTag("long").fetchSemanticsNode().size.height
    }

    @Test @Config(qualifiers = "w443dp-h900dp-xxhdpi") fun longHintStaysOneLineOnThePixel() {
        val (short, long) = heights("Scan or type an asset tag, serial, RFID, or name")
        assertEquals("a long hint must not make the box taller", short, long)
    }

    @Test @Config(qualifiers = "w443dp-h900dp-xxhdpi", fontScale = 1.3f) fun longHintStaysOneLineWithLargerText() {
        val (short, long) = heights("Scan or type an asset tag, serial, RFID, or name")
        assertEquals("a long hint must not make the box taller", short, long)
    }

    @Test @Config(qualifiers = "w320dp-h640dp-hdpi") fun longHintStaysOneLineOnTheMc2200() {
        val (short, long) = heights("Scan or type an asset tag, serial, RFID, or name")
        assertEquals("a long hint must not make the box taller", short, long)
    }
}
