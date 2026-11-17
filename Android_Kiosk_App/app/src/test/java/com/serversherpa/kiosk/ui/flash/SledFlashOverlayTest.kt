package com.serversherpa.kiosk.ui.flash

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.rfid.SLED_FLASH_FADE_MS
import com.serversherpa.kiosk.core.rfid.SLED_FLASH_HOLD_MS
import com.serversherpa.kiosk.core.rfid.SledFlash
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.settings.Appearance
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.Hsl
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The full-screen sled flashes (task H7): the sentence on the kiosk's configured scan-flash
 * color, a tap dismissing it (and going no further), clearing after the hold and the fade, a
 * newer flash replacing an older one, and the sentences fitting a 320 dp phone.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class SledFlashOverlayTest {
    private val compose = createComposeRule()

    // Waits out a font copy before a native-graphics test (see NativeFontsSettled).
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    /** Distinct from the defaults, so the colors seen can only be the configured ones. */
    private val look = DEFAULT_APPEARANCE.copy(goodScan = Hsl(120.0, 100.0, 25.0), notFoundScan = Hsl(240.0, 100.0, 50.0))

    private class Rig {
        val flashes = MutableSharedFlow<SledFlash>(extraBufferCapacity = 8)
        var taps = 0
        var view: View? = null
    }

    private fun show(appearance: Appearance = look): Rig {
        val rig = Rig()
        compose.setContent {
            rig.view = LocalView.current
            KioskTheme {
                Box(Modifier.fillMaxSize()) {
                    Button(onClick = { rig.taps++ }, modifier = Modifier.fillMaxSize()) { Text("underneath") }
                    SledFlashOverlay(rig.flashes, MutableStateFlow(appearance))
                }
            }
        }
        compose.waitUntil(5_000) { rig.flashes.subscriptionCount.value > 0 }
        return rig
    }

    private fun Rig.emit(flash: SledFlash) {
        assertTrue(flashes.tryEmit(flash))
        compose.waitForIdle()
    }

    private fun count(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    /** The color at the screen's corner, where no text is drawn. The view is drawn to a bitmap
     *  (captureToImage waits on a frame callback Robolectric never sends). */
    private fun Rig.cornerArgb(): Int {
        val v = view!!
        val shot = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { v.draw(Canvas(shot)) }
        return shot.getPixel(2, 2)
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun aDropShowsSledDisconnectedOnTheNotFoundColor() {
        val rig = show()
        compose.mainClock.autoAdvance = false
        rig.emit(SledFlash.DROPPED)
        compose.mainClock.advanceTimeBy(100)
        compose.onNodeWithText(SledWords.FLASH_DISCONNECTED).assertIsDisplayed()
        assertEquals(hslToArgb(look.notFoundScan), rig.cornerArgb())
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun readyShowsReadyToScanOnTheGoodColor() {
        val rig = show()
        compose.mainClock.autoAdvance = false
        rig.emit(SledFlash.READY)
        compose.mainClock.advanceTimeBy(100)
        compose.onNodeWithText(SledWords.FLASH_READY).assertIsDisplayed()
        assertEquals(hslToArgb(look.goodScan), rig.cornerArgb())
    }

    @Test fun aTapDismissesItAndGoesNoFurther() {
        val rig = show()
        rig.emit(SledFlash.READY)
        compose.onNodeWithTag(SLED_FLASH_TAG).performClick()
        compose.waitForIdle()
        assertEquals(0, count(SledWords.FLASH_READY))
        assertEquals("the tap was the overlay's", 0, rig.taps)
        // Gone, the screen underneath takes taps again.
        compose.onNodeWithText("underneath").performClick()
        assertEquals(1, rig.taps)
    }

    @Test fun itClearsAfterTheHoldAndTheFade() {
        val rig = show()
        compose.mainClock.autoAdvance = false
        rig.emit(SledFlash.DROPPED)
        compose.mainClock.advanceTimeBy(SLED_FLASH_HOLD_MS - 100L)
        assertEquals("held", 1, count(SledWords.FLASH_DISCONNECTED))
        compose.mainClock.advanceTimeBy(100L + SLED_FLASH_FADE_MS / 2)
        assertEquals("fading", 1, count(SledWords.FLASH_DISCONNECTED))
        compose.mainClock.advanceTimeBy(SLED_FLASH_FADE_MS + 100L)
        assertEquals("gone", 0, count(SledWords.FLASH_DISCONNECTED))
    }

    @Test fun aNewerFlashReplacesTheOneShowing() {
        val rig = show()
        compose.mainClock.autoAdvance = false
        rig.emit(SledFlash.DROPPED)
        compose.mainClock.advanceTimeBy(SLED_FLASH_HOLD_MS - 200L)
        rig.emit(SledFlash.READY)
        compose.mainClock.advanceTimeBy(100)
        assertEquals(0, count(SledWords.FLASH_DISCONNECTED))
        assertEquals(1, count(SledWords.FLASH_READY))
        // The newer one holds for its own full time, not what was left of the older one's.
        compose.mainClock.advanceTimeBy(SLED_FLASH_HOLD_MS - 200L)
        assertEquals(1, count(SledWords.FLASH_READY))
        compose.mainClock.advanceTimeBy(SLED_FLASH_FADE_MS + 300L)
        assertEquals(0, count(SledWords.FLASH_READY))
    }

    @Test fun nothingShowsUntilAFlashArrives() {
        show()
        compose.waitForIdle()
        compose.onNodeWithTag(SLED_FLASH_TAG).assertDoesNotExist()
        assertFalse(count(SledWords.FLASH_READY) > 0 || count(SledWords.FLASH_DISCONNECTED) > 0)
    }

    /** Native graphics: the legacy mode measures text at almost no width, so nothing would overflow. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers = "w320dp-h533dp-hdpi") fun bothSentencesFitAt320dp() {
        val rig = show()
        compose.mainClock.autoAdvance = false
        val width = compose.onRoot().fetchSemanticsNode().size.width
        for ((flash, text) in listOf(SledFlash.DROPPED to SledWords.FLASH_DISCONNECTED, SledFlash.READY to SledWords.FLASH_READY)) {
            rig.emit(flash)
            compose.mainClock.advanceTimeBy(100)
            val n = compose.onNodeWithText(text).fetchSemanticsNode()
            val left = n.positionInRoot.x
            val right = left + n.size.width
            assertTrue("$text past the edge: $left..$right of $width", left >= 0f && right <= width + 1f)
            assertTrue("$text clipped: ${n.boundsInRoot.width} < ${n.size.width}", n.boundsInRoot.width >= n.size.width - 1f)
            // Wrapped between words only: no word is broken to fit.
            val layouts = mutableListOf<TextLayoutResult>()
            n.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(layouts)
            val layout = layouts.single()
            for (line in 0 until layout.lineCount - 1) {
                val end = layout.getLineEnd(line)
                assertTrue("$text breaks a word at $end", text[end - 1] == ' ' || text[end] == ' ')
            }
        }
    }
}
