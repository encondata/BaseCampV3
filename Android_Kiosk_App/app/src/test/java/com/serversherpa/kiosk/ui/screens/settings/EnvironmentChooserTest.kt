package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.environment.Env
import com.serversherpa.kiosk.core.environment.Environments
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.core.environment.asSaved
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.environment.OutboxUnreadable
import com.serversherpa.kiosk.data.environment.SwitchResult
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.screens.login.LoginScreen
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Settings › This Kiosk's environment row, the chooser it opens (password → list → custom or
 *  confirm), and the non-Prod badge on the shell and the sign-in page. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class EnvironmentChooserTest {
    @get:Rule val compose = createComposeRule()

    private val api = FakeKioskApi()
    private val c: AppContainer = testContainer(api = api)
    private val uat = checkNotNull(Environments.byId("uat")).asSaved()
    private val prod = checkNotNull(Environments.byId("prod")).asSaved()
    private val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN", "Dell")

    @After fun tearDown() { c.scope.cancel(); c.db.close() }

    private fun save(env: SavedEnvironment) = runBlocking { c.environments.save(env) }

    /** [n] unsent (queued) scans in the outbox's store. */
    private fun unsent(n: Int) = runBlocking {
        c.db.outbox().upsert((1..n).map {
            OutboxMachine.newRow(EnqueueInput("A-$it", "barcode", asset, "s1", "i1", "packed"), "c$it", it.toLong(), 0).toEntity()
        })
    }

    private fun panel(switchTo: (suspend (SavedEnvironment, Boolean) -> SwitchResult)? = null) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        if (switchTo == null) ThisKioskPanel() else EnvironmentRow(switchTo = switchTo)
                    }
                }
            }
        }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntilIdlingMain { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForText(text: String) =
        compose.waitUntilIdlingMain { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    private fun waitGone(tag: String) =
        compose.waitUntilIdlingMain { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() }

    /** Change… → the password → the list. */
    private fun openList() {
        waitForTag("env-change")
        compose.waitUntilIdlingMain { runCatching { compose.onNodeWithTag("env-change").assertIsEnabled() }.isSuccess }
        compose.onNodeWithTag("env-change").performScrollTo().performClick()     // below the fold when signed in
        waitForTag("env-password")
        compose.onNodeWithTag("env-password").performTextReplacement(Environments.PASSWORD)
        compose.onNodeWithTag("env-continue").performClick()
        waitForTag("env-custom")
    }

    private fun pick(id: String) {
        compose.onNodeWithTag("env-row-$id").performClick()
        waitForTag("env-confirm")
    }

    // ---- the row ----

    @Test fun theRowShowsTheEnvironmentAndItsServer() {
        save(uat)
        panel()
        compose.waitUntilIdlingMain { runCatching { compose.onNodeWithTag("env-name").assertTextEquals("UAT") }.isSuccess }
        compose.onNodeWithTag("env-server").assertTextEquals("api.uat.serversherpa.com")
        compose.onNodeWithText("Change…").assertIsDisplayed()
        compose.onNodeWithText("Save URLs").assertDoesNotExist()
    }

    @Test fun aCustomEnvironmentShowsCustomAndItsApiUrl() {
        panel()                                                           // the test container's Custom pair
        compose.waitUntilIdlingMain { runCatching { compose.onNodeWithTag("env-name").assertTextEquals("Custom") }.isSuccess }
        compose.onNodeWithTag("env-server").assertTextEquals("http://127.0.0.1:1")
    }

    // ---- the password ----

    @Test fun aWrongPasswordShowsTheCopyAndStaysOnThePassword() {
        panel()
        waitForTag("env-change")
        compose.onNodeWithTag("env-change").performClick()
        waitForTag("env-password")
        compose.onNodeWithText("THIS KIOSK").assertIsDisplayed()          // the eyebrow
        compose.onNodeWithText("Change environment").assertIsDisplayed()
        compose.onNodeWithText("Environment password").assertIsDisplayed()
        compose.onNodeWithTag("env-continue").assertIsNotEnabled()        // nothing typed yet
        compose.onNodeWithTag("env-password").performTextReplacement("Cumulus")
        compose.onNodeWithTag("env-continue").performClick()
        compose.onNodeWithText("That password isn't right.").assertIsDisplayed()
        compose.onNodeWithTag("env-password").assertIsDisplayed()
        compose.onNodeWithTag("env-custom").assertDoesNotExist()
        compose.onNodeWithTag("env-password").performTextReplacement("cumulus")
        compose.onNodeWithText("That password isn't right.").assertDoesNotExist()
    }

    // ---- the list ----

    @Test fun theListKeepsItsOrderWithCustomUrlLast() {
        save(uat)
        panel()
        openList()
        val tags = Environments.BUILT_IN.map { "env-row-${it.id}" } + "env-custom"
        val tops = tags.map { compose.onNodeWithTag(it).fetchSemanticsNode().boundsInRoot.top }
        assertEquals(tops.sorted(), tops)
        compose.onNodeWithText("Custom URL…").assertIsDisplayed()
        // The current one is marked and can't be picked again.
        compose.onNodeWithTag("env-row-uat").assertIsNotEnabled()
        compose.onNodeWithText("Current").assertIsDisplayed()
        compose.onNodeWithTag("env-row-prod").assertIsEnabled()
    }

    /** Review Focus 1: the list's entry for the saved id now names another domain, so it is a
     *  normal choice (a full switch), not the current one. */
    @Test fun anEntryWhoseDomainChangedIsNotTheCurrentOne() {
        save(uat)
        runBlocking { c.environments.cacheList(listOf(Env("uat", "UAT", "uat2.serversherpa.com"), Env("prod", "Prod", "serversherpa.com"))) }
        panel()
        openList()
        compose.onNodeWithTag("env-row-uat").assertIsEnabled()
        compose.onNodeWithText("Current").assertDoesNotExist()
        compose.onNodeWithTag("env-row-rc1").assertDoesNotExist()        // the saved list, not the built-in one
    }

    // ---- confirm ----

    @Test fun theConfirmSaysWhatASwitchClearsAndCancelGoesBackToTheList() {
        panel()
        openList()
        pick("uat")
        compose.onNodeWithText("Switching to UAT signs this kiosk out and clears its setup and saved move data.").assertIsDisplayed()
        compose.onNodeWithTag("env-confirm").assertTextEquals("Switch")
        compose.onNodeWithTag("env-cancel").assertTextEquals("Cancel").performClick()
        waitForTag("env-custom")
        compose.onNodeWithTag("env-confirm").assertDoesNotExist()
    }

    @Test fun unsentScansAreCountedWithWaitOrDiscard() {
        unsent(3)
        panel()
        openList()
        pick("prod")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForText("3 unsent scans haven't been sent yet.")
        compose.onNodeWithTag("env-wait").assertTextEquals("Wait for them to send")
        compose.onNodeWithTag("env-discard").assertTextEquals("Discard and switch")
        compose.onNodeWithTag("env-confirm").assertDoesNotExist()
        // Waiting closes the chooser; nothing was switched.
        compose.onNodeWithTag("env-wait").performClick()
        waitGone("env-discard")
        assertTrue(runBlocking { c.environments.saved.first() } is SavedEnvironment.Custom)
    }

    @Test fun oneUnsentScanIsSingular() {
        unsent(1)
        panel()
        openList()
        pick("prod")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForText("1 unsent scan hasn't been sent yet.")
    }

    // ---- refusals ----

    @Test fun customOnARegisteredKioskNeedsASuperAdmin() {
        runBlocking { c.environments.markRegistered() }
        panel()
        openList()
        compose.onNodeWithTag("env-custom").performClick()
        waitForTag("env-api-url")
        compose.onNodeWithText("Switching to Custom signs this kiosk out and clears its setup and saved move data.").assertIsDisplayed()
        compose.onNodeWithTag("env-api-url").performTextReplacement("http://10.0.0.5:8000")
        compose.onNodeWithTag("env-portal-url").performTextReplacement("http://10.0.0.5:5173")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForText("Sign in as a developer, founder or super admin to use a custom URL.")
        compose.onNodeWithTag("env-api-url").assertIsDisplayed()          // still on the fields
    }

    @Test fun aCustomUrlThatIsNotHttpIsRefusedBeforeAnySwitch() {
        var calls = 0
        panel(switchTo = { _, _ -> calls++; SwitchResult.Done })
        openList()
        compose.onNodeWithTag("env-custom").performClick()
        waitForTag("env-api-url")
        compose.onNodeWithTag("env-api-url").performTextReplacement("ftp://10.0.0.5")
        compose.onNodeWithTag("env-confirm").performClick()
        compose.onNodeWithText("Enter an http or https address for both URLs.").assertIsDisplayed()
        assertEquals(0, calls)
        compose.onNodeWithTag("env-api-url").performTextReplacement("")
        compose.onNodeWithTag("env-confirm").assertIsNotEnabled()
    }

    @Test fun discardingSignedOutNeedsAnAdmin() {
        unsent(2)
        panel()
        openList()
        pick("prod")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForTag("env-discard")
        compose.onNodeWithTag("env-discard").performClick()
        waitForText("Sign in as an admin to discard unsent scans.")
        compose.onNodeWithText("2 unsent scans haven't been sent yet.").assertIsDisplayed()
    }

    @Test fun anAccessCheckThatCantReachTheServerSaysSo() {
        unsent(2)
        c.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60))
        api.meResult = { throw ApiError(0, "network") }
        panel()
        openList()
        pick("prod")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForTag("env-discard")
        compose.onNodeWithTag("env-discard").performClick()
        waitForText("Can't reach the server to check your access.")
    }

    @Test fun anUnreadableOutboxShowsAnErrorAndStaysOnTheChooser() {
        panel(switchTo = { _, _ -> throw OutboxUnreadable() })
        openList()
        pick("prod")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForText("Couldn't read this kiosk's unsent scans, so nothing was switched. Try again.")
        compose.onNodeWithTag("env-confirm").assertIsEnabled()
    }

    @Test fun aSwitchThatFailsShowsAnErrorAndStaysOnTheChooser() {
        panel(switchTo = { _, _ -> throw IllegalStateException("disk") })
        openList()
        pick("prod")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForText("Couldn't switch environment. Try again.")
        compose.onNodeWithTag("env-confirm").assertIsEnabled()
    }

    /** A switch away from a dead server can take a while: the buttons wait, and the chooser
     *  can't be closed until it answers. */
    @Test fun aSwitchInProgressDisablesEverything() {
        val answer = CompletableDeferred<SwitchResult>()
        panel(switchTo = { _, _ -> answer.await() })
        openList()
        pick("prod")
        compose.onNodeWithTag("env-confirm").performClick()
        compose.waitUntilIdlingMain { runCatching { compose.onNodeWithTag("env-confirm").assertTextEquals("Switching…") }.isSuccess }
        compose.onNodeWithTag("env-confirm").assertIsNotEnabled()
        compose.onNodeWithTag("env-cancel").assertIsNotEnabled()
        compose.onNodeWithTag("env-close").assertIsNotEnabled()
        answer.complete(SwitchResult.Refused(SwitchResult.ACCESS_CHECK_OFFLINE))
        waitForText("Can't reach the server to check your access.")
        compose.onNodeWithTag("env-confirm").assertIsEnabled()
    }

    // ---- success ----

    @Test fun aSwitchLandsOnSignIn() {
        lateinit var nav: NavHostController
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    nav = rememberNavController()
                    NavHost(nav, startDestination = Routes.SETTINGS) {
                        composable(Routes.SETTINGS) { Column(Modifier.verticalScroll(rememberScrollState())) { SettingsScreen(nav, "this-kiosk") } }
                        composable(Routes.LOGIN) { Text("the sign-in page") }
                    }
                }
            }
        }
        openList()
        pick("uat")
        compose.onNodeWithTag("env-confirm").performClick()
        waitForText("the sign-in page")
        assertEquals(Routes.LOGIN, nav.currentDestination?.route)
        assertEquals(uat, runBlocking { c.environments.saved.first() })
        waitGone("env-confirm")
    }

    // ---- the badge ----

    private fun shell() = compose.setContent {
        CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { KioskShell(rememberNavController()) { Text("page body") } } }
    }

    private fun login() = compose.setContent {
        CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { LoginScreen(rememberNavController()) } }
    }

    @Test fun theShellShowsTheBadgeOffProd() {
        save(uat)
        shell()
        compose.waitUntilIdlingMain { runCatching { compose.onNodeWithTag("env-badge").assertIsDisplayed() }.isSuccess }
        compose.onNodeWithText("UAT").assertIsDisplayed()
    }

    @Test fun theShellShowsNoBadgeOnProd() {
        save(prod)
        shell()
        compose.waitUntilIdlingMain { compose.onAllNodesWithText("page body").fetchSemanticsNodes().isNotEmpty() }
        compose.mainClock.advanceTimeBy(500)
        compose.onNodeWithTag("env-badge").assertDoesNotExist()
    }

    @Test fun signInShowsTheBadgeOffProd() {
        save(uat)
        login()
        compose.waitUntilIdlingMain { runCatching { compose.onNodeWithTag("env-badge").assertIsDisplayed() }.isSuccess }
        compose.onNodeWithText("UAT").assertIsDisplayed()
    }

    @Test fun signInShowsCustomForTypedUrls() {
        login()
        compose.waitUntilIdlingMain { runCatching { compose.onNodeWithTag("env-badge").assertIsDisplayed() }.isSuccess }
        compose.onNodeWithText("Custom").assertIsDisplayed()
    }

    @Test fun signInShowsNoBadgeOnProd() {
        save(prod)
        login()
        compose.waitUntilIdlingMain { compose.onAllNodesWithText("Sign in").fetchSemanticsNodes().isNotEmpty() }
        compose.mainClock.advanceTimeBy(500)
        compose.onNodeWithTag("env-badge").assertDoesNotExist()
    }

    // ---- fits a short phone ----

    /** Whether [this] is drawn whole inside its window (a 640 dp screen): no scroll needed to reach it. */
    private fun SemanticsNodeInteraction.assertWithinScreen() {
        assertIsDisplayed()
        val bottom = fetchSemanticsNode().boundsInRoot.bottom
        val screen = with(compose.density) { 640.dp.toPx() }
        assertTrue("bottom $bottom is past the screen ($screen)", bottom <= screen)
    }

    @Test @Config(qualifiers = "w360dp-h640dp")
    fun theButtonsNeedNoScrollOnAShortPhone() {
        unsent(2)
        panel()
        openList()
        compose.onNodeWithTag("env-list-cancel").assertWithinScreen()
        pick("prod")
        compose.onNodeWithTag("env-confirm").assertWithinScreen()
        compose.onNodeWithTag("env-cancel").assertWithinScreen()
        compose.onNodeWithTag("env-confirm").performClick()
        waitForTag("env-discard")
        compose.onNodeWithTag("env-discard").assertWithinScreen()
        compose.onNodeWithTag("env-wait").assertWithinScreen()
        compose.onNodeWithTag("env-wait").performClick()
        waitGone("env-wait")
        openList()
        compose.onNodeWithTag("env-custom").performClick()
        waitForTag("env-api-url")
        compose.onNodeWithTag("env-confirm").assertWithinScreen()
        compose.onNodeWithTag("env-cancel").assertWithinScreen()
        assertTrue(compose.onAllNodes(isRoot()).fetchSemanticsNodes().size >= 2)   // drawn in its own dialog window
    }
}
