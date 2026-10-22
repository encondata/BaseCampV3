package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexList
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.ROLODEX_META_KEY
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RolodexScreenTest {
    // An activity rule: the Back test presses the activity's own Back.
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val abbott = rolodexRow("p-abbott", "Ann", "Abbott", job = "Rigger", company = "Summit Crew")
    private val carter = rolodexRow("p-carter", "Ben", "Carter", job = "Lead tech", status = "standby", hasPhoto = false)

    private fun api() = FakeKioskApi().apply {
        rolodexWorkersResult = { RolodexList("now", listOf(carter, abbott)) }
        rolodexOptionsResult = { ROLODEX_OPTIONS }
        rolodexWorkerResult = { id -> rolodexDetail(listOf(abbott, carter).first { it.person_id == id }) }
    }

    /** A signed-in admin's container: the offline list is kept only for one. */
    private fun admin(api: FakeKioskApi) = testContainer(api = api).also { it.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60)) }

    private fun show(api: FakeKioskApi, prepare: (AppContainer) -> Unit = {}): AppContainer {
        val c = admin(api)
        prepare(c)
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { RolodexScreen(rememberNavController()) } }
        }
        waitFor("rolodex-row-p-abbott")
        return c
    }

    /** As the app routes it: Home, then the Rolodex inside the kiosk shell (whose page has 16 dp padding). */
    private fun showRouted(api: FakeKioskApi): AppContainer {
        val c = admin(api)
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    val nav = rememberNavController()
                    NavHost(nav, startDestination = Routes.HOME) {
                        composable(Routes.HOME) { Text("home page") }
                        composable(Routes.ROLODEX) { KioskShell(nav, scroll = false) { RolodexScreen(nav) } }
                    }
                    LaunchedEffect(Unit) { nav.navigate(Routes.ROLODEX) }
                }
            }
        }
        waitFor("rolodex-row-p-abbott")
        return c
    }

    private fun pressBack() = compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }

    private fun waitFor(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForText(text: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun aPhoneShowsTheListThenTheWorkerPageFullScreen() {
        show(api())
        compose.onNodeWithText("2 workers").assertIsDisplayed()
        compose.onNodeWithTag("rolodex-search").assertIsDisplayed()
        compose.onNodeWithText("‹ Rolodex").assertDoesNotExist()

        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithText("‹ Rolodex").assertIsDisplayed()
        compose.onNodeWithTag("worker-name").assertIsDisplayed()
        compose.onNodeWithTag("rolodex-search").assertDoesNotExist()            // the page owns the screen

        compose.onNodeWithText("‹ Rolodex").performClick()
        waitFor("rolodex-search")
        compose.onNodeWithTag("worker-name").assertDoesNotExist()
    }

    @Config(qualifiers = "w1280dp-h800dp-land")
    @Test fun aTabletShowsTheListAndTheWorkerPageSideBySide() {
        show(api())
        compose.onNodeWithText("Choose a worker to see their page.").assertIsDisplayed()
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithTag("worker-name").assertIsDisplayed()
        compose.onNodeWithTag("rolodex-search").assertIsDisplayed()
        compose.onNodeWithTag("rolodex-row-p-carter").assertIsDisplayed()
        compose.onNodeWithText("‹ Rolodex").assertDoesNotExist()                // no back on a split
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun offlineTheCachedListShowsWithTheBannerAndEditIsOff() {
        show(api().apply { rolodexWorkersResult = { throw ApiError(0, "network") } }) { c ->
            val cache = RolodexCache("2026-10-22T20:42:00Z", listOf(abbott, carter), ROLODEX_OPTIONS)
            runBlocking { c.db.meta().put(MetaEntity(ROLODEX_META_KEY, KioskJson.encodeToString(RolodexCache.serializer(), cache))) }
        }
        waitForText("Offline · showing the list from ")
        compose.onNodeWithText("Changes need a connection.", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("rolodex-new").assertIsNotEnabled()
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitFor("worker-name")
        compose.onNodeWithTag("worker-edit").assertIsNotEnabled()
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun editIsOffWithTheReasonWhenThePersonOutranksTheAdmin() {
        show(api().apply { rolodexWorkerResult = { rolodexDetail(abbott, canEdit = false) } })
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithTag("worker-edit").assertIsNotEnabled()
        compose.onNodeWithText("This person has a portal login ranked above yours.").assertIsDisplayed()
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun editSwitchesTheCardsToFieldsAndBlacklistAsksForANote() {
        show(api())
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithTag("worker-edit").assertIsEnabled().performClick()
        waitForText("Save changes")
        compose.onNodeWithText("First name *").assertExists()
        compose.onNodeWithTag("edit-status-note").assertDoesNotExist()
        compose.onNodeWithText("Blacklist").performScrollTo().performClick()       // below the fold on a phone
        waitFor("edit-status-note")
        compose.onNodeWithTag("edit-cancel").performScrollTo().performClick()
        waitFor("worker-edit")
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun searchNarrowsTheList() {
        show(api())
        compose.onNodeWithTag("rolodex-search").performTextInput("lead")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("rolodex-row-p-abbott").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("rolodex-row-p-carter").assertIsDisplayed()
    }

    /** Review Focus 4: Back while a save runs does nothing (it must not leave the route); the save's
     *  failure then shows on the form as typed, and Back after that cancels the form. */
    @Config(qualifiers = "w360dp-h800dp")
    @Test fun backWhileSavingKeepsTheFormAndItsError() {
        val gate = CompletableDeferred<Unit>()
        showRouted(api().apply { rolodexUpdateResult = { _, _ -> gate.await(); throw ApiError(423, "read_only_mode") } })
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithTag("worker-edit").performClick()
        waitFor("edit-job")
        compose.onNodeWithTag("edit-job").performTextReplacement("Lead rigger")
        compose.onNodeWithTag("edit-save").performScrollTo().performClick()
        waitForText("Saving…")

        pressBack()
        compose.waitForIdle()
        compose.onNodeWithText("home page").assertDoesNotExist()
        compose.onNodeWithTag("edit-save").assertExists()

        gate.complete(Unit)
        waitForText("The system is in read-only mode, so changes can't be saved right now.")
        compose.onNodeWithTag("edit-job").assertTextContains("Lead rigger")
        compose.onNodeWithText("home page").assertDoesNotExist()

        pressBack()                                                         // not saving now: Back cancels the form
        waitFor("worker-edit")
        compose.onNodeWithTag("edit-save").assertDoesNotExist()
    }

    /** Rulings S11 and S14: the split starts at a 720 dp window, measured outside the shell's padding. */
    @Config(qualifiers = "w720dp-h800dp")
    @Test fun aSevenTwentyDpWindowSplits() {
        showRouted(api())
        compose.onNodeWithText("Choose a worker to see their page.").assertIsDisplayed()
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithTag("rolodex-search").assertIsDisplayed()
        compose.onNodeWithText("‹ Rolodex").assertDoesNotExist()
    }

    @Config(qualifiers = "w719dp-h800dp")
    @Test fun aSevenNineteenDpWindowTakesTurns() {
        showRouted(api())
        compose.onNodeWithText("Choose a worker to see their page.").assertDoesNotExist()
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithText("‹ Rolodex").assertIsDisplayed()
        compose.onNodeWithTag("rolodex-search").assertDoesNotExist()
    }

    // ── Task 7 hooks: "+ New" and the camera badge ──

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun newOpensTheDetailsStepAndCancelGoesBack() {
        show(api())
        compose.onNodeWithTag("rolodex-new").assertIsEnabled().performClick()
        waitForText("STEP 1 OF 2 · DETAILS")
        compose.onNodeWithText("First name *").assertExists()
        compose.onNodeWithTag("new-worker-next").assertExists()
        compose.onNodeWithTag("rolodex-search").assertDoesNotExist()
        compose.onNodeWithTag("new-worker-cancel").performClick()
        waitFor("rolodex-search")
    }

    /** Spec §3.11: a device without a camera (as Robolectric reports) offers Choose photo only. */
    @Config(qualifiers = "w360dp-h800dp")
    @Test fun theCameraBadgeOffersChoosePhotoWithoutACamera() {
        show(api())
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithTag("worker-photo").assertIsEnabled().performClick()
        waitForText("Photo for Ann Abbott")
        compose.onNodeWithText("Choose photo").assertExists()
        compose.onNodeWithText("Take new photo").assertDoesNotExist()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Photo for Ann Abbott").fetchSemanticsNodes().isEmpty() }
    }

    /** M3: while a capture is on its way, "Continue without photo" is off; a failed capture turns it back on. */
    @Config(qualifiers = "w360dp-h800dp")
    @Test fun aCaptureOnItsWayTurnsContinueWithoutPhotoOff() {
        val c = admin(api())
        val vm = RolodexViewModel(c.api, c.db, c.rolodexCache)
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { RolodexContent(vm, onNewWorker = vm::startNewWorker, onChangePhoto = null) } }
        }
        waitFor("rolodex-row-p-abbott")
        compose.onNodeWithTag("rolodex-new").performClick()
        waitFor("new-first")
        compose.onNodeWithTag("new-first").performTextInput("Marcus")
        compose.onNodeWithTag("new-last").performTextInput("Reed")
        compose.onNodeWithTag("new-worker-next").performClick()
        waitFor("new-worker-skip-photo")
        compose.onNodeWithTag("new-worker-skip-photo").assertIsEnabled()

        compose.runOnUiThread { assertTrue(vm.newWorker.captureStarted()) }
        compose.waitForIdle()
        compose.onNodeWithTag("new-worker-skip-photo").assertIsNotEnabled().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Create Marcus Reed without a photo?").assertDoesNotExist()

        compose.runOnUiThread { vm.newWorker.captureFailed() }
        compose.waitForIdle()
        compose.onNodeWithTag("new-worker-skip-photo").assertIsEnabled().performClick()
        waitForText("Create Marcus Reed without a photo?")
    }

    /** The New worker details are typed into the form and Next runs the duplicate check. */
    @Config(qualifiers = "w360dp-h800dp")
    @Test fun nextFromTheDetailsChecksForDuplicates() {
        val api = api().apply { rolodexDuplicatesResult = { listOf(com.serversherpa.kiosk.core.model.RolodexMatch("p-abbott", "Ann Abbott", "Rigger", "Summit Crew", is_worker = true, matched_on = listOf("name"))) } }
        show(api)
        compose.onNodeWithTag("rolodex-new").performClick()
        waitFor("new-first")
        compose.onNodeWithTag("new-first").performTextInput("Ann")
        compose.onNodeWithTag("new-last").performTextInput("Abbott")
        compose.onNodeWithTag("new-worker-next").performClick()
        waitForText("Possible duplicate")
        compose.onNodeWithTag("duplicate-open-p-abbott").assertExists()
        compose.onNodeWithTag("duplicate-create-anyway").assertIsEnabled()
        compose.onNodeWithTag("duplicate-open-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithText("Possible duplicate").assertDoesNotExist()
    }
}
