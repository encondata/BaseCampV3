package com.serversherpa.kiosk.nettest

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTouchHeightIsEqualTo
import androidx.compose.ui.test.click
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
import androidx.compose.ui.test.performTouchInput
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
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeStationApi
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.KioskApp
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.screens.settings.DeveloperPanel
import com.serversherpa.kiosk.ui.screens.timeclock.TimeclockScreen
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.theme.KioskTheme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What the developer sees (design 4.1 and 4.3): the Internet Test section in
 * Settings › Developer, the amber Net test chip in the top bar and in the Time
 * Clock's header, and the footer item. Settings round-trip through the real controller and its DataStore, so
 * the tests wait for each write to land.
 *
 * The composition runs on a [StandardTestDispatcher], not the rule's default
 * UnconfinedTestDispatcher. The controller's settings change on a
 * Dispatchers.IO thread (the container scope's DataStore collector). Under the
 * unconfined default, each collectAsStateWithLifecycle collector resumes inline
 * on that IO thread and writes its state there, racing the main thread's
 * composition. Now and then a shell scope then stopped following the settings
 * for good: the footer kept "3G · Custom" with the switch long off (the
 * chipAndFooterOnlyWhileOn full-run flake; chipAndFooterFollowEverySwitch hit
 * it within 15 switches every time). On a device the composition's dispatcher
 * is the main thread, so the resume is always posted there. The standard test
 * dispatcher does the same: it queues the resume for the main test clock.
 *
 * Custom's boxes are tested in InternetTestCustomBoxesTest, on the default
 * dispatcher. Here a typed edit would only land on a later frame, and a box
 * test that ran to its end here left Compose never idle for the tests after
 * it.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class InternetTestUiTest {
    private val compose = createComposeRule(StandardTestDispatcher())

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

    /**
     * The footer and the chip follow every switch, on and off, a hundred times
     * over: each write lands in the store on an IO thread, and the shell never
     * stops following it (see the class comment).
     */
    @Test fun chipAndFooterFollowEverySwitch() {
        c.auth.completePair(fakeSession())
        show { KioskShell(rememberNavController()) { Text("page body") } }
        runBlocking {
            c.internetTest.choosePreset(Dial.INTERNET, Preset.THREE_G)
            c.internetTest.choosePreset(Dial.LOCAL, Preset.CUSTOM)
        }

        repeat(100) { round ->
            runBlocking { c.internetTest.setEnabled(true) }
            compose.waitUntil("switch $round on: the footer shows", 5_000) { count("3G · Custom") == 1 && count("Net test") == 1 }
            runBlocking { c.internetTest.setEnabled(false) }
            compose.waitUntil("switch $round off: the footer clears", 5_000) { count("3G · Custom") == 0 && count("Net test") == 0 }
        }
    }

    @Test fun chipHiddenWhileSignedOut() {
        runBlocking { c.internetTest.setEnabled(true) }
        show { KioskShell(rememberNavController()) { Text("page body") } }

        // The switch has loaded (the footer says so), yet with nobody signed in there is no chip.
        awaitText("NET TEST")
        assertEquals(0, count("Net test"))
    }

    private fun layoutOf(text: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    /**
     * [text] as laid out shows in full: every character on its one visible
     * line, nothing ellipsized or wrapped out of sight, and the line inside its
     * box. (The width-overflow flag isn't used. Compose can lay a short text in
     * a Row out at the Row's full width, so the flag reads true for whole text;
     * the kiosk name and Sign out show it too.)
     */
    private fun whole(text: String): Boolean = layoutOf(text).let {
        !it.isLineEllipsized(0) && !it.didOverflowHeight && it.getLineEnd(0, visibleEnd = true) == text.length && it.getLineRight(0) <= it.size.width
    }

    /** The brand is whole, and by the stricter test as well: no visual overflow at all. */
    private fun brandWhole(): Boolean = whole("ServerSherpa") && !layoutOf("ServerSherpa").hasVisualOverflow

    private lateinit var nav: NavHostController

    /** The signed-in shell, on Home, for a kiosk named [kioskName], with the Settings route to land on. */
    private fun showSignedInShell(kioskName: String) {
        runBlocking { assertTrue(c.identity.setName(kioskName)) }
        c.auth.completePair(fakeSession())
        show {
            nav = rememberNavController()
            NavHost(nav, startDestination = Routes.HOME) {
                composable(Routes.HOME) { KioskShell(nav) { Text("page body") } }
                composable(Routes.SETTINGS, arguments = listOf(navArgument("tab") { type = NavType.StringType; nullable = true })) { entry ->
                    Text("settings page: ${entry.arguments?.getString("tab")}")
                }
            }
        }
        awaitText(kioskName)
    }

    private fun pageTop(): Float = compose.onNodeWithText("page body").fetchSemanticsNode().boundsInRoot.top

    /**
     * With the switch off: no chip and the brand whole (and the kiosk name too
     * when [nameFitsWhileOff]). Then switched on: the chip shows its full label,
     * the brand is still whole, Sign out stays, and the bar is exactly as tall
     * as with the switch off.
     */
    private fun assertChipFits(kioskName: String, nameFitsWhileOff: Boolean) {
        assertEquals(0, count("Net test"))
        assertTrue("the brand is cut off with the switch off", brandWhole())
        if (nameFitsWhileOff) assertTrue("the kiosk name is cut off with the switch off", whole(kioskName))
        val barOnly = pageTop()

        runBlocking { c.internetTest.setEnabled(true) }
        awaitText("Net test")

        assertTrue("the chip's label is cut off", whole("Net test"))
        assertTrue("the brand is cut off with the chip on", brandWhole())
        compose.onNodeWithText("Net test").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithText("Sign out").assertIsDisplayed()
        assertEquals("the chip made the bar taller", barOnly, pageTop())
    }

    /*
     * The main handheld, the 320 dp MC2200, laid out with real fonts (native
     * graphics): only a real text layout shows an ellipsis, and a node that is
     * merely displayed proves nothing.
     */

    /** A kiosk name in the default format: chip and brand both whole, and a real tap on the pill opens Developer settings. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun chipFitsOnA320dpHandheld() {
        showSignedInShell("Kiosk 8CE2")

        assertChipFits("Kiosk 8CE2", nameFitsWhileOff = true)

        // A small pill, but a full-height tap target within the bar.
        compose.onNodeWithText("Net test").assertTouchHeightIsEqualTo(48.dp)
        compose.onNodeWithText("Net test").performTouchInput { click(center) }
        awaitText("settings page: developer")
        assertEquals(Routes.SETTINGS, nav.currentDestination?.route)
        assertEquals("developer", nav.currentBackStackEntry?.arguments?.getString("tab"))
    }

    /** Kiosk names run to 80 characters. The chip comes first, so a long name ellipsizes, never the chip. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun chipKeepsItsLabelBesideALongKioskName() {
        showSignedInShell("Ashburn DC2 Receiving Dock")

        assertChipFits("Ashburn DC2 Receiving Dock", nameFitsWhileOff = false)
    }

    /** A mid-length name squeezes the " · " after it to a sliver; the bar still keeps its height. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun chipFitsBesideAMidLengthKioskName() {
        showSignedInShell("Dallas Dock 4")

        assertChipFits("Dallas Dock 4", nameFitsWhileOff = true)
    }

    /** Larger system text (font scale 1.15) with a default-format name: chip and brand whole, the bar no taller. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun chipFitsAtFontScale115() {
        RuntimeEnvironment.setFontScale(1.15f)
        showSignedInShell("Kiosk 8CE2")
        assertEquals(1.15f, compose.density.fontScale)

        assertChipFits("Kiosk 8CE2", nameFitsWhileOff = true)
    }

    @Test fun chipOpensDeveloperSettings() {
        c.auth.completePair(fakeSession())
        runBlocking { c.internetTest.setEnabled(true) }
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

    /*
     * The Time Clock owns the whole screen (no kiosk top bar), so its own
     * header carries the chip: on every step a signed-in kiosk's Time Clock
     * shows, and never on a Time Clock station's, where nobody is signed in.
     */

    /** The regular kiosk's Time Clock (KIOSK mode), signed in, with the Settings route to land on. */
    private fun showSignedInTimeClock() {
        c.auth.completePair(fakeSession())
        show {
            nav = rememberNavController()
            NavHost(nav, startDestination = Routes.TIMECLOCK) {
                composable(Routes.TIMECLOCK) { TimeclockScreen(nav) }
                composable(Routes.HOME) { Text("home page") }
                composable(Routes.SETTINGS, arguments = listOf(navArgument("tab") { type = NavType.StringType; nullable = true })) { entry ->
                    Text("settings page: ${entry.arguments?.getString("tab")}")
                }
            }
        }
        awaitText(TC_TAGLINE)
    }

    @Test fun timeClockShowsTheChipWhileSignedInAndOn() {
        showSignedInTimeClock()
        assertEquals(0, count("Net test"))

        runBlocking { c.internetTest.setEnabled(true) }

        awaitText("Net test")
        compose.onNodeWithText("Net test").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithText(TC_TAGLINE).assertIsDisplayed()

        runBlocking { c.internetTest.setEnabled(false) }
        compose.waitUntil(5_000) { count("Net test") == 0 }
    }

    @Test fun theTimeClockChipOpensDeveloperSettings() {
        runBlocking { c.internetTest.setEnabled(true) }
        showSignedInTimeClock()
        awaitText("Net test")

        compose.onNodeWithText("Net test").performClick()

        awaitText("settings page: developer")
        compose.waitForIdle()
        assertEquals(Routes.SETTINGS, nav.currentDestination?.route)
        assertEquals("developer", nav.currentBackStackEntry?.arguments?.getString("tab"))
    }

    /**
     * The 320 dp MC2200 with real fonts. The wordmark is already too wide for
     * it, so the chip sits above the date, in the clock's column: switched
     * on, it shows its whole label and takes no width from the wordmark or
     * the tagline.
     */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun theTimeClockChipLeavesTheWordmarkAloneOnA320dpHandheld() {
        showSignedInTimeClock()
        val brand = layoutOf("ServerSherpa").size.width
        val tagline = layoutOf(TC_TAGLINE).size.width

        runBlocking { c.internetTest.setEnabled(true) }
        awaitText("Net test")

        assertTrue("the chip's label is cut off", whole("Net test"))
        assertEquals("the chip took width from the wordmark", brand, layoutOf("ServerSherpa").size.width)
        assertEquals("the chip took width from the tagline", tagline, layoutOf(TC_TAGLINE).size.width)
    }

    /**
     * A Time Clock station resting on Welcome through the app's own routes
     * (as StationModeTest sets one up): nobody is signed in, so no chip, even
     * with the switch on. (Running, the controller would have turned it off;
     * the chip's own sign-in check is what this proves.)
     */
    @Test fun aTimeClockStationShowsNoChip() {
        c.scope.cancel()
        c.db.close()
        c = testContainer(api = FakeKioskApi(), stationApi = FakeStationApi())
        runBlocking {
            c.identity.get()
            c.prefs.setSetupSelection(KioskSetupSelection(siteId = "s1", siteName = "Dock 4", siteRole = "other", stationType = "timeclock"))
            c.prefs.setSetupState(SetupState.COMPLETE)
            c.stationKeys.put("k1", "http://127.0.0.1:1")
            c.auth.restore()
            c.internetTest.setEnabled(true)
        }
        assertEquals(AuthState.Anon, c.auth.state.value)
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskApp() } }

        awaitText("Welcome!")
        compose.waitUntil(5_000) { settings().enabled }
        compose.waitForIdle()
        compose.onNodeWithText(TC_TAGLINE).assertIsDisplayed()
        assertEquals(0, count("Net test", ignoreCase = true))
    }

    private companion object {
        /** The Time Clock header's tagline, under the wordmark. */
        const val TC_TAGLINE = "DATACENTER RELOCATION TOOLS"
    }
}
