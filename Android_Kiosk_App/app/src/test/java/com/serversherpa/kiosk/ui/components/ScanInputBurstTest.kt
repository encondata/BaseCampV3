package com.serversherpa.kiosk.ui.components

import android.view.InputDevice
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Scans typed by a keyboard-mode (HID) scanner with no gap at all between them: every key of
 * every scan, Enters included, is handled before the screen draws again. Each scan must still be
 * submitted exactly as typed, never joined to the one before it (seen on the Pixel with a
 * DS2278: "1F28DBE1C1F28DBE1C").
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanInputBurstTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    /** The screen as the app's screens hold it: a view model's StateFlow, cleared on submit. */
    private val screen = MutableStateFlow("")
    private val submitted = mutableListOf<String>()

    private fun show() {
        compose.setContent {
            KioskTheme {
                val value by screen.collectAsState()
                ScanInput(value, onValueChange = { screen.value = it },
                    onSubmit = { submitted += it; screen.value = "" }, placeholder = "Scan", keepFocus = false)
            }
        }
        compose.onNodeWithTag("scan-input").performClick()
        compose.waitForIdle()
    }

    private fun code(ch: Char): Int = when (ch) {
        in '0'..'9' -> KeyEvent.KEYCODE_0 + (ch - '0')
        in 'a'..'z' -> KeyEvent.KEYCODE_A + (ch - 'a')
        '\n' -> KeyEvent.KEYCODE_ENTER
        else -> error("no key for $ch")
    }

    /** Every key of [text], down and up, in one go on the main thread: nothing redraws in between.
     *  Each key goes the way Android sends a hardware key: offered to the views before the
     *  on-screen keyboard app ([preIme]), then, if nothing took it there, dispatched as usual. */
    private fun burst(text: String, preIme: Boolean = true) {
        compose.runOnUiThread {
            val decor = compose.activity.window.decorView
            text.forEach { ch ->
                listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP).forEach { action ->
                    val key = KeyEvent(0L, 0L, action, code(ch), 0, 0, 7, 0, 0, InputDevice.SOURCE_KEYBOARD)
                    if (!(preIme && decor.dispatchKeyEventPreIme(key))) compose.activity.dispatchKeyEvent(key)
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun hardwareKeysAreTakenBeforeTheKeyboardApp() {
        show()
        var taken = false
        compose.runOnUiThread {
            taken = compose.activity.window.decorView.dispatchKeyEventPreIme(
                KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A, 0, 0, 7, 0, 0, InputDevice.SOURCE_KEYBOARD))
        }
        compose.waitForIdle()
        assertEquals("a scanner's key must not reach the keyboard app", true, taken)
        assertEquals("a", boxText())
    }

    @Test fun backToBackScansAreWholeOnTheTextFieldsOwnKeyPathToo() {
        show()
        burst("1f28dbe1c\n".repeat(5), preIme = false)
        assertEquals(List(5) { "1f28dbe1c" }, submitted)
    }

    private fun boxText(): String =
        compose.onNodeWithTag("scan-input").fetchSemanticsNode().config[SemanticsProperties.EditableText].text

    @Test fun backToBackScansAreEachSubmittedWhole() {
        show()
        burst("1f28dbe1c\n".repeat(5))
        assertEquals(List(5) { "1f28dbe1c" }, submitted)
        assertEquals("", boxText())
    }

    @Test fun aScanThatStartsLikeTheLastOneIsNotCutShort() {
        show()
        burst("1f2\n1f28dbe1c\n")
        assertEquals(listOf("1f2", "1f28dbe1c"), submitted)
    }

    @Test fun keysAfterABurstLandInAnEmptyBox() {
        show()
        burst("ab12\ncd")
        assertEquals(listOf("ab12"), submitted)
        assertEquals("cd", boxText())
    }
}
