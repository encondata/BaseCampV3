package com.serversherpa.kiosk.nettest

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertTouchHeightIsEqualTo
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.screens.settings.DeveloperPanel
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.theme.KioskTheme
import java.nio.file.FileSystems
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.junit.runners.model.Statement
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What the developer sees (design 4.1 and 4.3): the Internet Test section in
 * Settings › Developer, the amber Net test chip in the top bar, and the footer
 * item. Settings round-trip through the real controller and its DataStore, so
 * the tests wait for each write to land.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class InternetTestUiTest {
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

    private fun count(text: String, substring: Boolean = false, ignoreCase: Boolean = false) =
        compose.onAllNodesWithText(text, substring = substring, ignoreCase = ignoreCase).fetchSemanticsNodes().size

    private fun awaitText(text: String, substring: Boolean = false) =
        compose.waitUntil(5_000) { count(text, substring) > 0 }

    private fun awaitTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    /** The chip labeled [label] on [dial]'s card. */
    private fun chip(dial: String, label: String) =
        compose.onNode(hasText(label) and isSelectable() and hasAnyAncestor(hasTestTag("net-test-dial-$dial")))

    @Test fun sectionHiddenWithoutDevMode() {
        // Even a switch left on stays out of sight while Developer mode is off.
        runBlocking { c.internetTest.setEnabled(true) }
        show { DeveloperPanel() }

        compose.onNodeWithText("Developer mode").assertIsDisplayed()
        assertEquals(0, count("Internet Test", substring = true))
        assertEquals(0, count("Turns off at", substring = true))
    }

    @Test fun switchShowsDials() {
        runBlocking { c.prefs.setDevMode(true) }
        show { DeveloperPanel() }
        awaitText("Internet Test")
        compose.onNodeWithText(
            "Slows this app's own traffic to test bad networks. Off: the app uses its normal connections, untouched. " +
                "Turns itself off after 2 hours, or when you sign out or setup is cleared.",
        ).assertIsDisplayed()
        // Off: the dials and the turn-off time stay hidden.
        assertEquals(0, count("Local network"))
        assertEquals(0, count("Turns off at", substring = true))

        compose.onNode(isToggleable() and hasContentDescription("Internet Test")).performClick()

        awaitText("Turns off at", substring = true)
        val offAt = checkNotNull(c.internetTest.turnsOffAtMs())
        val time = DateTimeFormatter.ofPattern("h:mm a").format(Instant.ofEpochMilli(offAt).atZone(ZoneId.systemDefault()))
        compose.onNodeWithText("Turns off at $time").assertIsDisplayed()
        compose.onNodeWithText("Internet").assertExists()
        compose.onNodeWithText("portal: sync, uploads, heartbeat").assertExists()
        compose.onNodeWithText("Local network").assertExists()
        compose.onNodeWithText("network Zebra printers").assertExists()
        // Each dial's presets, in the dial's own order.
        for ((tag, dial) in listOf("internet" to Dial.INTERNET, "local" to Dial.LOCAL)) {
            val labels = compose.onAllNodes(isSelectable() and hasAnyAncestor(hasTestTag("net-test-dial-$tag")))
                .fetchSemanticsNodes().map { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
            assertEquals(dial.presets.map { it.label }, labels)
        }
        // Both dials start on Off.
        assertEquals(2, count("Not conditioned"))
    }

    @Test fun presetSummary() {
        runBlocking { c.internetTest.setEnabled(true) }
        show { InternetTestSection() }
        awaitTag("net-test-dial-internet")

        chip("internet", "3G").performClick()

        awaitText("↓ 780 kbps · 100 ms · 0% drop")
        compose.onNodeWithText("↑ 330 kbps · 100 ms · 0% drop").assertExists()
        assertEquals(Preset.THREE_G.id, settings().internet.preset)
        // The Local network dial is still Off.
        assertEquals(1, count("Not conditioned"))
    }

    @Test fun summaryFormatting() {
        assertEquals(listOf("↓ 40 Mbps · 1 ms · 0% drop", "↑ 33 Mbps · 1 ms · 0% drop"), summaryLines(Preset.WIFI.profile!!))
        assertEquals(listOf("↓ 250 Mbps · 1 ms · 0% drop", "↑ 100 Mbps · 1 ms · 0% drop"), summaryLines(Preset.WIFI_AC.profile!!))
        assertEquals(listOf("↓ 2 Mbps · 5 ms · 0.05% drop", "↑ 256 kbps · 5 ms · 0.039% drop"), summaryLines(Preset.DSL.profile!!))
        assertEquals(listOf("↓ 1 Mbps · 500 ms · 10% drop", "↑ 1 Mbps · 500 ms · 10% drop"), summaryLines(Preset.VERY_BAD.profile!!))
        assertEquals(
            listOf("↓ no limit · 0 ms · 0% drop", "↑ no limit · 0 ms · 0% drop", "DNS +3000 ms"),
            summaryLines(Preset.HIGH_LATENCY_DNS.profile!!),
        )
        assertEquals(listOf("↓ no limit · 0 ms · 100% drop", "↑ no limit · 0 ms · 100% drop"), summaryLines(Preset.LOSS_100.profile!!))
        assertEquals(listOf("↓ 1.5 Mbps · 0 ms · 0% drop", "↑ 999 kbps · 0 ms · 0% drop"), summaryLines(LinkProfile(1_500, 999)))
    }

    @Test fun highLatencyDnsAddsItsOwnLine() {
        runBlocking { c.internetTest.setEnabled(true) }
        show { InternetTestSection() }
        awaitTag("net-test-dial-internet")

        chip("internet", "High Latency DNS").performClick()

        awaitText("DNS +3000 ms")
        assertEquals(2, count("no limit · 0 ms · 0% drop", substring = true))
    }

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

        // Speed and Delay take digits only.
        val speed = compose.onNodeWithTag("net-test-internet-up-speed")
        speed.performTextReplacement("1a2.3")
        speed.assertTextEquals("123")
        compose.waitUntil(5_000) { settings().internet.custom.upKbps == 123 }
        val delay = compose.onNodeWithTag("net-test-internet-up-delay")
        delay.performTextReplacement("4-5.0")
        delay.assertTextEquals("450")
        compose.waitUntil(5_000) { settings().internet.custom.upDelayMs == 450 }

        // A blank speed means no limit, and a blank delay means none.
        speed.performTextClearance()
        delay.performTextClearance()
        compose.waitUntil(5_000) { settings().internet.custom.upKbps == null && settings().internet.custom.upDelayMs == 0 }
    }

    @Test fun chipAndFooterOnlyWhileOn() {
        c.auth.completePair(fakeSession())
        show { KioskShell(rememberNavController()) { Text("page body") } }
        compose.onNodeWithText("page body").assertIsDisplayed()
        assertEquals(0, count("Net test", substring = true, ignoreCase = true))

        runBlocking {
            c.internetTest.setEnabled(true)
            c.internetTest.choosePreset(Dial.INTERNET, Preset.THREE_G)
            c.internetTest.choosePreset(Dial.LOCAL, Preset.CUSTOM)
        }

        awaitText("3G · Custom")
        compose.onNodeWithText("Net test").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithText("NET TEST").assertIsDisplayed()
        compose.onNodeWithText("3G · Custom").assertIsDisplayed()

        runBlocking { c.internetTest.setEnabled(false) }

        compose.waitUntil(5_000) { count("3G · Custom") == 0 }
        assertEquals(0, count("Net test", substring = true, ignoreCase = true))
    }

    private fun layoutOf(text: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    /** The brand as laid out is whole: not ellipsized and not overflowing its box. */
    private fun brandWhole(): Boolean = layoutOf("ServerSherpa").let { !it.isLineEllipsized(0) && !it.hasVisualOverflow }

    /**
     * The chip's label as laid out is whole: not ellipsized, no line wrapped
     * out of sight, and the line inside its box. (Its width-overflow flag isn't
     * used: Compose lays a short label in a Row out at the Row's full width, so
     * the flag reads true for whole text, the kiosk name and Sign out included.)
     */
    private fun chipLabelWhole(): Boolean =
        layoutOf("Net test").let { !it.isLineEllipsized(0) && !it.didOverflowHeight && it.getLineRight(0) <= it.size.width }

    /**
     * The main handheld, the 320 dp MC2200: the chip never cuts the brand off.
     * Laid out with real fonts (native graphics), since only a real text
     * layout shows an ellipsis; a node that is merely displayed proves nothing.
     */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun chipLeavesTheBrandWholeOnA320dpHandheld() {
        c.auth.completePair(fakeSession())
        show { KioskShell(rememberNavController()) { Text("page body") } }
        compose.waitForIdle()
        assertTrue("the brand is cut off with the switch off", brandWhole())
        val pageTop = compose.onNodeWithText("page body").fetchSemanticsNode().boundsInRoot.top

        runBlocking { c.internetTest.setEnabled(true) }
        awaitText("Net test")

        assertTrue("the brand is cut off with the chip on", brandWhole())
        assertTrue("the chip's own label is cut off", chipLabelWhole())
        compose.onNodeWithText("ServerSherpa").assertIsDisplayed()
        compose.onNodeWithText("Sign out").assertIsDisplayed()
        compose.onNodeWithText("Net test").assertIsDisplayed().assertHasClickAction()
        // A small pill, but a full-size tap target, and the bar is no taller for it.
        compose.onNodeWithText("Net test").assertTouchHeightIsEqualTo(48.dp)
        assertEquals(pageTop, compose.onNodeWithText("page body").fetchSemanticsNode().boundsInRoot.top)
    }

    @Test fun chipOpensDeveloperSettings() {
        c.auth.completePair(fakeSession())
        runBlocking { c.internetTest.setEnabled(true) }
        lateinit var nav: NavHostController
        show {
            nav = rememberNavController()
            NavHost(nav, startDestination = Routes.HOME) {
                composable(Routes.HOME) { KioskShell(nav) { Text("home page") } }
                composable(Routes.SETTINGS, arguments = listOf(navArgument("tab") { type = NavType.StringType; nullable = true })) { entry ->
                    Text("settings page: ${entry.arguments?.getString("tab")}")
                }
            }
        }
        awaitText("Net test")

        compose.onNodeWithText("Net test").performClick()

        awaitText("settings page: developer")
        compose.waitForIdle()
        assertEquals(Routes.SETTINGS, nav.currentDestination?.route)
        assertEquals("developer", nav.currentBackStackEntry?.arguments?.getString("tab"))
    }
}

/**
 * Before a native-graphics test, waits out another Robolectric sandbox that is
 * still unpacking the native runtime's fonts (about 160 MB). Robolectric 4.14
 * holds the fonts jar open as a zip file system while it copies them, and a
 * sandbox that starts loading meanwhile fails with
 * FileSystemAlreadyExistsException. The legacy-graphics tests start that copy
 * on a background thread (Room's first query), so a native-graphics test right
 * after them would collide with it. The file system is open exactly while a
 * copy is in progress.
 */
private class NativeFontsSettled : TestRule {
    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
        override fun evaluate() {
            if (description.getAnnotation(GraphicsMode::class.java)?.value == GraphicsMode.Mode.NATIVE) awaitFontsCopied()
            base.evaluate()
        }
    }

    private fun awaitFontsCopied() {
        val fonts = javaClass.classLoader?.getResource("fonts/")?.toURI()?.takeIf { it.scheme == "jar" } ?: return
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (runCatching { FileSystems.getFileSystem(fonts) }.isSuccess && System.nanoTime() < deadline) Thread.sleep(20)
    }
}
