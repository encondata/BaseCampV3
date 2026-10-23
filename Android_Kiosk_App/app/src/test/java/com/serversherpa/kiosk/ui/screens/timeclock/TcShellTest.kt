package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.screens.timeclock.flow.formatClock
import com.serversherpa.kiosk.ui.screens.timeclock.flow.formatHeaderDate
import com.serversherpa.kiosk.ui.screens.timeclock.screens.TcShell
import java.time.Instant
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Time Clock's header on the 320 dp MC2200, with real fonts (native graphics) at the system
 * font scale: the "ServerSherpa" wordmark shows whole (it read "ServerSher" when the date and time
 * shared its line), and nothing in the header is dropped: the logo's tagline, the date, the time
 * and (station Welcome) the gear all show inside the screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w320dp-h533dp-hdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TcShellTest {
    @get:Rule val compose = createComposeRule()
    private val c = testContainer()

    @After fun tearDown() {
        c.scope.cancel()
        c.db.close()
    }

    private fun layoutOf(text: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    /** [text] shows in full on its one line, and its box lies inside the screen. [startAligned]
     *  adds that the line ends inside its box (an end-aligned text's layout reports its line in
     *  the paragraph's own width, so the date and time go by their characters and their box);
     *  [strict] adds the visual-overflow flag (the wordmark's test: a one-line text that never
     *  wraps can read true there even when whole). */
    private fun assertWhole(text: String, startAligned: Boolean = true, strict: Boolean = false) {
        compose.onNodeWithText(text, useUnmergedTree = true).assertIsDisplayed()
        val layout = layoutOf(text)
        assertEquals("$text lost characters", text.length, layout.getLineEnd(0, visibleEnd = true))
        assertTrue("$text is ellipsized", !layout.isLineEllipsized(0))
        assertEquals("$text wrapped", 1, layout.lineCount)
        if (startAligned) assertTrue("$text runs past its box", layout.getLineRight(0) <= layout.size.width)
        if (strict) assertTrue("$text overflows", !layout.hasVisualOverflow)
        assertInsideTheScreen(text)
    }

    private fun assertInsideTheScreen(text: String) {
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("$text runs off the screen: $node in $root", node.left >= root.left && node.right <= root.right)
    }

    private fun check(onSettings: (() -> Unit)?) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { TcShell(onSettings = onSettings) { Text("page body") } }
        }
        compose.waitForIdle()
        assertWhole("ServerSherpa", strict = true)
        assertWhole("DATACENTER RELOCATION TOOLS")
        val now = Instant.now()
        // The minute can turn between composing and reading: either reading is the header's.
        val date = formatHeaderDate(now)
        assertWhole(date, startAligned = false)
        val clock = listOf(formatClock(now.toString()), formatClock(now.minusSeconds(60).toString()))
            .first { compose.onAllNodes(androidx.compose.ui.test.hasText(it)).fetchSemanticsNodes().isNotEmpty() }
        assertWhole(clock, startAligned = false)
        compose.onNodeWithText("page body").assertIsDisplayed()
        if (onSettings != null) {
            val gear = compose.onNodeWithTag("tc-gear").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
            assertTrue("the gear runs off the screen: $gear in $root", gear.left >= root.left && gear.right <= root.right)
        }
    }

    @Test fun theWordmarkIsWholeOnA320dpHandheld() = check(onSettings = null)

    @Test fun theWordmarkIsWholeBesideTheGearOnA320dpHandheld() = check(onSettings = {})

    /** A tablet keeps the one-line header: the date and time beside the wordmark, at the end. */
    @Test
    @Config(qualifiers = "w800dp-h1280dp")
    fun aTabletKeepsTheDateAndTimeBesideTheWordmark() {
        check(onSettings = {})
        val brand = compose.onNodeWithText("ServerSherpa", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val date = compose.onNodeWithText(formatHeaderDate(Instant.now()), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("the date moved below the wordmark: $date vs $brand", date.top < brand.bottom)
        assertTrue(date.left > brand.right)
    }
}
