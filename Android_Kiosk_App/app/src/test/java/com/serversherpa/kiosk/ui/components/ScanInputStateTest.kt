package com.serversherpa.kiosk.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A Bluetooth scanner in HID mode types a barcode faster than a screen's view model hands the
 * text back. The box must keep every character it was typed and submit all of them, however far
 * behind the screen's copy of the text is (the DS2278 dropped and cut-off scans).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanInputStateTest {
    @get:Rule val compose = createComposeRule()

    /** What the screen holds; the test decides when (and whether) it catches up. */
    private var screenValue by mutableStateOf("")
    private val reported = mutableListOf<String>()
    private val submitted = mutableListOf<String>()

    private fun show() {
        compose.setContent {
            KioskTheme {
                ScanInput(screenValue, onValueChange = { reported += it }, onSubmit = { submitted += it }, placeholder = "Scan", keepFocus = false)
            }
        }
    }

    private fun boxText(): String =
        compose.onNodeWithTag("scan-input").fetchSemanticsNode().config[SemanticsProperties.EditableText].text

    @Test fun aScreenOneKeyBehindLosesNothing() {
        show()
        val barcode = "SN-4C8F02A7"
        barcode.forEach { ch ->
            compose.onNodeWithTag("scan-input").performTextInput(ch.toString())
            // The screen catches up one keystroke late: it shows the text from before this key.
            screenValue = reported.getOrNull(reported.size - 2) ?: ""
            compose.waitForIdle()
        }
        assertEquals(barcode, boxText())
        compose.onNodeWithTag("scan-input").performImeAction()
        assertEquals(listOf(barcode), submitted)
    }

    @Test fun enterSubmitsWhatWasTypedBeforeTheScreenCaughtUp() {
        show()
        compose.onNodeWithTag("scan-input").performTextInput("A-100")
        // The screen has not caught up at all when the scanner's Enter arrives.
        compose.onNodeWithTag("scan-input").performImeAction()
        assertEquals(listOf("A-100"), submitted)
    }

    @Test fun aSubmitEmptiesTheBoxEvenWhenTheScreenNeverCaughtUp() {
        show()
        compose.onNodeWithTag("scan-input").performTextInput("ABC")
        compose.onNodeWithTag("scan-input").performImeAction()
        assertEquals(listOf("ABC"), submitted)
        assertEquals("the next scan must not be appended to this one", "", boxText())
    }

    @Test fun lateCopiesFromTheLastScanDoNotTouchTheNextOne() {
        show()
        compose.onNodeWithTag("scan-input").performTextInput("ABC")
        compose.onNodeWithTag("scan-input").performImeAction()
        compose.onNodeWithTag("scan-input").performTextInput("D")
        screenValue = "ABC"                   // the first scan's text, arriving late
        compose.waitForIdle()
        screenValue = ""                      // and the screen's clear after that submit
        compose.waitForIdle()
        assertEquals("D", boxText())
    }

    @Test fun theScreenCanStillSetOrClearTheBox() {
        show()
        compose.onNodeWithTag("scan-input").performTextInput("A-1")
        screenValue = "A-1"
        compose.waitForIdle()
        screenValue = ""                      // cleared after a submit
        compose.waitForIdle()
        assertEquals("", boxText())
        screenValue = "TAG 0042"              // a lookup shows what it searched for
        compose.waitForIdle()
        assertEquals("TAG 0042", boxText())
        compose.onNodeWithTag("scan-input").performTextInput("7")
        assertEquals("TAG 00427", boxText())
    }
}
