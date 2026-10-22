package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.TextLayoutResult
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexJob
import com.serversherpa.kiosk.core.model.RolodexList
import com.serversherpa.kiosk.core.model.RolodexRow
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The worker page, as the Rolodex route shows it inside the kiosk shell: its "Previous jobs" section. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WorkerPageTest {
    private val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    private val abbott = rolodexRow("p-abbott", "Ann", "Abbott", job = "Rigger", company = "Summit Crew")

    private val migration = RolodexJob(
        "i-2", "NAP11 Hall Migration", type_label = "Move", type_color = "#a36207", status_label = "In progress",
        status_color = "#1668a7", work_type_label = "Lead", site_worked_name = "NAP11 Las Vegas", added_at = "2026-10-03T15:00:00Z",
    )
    private val refresh = RolodexJob(
        "i-1", "Spring Refresh", type_label = "Project", type_color = "#1668a7", status_label = "Completed",
        status_color = "#178a4c", added_at = "2026-03-02T15:00:00Z",
    )

    /** The Rolodex route inside the kiosk shell (16 dp gutters), with [row]'s page open; its detail is [detail]. */
    private fun showPage(row: RolodexRow, detail: RolodexDetail) {
        val api = FakeKioskApi().apply {
            rolodexWorkersResult = { RolodexList("now", listOf(row)) }
            rolodexOptionsResult = { ROLODEX_OPTIONS }
            rolodexWorkerResult = { detail }
        }
        val c = testContainer(api = api).also { it.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60)) }
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
        waitFor("rolodex-row-${row.person_id}")
        compose.onNodeWithTag("rolodex-row-${row.person_id}").performClick()
        waitForText(detail.email!!)
    }

    private fun waitFor(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForText(text: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

    private fun layoutOf(text: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    /** [text] shows in full on its lines (nothing ellipsized or cut off below), inside the screen. */
    private fun assertWhole(text: String) {
        val layout = layoutOf(text)
        val last = layout.lineCount - 1
        assertTrue("$text is ellipsized", !layout.isLineEllipsized(last))
        assertTrue("$text is cut off below", !layout.didOverflowHeight)
        assertEquals("$text lost characters", text.length, layout.getLineEnd(last, visibleEnd = true))
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("$text runs off the screen: $node in $root", node.left >= root.left && node.right <= root.right)
    }

    private fun top(text: String) = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top

    // ── Previous jobs ──

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun previousJobsListEachJobNewestFirst() {
        showPage(abbott, rolodexDetail(abbott, jobs = listOf(migration, refresh)))
        for (text in listOf(
            "PREVIOUS JOBS", "NAP11 Hall Migration", "Move · Lead · NAP11 Las Vegas", "In progress", "Added Oct 3, 2026",
            "Spring Refresh", "Project", "Completed", "Added Mar 2, 2026",          // no work type, no site: just the type
        )) compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("No jobs yet.").assertDoesNotExist()
        // below the details, in the API's order
        assertTrue(top("WORK") < top("PREVIOUS JOBS"))
        assertTrue(top("NAP11 Hall Migration") < top("Spring Refresh"))
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun aWorkerWithNoJobsSaysSo() {
        showPage(abbott, rolodexDetail(abbott))
        compose.onNodeWithText("PREVIOUS JOBS").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("No jobs yet.").performScrollTo().assertIsDisplayed()
    }

    /** A long name wraps on a 320 dp handheld; the line, the chip and the date stay whole beside it. */
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test fun previousJobsFitA320dpHandheld() {
        val long = migration.copy(
            initiative_name = "Las Vegas NAP11 Hall C Overnight Migration and Decommission, Phase Two",
            site_worked_name = "Switch Las Vegas Core Campus Building 11",
        )
        showPage(abbott, rolodexDetail(abbott, jobs = listOf(long)))
        compose.onNodeWithText("Added Oct 3, 2026").performScrollTo()
        for (text in listOf(long.initiative_name, "Move · Lead · Switch Las Vegas Core Campus Building 11", "In progress", "Added Oct 3, 2026")) {
            compose.onNodeWithText(text).assertIsDisplayed()
            assertWhole(text)
        }
        assertTrue("the long name wraps", layoutOf(long.initiative_name).lineCount > 1)
    }
}
