package com.serversherpa.kiosk.nettest

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Custom's six boxes in the Internet Test section (design 4.1): what they
 * accept and what they save. These tests type into the boxes and check each
 * edit at once, so they keep the compose rule's default dispatcher, under
 * which an edit lands before the call returns. InternetTestUiTest runs its
 * composition on a standard test dispatcher instead (its class comment says
 * why), and there an edit only lands on a later frame.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class InternetTestCustomBoxesTest {
    private val compose = createComposeRule()

    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    private lateinit var c: AppContainer

    @Before fun setUp() {
        InternetTestRoutes.resetForTests()
        c = testContainer()
    }

    @After fun tearDown() {
        c.scope.cancel()
        c.db.close()
        InternetTestRoutes.resetForTests()
    }

    private fun show(content: @Composable () -> Unit) = compose.setContent {
        CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { content() } }
    }

    private fun settings() = c.internetTest.settings.value

    private fun awaitTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    /** The chip labeled [label] on [dial]'s card. */
    private fun chip(dial: String, label: String) =
        compose.onNode(hasText(label) and isSelectable() and hasAnyAncestor(hasTestTag("net-test-dial-$dial")))

    @Test fun customBoxesRemember() {
        runBlocking { c.internetTest.setEnabled(true) }
        var generation by mutableIntStateOf(0)
        show { key(generation) { InternetTestSection() } }
        awaitTag("net-test-dial-local")

        chip("local", "Custom").performClick()

        awaitTag("net-test-local-down-speed")
        for (label in listOf("Download", "Upload", "Speed (kbps)", "Delay (ms)", "Drop (%)")) compose.onNodeWithText(label).assertExists()
        // The six boxes start from the dial's saved Custom values.
        val boxes = mapOf(
            "down-speed" to "256", "up-speed" to "128", "down-delay" to "300", "up-delay" to "300", "down-drop" to "5", "up-drop" to "5",
        )
        for ((box, text) in boxes) compose.onNodeWithTag("net-test-local-$box").assertTextEquals(text)

        compose.onNodeWithTag("net-test-local-down-speed").performTextReplacement("64")
        compose.waitUntil(5_000) { settings().local.custom.downKbps == 64 }

        // A brand-new section reads the saved values back.
        compose.runOnIdle { generation++ }
        awaitTag("net-test-local-down-speed")
        compose.onNodeWithTag("net-test-local-down-speed").assertTextEquals("64")
        assertEquals(64, settings().local.custom.downKbps)
        assertEquals(DEFAULT_CUSTOM.copy(downKbps = 64), settings().local.custom)
        // The other dial's Custom values are its own.
        assertEquals(DEFAULT_CUSTOM, settings().internet.custom)
    }

    @Test fun dropBoxRejectsLetters() {
        runBlocking {
            c.internetTest.setEnabled(true)
            c.internetTest.choosePreset(Dial.INTERNET, Preset.CUSTOM)
        }
        show { InternetTestSection() }
        awaitTag("net-test-internet-down-drop")
        val drop = compose.onNodeWithTag("net-test-internet-down-drop")

        drop.performTextReplacement("1a.5.2")
        drop.assertTextEquals("1.52")
        compose.waitUntil(5_000) { settings().internet.custom.downDropPct == 1.52 }

        // Typed one key at a time, the same: letters and a second point never land.
        drop.performTextClearance()
        for (key in "2b.5.") drop.performTextInput(key.toString())
        drop.assertTextEquals("2.5")
        compose.waitUntil(5_000) { settings().internet.custom.downDropPct == 2.5 }

        // A comma-decimal keyboard (de, fr, es, pt-BR...) offers "," as its point:
        // it lands as ".", still one point at most.
        drop.performTextReplacement("0,5")
        drop.assertTextEquals("0.5")
        compose.waitUntil(5_000) { settings().internet.custom.downDropPct == 0.5 }
        drop.performTextClearance()
        for (key in "2,5,") drop.performTextInput(key.toString())
        drop.assertTextEquals("2.5")
        compose.waitUntil(5_000) { settings().internet.custom.downDropPct == 2.5 }
        drop.performTextReplacement("1,5.2")
        drop.assertTextEquals("1.52")
        drop.performTextReplacement("1.5,2")
        drop.assertTextEquals("1.52")

        // Speed and Delay take digits only.
        val speed = compose.onNodeWithTag("net-test-internet-up-speed")
        speed.performTextReplacement("1a2.3")
        speed.assertTextEquals("123")
        compose.waitUntil(5_000) { settings().internet.custom.upKbps == 123 }
        val delay = compose.onNodeWithTag("net-test-internet-up-delay")
        delay.performTextReplacement("4-5.0")
        delay.assertTextEquals("450")
        compose.waitUntil(5_000) { settings().internet.custom.upDelayMs == 450 }
        // Whole numbers only there: a comma is dropped like any other non-digit.
        delay.performTextReplacement("4,5")
        delay.assertTextEquals("45")
        compose.waitUntil(5_000) { settings().internet.custom.upDelayMs == 45 }

        // A blank speed means no limit, and a blank delay means none.
        speed.performTextClearance()
        delay.performTextClearance()
        compose.waitUntil(5_000) { settings().internet.custom.upKbps == null && settings().internet.custom.upDelayMs == 0 }
    }
}
