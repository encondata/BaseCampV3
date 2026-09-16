package com.serversherpa.kiosk.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import com.serversherpa.kiosk.core.settings.Hsl
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ComponentsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun scanInputSubmitsTrimmedValueOnImeActionAndClears() {
        var submitted = ""
        compose.setContent {
            KioskTheme {
                var v by remember { mutableStateOf("") }
                ScanInput(value = v, onValueChange = { v = it }, onSubmit = { submitted = it; v = "" }, placeholder = "Scan")
            }
        }
        compose.onNodeWithTag("scan-input").performTextInput("  A-100 ")
        compose.onNodeWithTag("scan-input").performImeAction()
        assertEquals("A-100", submitted)
    }

    @Test fun scanInputCarriesTheCameraInsideTheBox() {
        var opened = 0
        compose.setContent {
            KioskTheme {
                ScanInput(value = "", onValueChange = {}, onSubmit = {}, placeholder = "Scan",
                    trailingIcon = { CameraFieldButton(enabled = true) { opened++ } })
            }
        }
        compose.onNodeWithContentDescription("Scan with the camera").performClick()
        assertEquals(1, opened)
    }

    @Test fun segmentedSelects() {
        var selected = "a"
        compose.setContent { KioskTheme { Segmented(listOf("a" to "Alpha", "b" to "Beta"), selected) { selected = it } } }
        compose.onNodeWithText("Beta").performClick()
        assertEquals("b", selected)
    }

    @Test fun hslPickerShowsReadoutAndPreviewFires() {
        var previews = 0
        compose.setContent { KioskTheme { HslPicker("Good scan flash", Hsl(150.0, 60.0, 45.0), onChange = {}, onPreview = { previews++ }) } }
        compose.onNodeWithText("hsl(150 60% 45%)").assertIsDisplayed()
        compose.onNodeWithText("Preview flash").performClick()
        assertEquals(1, previews)
    }

    @Test fun placeholderCard() {
        compose.setContent { KioskTheme { PlaceholderCard("This feature is not available yet.", "Back to home") {} } }
        compose.onNodeWithText("This feature is not available yet.").assertIsDisplayed()
    }
}
