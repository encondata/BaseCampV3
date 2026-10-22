package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexList
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.ROLODEX_META_KEY
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RolodexScreenTest {
    @get:Rule val compose = createComposeRule()

    private val abbott = rolodexRow("p-abbott", "Ann", "Abbott", job = "Rigger", company = "Summit Crew")
    private val carter = rolodexRow("p-carter", "Ben", "Carter", job = "Lead tech", status = "standby", hasPhoto = false)

    private fun api() = FakeKioskApi().apply {
        rolodexWorkersResult = { RolodexList("now", listOf(carter, abbott)) }
        rolodexOptionsResult = { ROLODEX_OPTIONS }
        rolodexWorkerResult = { id -> rolodexDetail(listOf(abbott, carter).first { it.person_id == id }) }
    }

    private fun show(api: FakeKioskApi, prepare: (AppContainer) -> Unit = {}): AppContainer {
        val c = testContainer(api = api)
        prepare(c)
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { RolodexScreen(rememberNavController()) } }
        }
        waitFor("rolodex-row-p-abbott")
        return c
    }

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
}
