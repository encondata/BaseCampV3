package com.serversherpa.kiosk.ui.screens.rolodex

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.ComponentDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.toSize
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
import java.util.Locale
import java.util.TimeZone
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/**
 * The worker page, as the Rolodex route shows it inside the kiosk shell: the larger photo view, its
 * "Previous jobs" section, and no Employee ID.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WorkerPageTest {
    private val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    private val zone = TimeZone.getDefault()
    private val locale = Locale.getDefault()

    /** The "Added Oct 3, 2026" lines are the device's zone and locale: pinned, so the host's don't matter. */
    @Before fun pin() {
        TimeZone.setDefault(TimeZone.getTimeZone("America/Chicago"))
        Locale.setDefault(Locale.US)
    }

    @After fun unpin() {
        TimeZone.setDefault(zone)
        Locale.setDefault(locale)
    }

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

    /**
     * [abbott] with a [width]×[height] solid red photo already in the photo cache (the viewer and
     * the avatar share it, so nothing is fetched). Each test passes its own [version].
     */
    private fun withPhoto(version: String, width: Int = 64, height: Int = 64): RolodexRow {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.RED) }
        WorkerPhotoCache.put(WorkerPhotoCache.key(abbott.person_id, version), bitmap.asImageBitmap())
        return abbott.copy(photo_url = "https://files.example/abbott.jpg?sig=1", photo_version = version)
    }

    private fun viewerShown() = compose.onAllNodesWithTag("photo-viewer").fetchSemanticsNodes().isNotEmpty()

    private fun waitForViewer(shown: Boolean) = compose.waitUntil(10_000) { viewerShown() == shown }

    /** The system Back, as the viewer's window gets it. */
    private fun pressBackInDialog() = compose.runOnUiThread {
        (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed()
    }

    // ── The photo, larger ──

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun tappingThePhotoOpensTheViewerAndCloseClosesIt() {
        val row = withPhoto("v-open")
        showPage(row, rolodexDetail(row))
        compose.onNodeWithTag("worker-photo-view").assertHasClickAction().performClick()
        waitForViewer(true)
        compose.onNodeWithTag("photo-viewer-image").assertIsDisplayed()
        compose.onNodeWithText("Photo for Ann Abbott").assertDoesNotExist()      // not the photo sheet
        compose.onNodeWithTag("photo-viewer-close").assertIsDisplayed().assertTextEquals("Close").performClick()
        waitForViewer(false)
        compose.onNodeWithTag("worker-name").assertIsDisplayed()
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun theCameraBadgeStillOpensThePhotoSheetNotTheViewer() {
        val row = withPhoto("v-badge")
        showPage(row, rolodexDetail(row))
        compose.onNodeWithTag("worker-photo").performClick()
        waitForText("Photo for Ann Abbott")
        assertTrue("the badge opened the viewer", !viewerShown())
    }

    /**
     * Turning a phone recreates the activity, and on a Pixel the landscape window is wide enough for
     * the split view, so the photo comes back somewhere else on the page: the viewer is still open.
     */
    @Config(qualifiers = "w360dp-h800dp")
    @Test fun theViewerStaysOpenWhenThePhoneTurnsIntoTheSplit() {
        val row = withPhoto("v-turn")
        val api = FakeKioskApi().apply {
            rolodexWorkersResult = { RolodexList("now", listOf(row)) }
            rolodexOptionsResult = { ROLODEX_OPTIONS }
            rolodexWorkerResult = { rolodexDetail(row) }
        }
        val c = testContainer(api = api).also { it.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60)) }
        val vm = RolodexViewModel(c.api, c.db, c.rolodexCache)                  // outlives the activity, as the real one does
        var widthDp = 360                                                       // not state: it changes only across the restore
        val tester = StateRestorationTester(compose)
        tester.setContent {
            val turned = Configuration(LocalConfiguration.current).apply { screenWidthDp = widthDp }
            CompositionLocalProvider(LocalAppContainer provides c, LocalConfiguration provides turned) {
                KioskTheme { RolodexContent(vm, onNewWorker = null, onChangePhoto = null) }
            }
        }
        waitFor("rolodex-row-p-abbott")
        compose.onNodeWithTag("rolodex-row-p-abbott").performClick()
        waitForText("ann@example.com")
        compose.onNodeWithTag("rolodex-search").assertDoesNotExist()           // the phone page
        compose.onNodeWithTag("worker-photo-view").performClick()
        waitForViewer(true)

        widthDp = 800
        tester.emulateSavedInstanceStateRestore()
        waitFor("rolodex-search")                                               // now the split view
        waitForViewer(true)
        compose.onNodeWithTag("photo-viewer-close").performClick()
        waitForViewer(false)
    }

    /** A badge that is off (the worker can't be edited) opens nothing: the tap doesn't reach the photo under it. */
    @Config(qualifiers = "w360dp-h800dp")
    @Test fun anOffBadgeOpensNothing() {
        val row = withPhoto("v-badge-off")
        showPage(row, rolodexDetail(row, canEdit = false))
        compose.onNodeWithTag("worker-photo").assertIsNotEnabled().performClick()
        compose.waitForIdle()
        assertTrue("the off badge opened the viewer", !viewerShown())
        compose.onNodeWithText("Photo for Ann Abbott").assertDoesNotExist()
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun backOrATapAnywhereClosesTheViewer() {
        val row = withPhoto("v-close")
        showPage(row, rolodexDetail(row))

        compose.onNodeWithTag("worker-photo-view").performClick()
        waitForViewer(true)
        pressBackInDialog()
        waitForViewer(false)
        compose.onNodeWithTag("worker-name").assertIsDisplayed()               // Back closed the viewer, not the page

        compose.onNodeWithTag("worker-photo-view").performClick()
        waitForViewer(true)
        compose.onNodeWithTag("photo-viewer").performTouchInput { click(Offset(width / 2f, height - 8f)) }   // the scrim
        waitForViewer(false)

        compose.onNodeWithTag("worker-photo-view").performClick()
        waitForViewer(true)
        compose.onNodeWithTag("photo-viewer-image").performClick()               // the photo itself
        waitForViewer(false)
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun withoutAPhotoTappingDoesNothing() {
        showPage(abbott, rolodexDetail(abbott))                                  // initials, no photo
        compose.onNodeWithTag("worker-photo-view").assertHasNoClickAction().performClick()
        compose.waitForIdle()
        assertTrue("a viewer opened without a photo", !viewerShown())
    }

    @Config(qualifiers = "w1280dp-h800dp-land")
    @Test fun theViewerOpensFromTheTabletSplitToo() {
        val row = withPhoto("v-split")
        showPage(row, rolodexDetail(row))
        compose.onNodeWithTag("rolodex-search").assertIsDisplayed()              // the split view
        compose.onNodeWithTag("worker-photo-view").performClick()
        waitForViewer(true)
        compose.onNodeWithTag("photo-viewer-close").performClick()
        waitForViewer(false)
    }

    /**
     * On a 320 dp handheld the viewer shows the whole photo (a portrait one here, which the avatar
     * crops to a circle): its corners are the photo's, not the scrim, and it fits the screen.
     */
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test fun theViewerShowsTheWholePhotoUnclippedAt320dp() {
        val row = withPhoto("v-whole", width = 60, height = 80)
        showPage(row, rolodexDetail(row))
        compose.onNodeWithTag("worker-photo-view").performClick()
        waitForViewer(true)
        compose.waitForIdle()

        val screen = compose.onNodeWithTag("photo-viewer").fetchSemanticsNode().boundsInWindow
        // unclipped: boundsInWindow would be cut to the screen and hide an overflow
        val image = compose.onNodeWithTag("photo-viewer-image").fetchSemanticsNode()
        val node = Rect(image.positionInWindow, image.size.toSize())
        val close = compose.onNodeWithTag("photo-viewer-close").fetchSemanticsNode().boundsInWindow
        assertTrue("the viewer isn't full width: $screen", screen.width >= 320 * 1.5f - 1f)
        for ((what, r) in listOf("photo" to node, "Close" to close)) {
            assertTrue("$what runs off the screen: $r in $screen", r.left >= screen.left && r.right <= screen.right && r.top >= screen.top && r.bottom <= screen.bottom)
        }
        assertTrue("Close sits over the photo: $close, $node", close.bottom <= node.top)

        // ContentScale.Fit: the photo's whole rectangle, centered in its box; its corners are photo,
        // not scrim. The viewer's window is drawn to a bitmap (captureToImage waits on a frame
        // callback Robolectric never sends).
        val shot = renderLatestDialog()
        val scale = minOf(node.width / 60f, node.height / 80f)
        val w = 60 * scale
        val h = 80 * scale
        val left = node.left + (node.width - w) / 2
        val top = node.top + (node.height - h) / 2
        assertTrue("the photo is small: ${w}x$h px", w >= 200 * 1.5f)
        for ((x, y) in listOf(left + 3 to top + 3, left + w - 4 to top + 3, left + 3 to top + h - 4, left + w - 4 to top + h - 4, left + w / 2 to top + h / 2)) {
            assertEquals("($x, $y) isn't the photo", android.graphics.Color.RED, shot.getPixel(x.toInt(), y.toInt()))
        }
        // Not cropped to fill its box: the portrait photo leaves dark scrim above and below it.
        assertTrue("no room above the photo to tell Fit from Crop: $top in $node", top - node.top >= 8)
        for (y in listOf(top - 4, top + h + 3, screen.bottom - 4)) {
            val px = shot.getPixel((left + w / 2).toInt(), y.toInt())
            assertTrue("($y) isn't the dark scrim: ${Integer.toHexString(px)}", android.graphics.Color.red(px) < 40 && android.graphics.Color.green(px) < 40)
        }
    }

    /** The latest dialog's window (the viewer) drawn in software, at its own pixel size. */
    private fun renderLatestDialog(): Bitmap {
        val decor = ShadowDialog.getLatestDialog().window!!.decorView
        val shot = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { decor.draw(android.graphics.Canvas(shot)) }
        return shot
    }

    // ── No Employee ID ──

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun neitherThePageNorTheEditFormShowsTheEmployeeId() {
        val row = abbott.copy(rfid_enrolled = true)
        showPage(row, rolodexDetail(row))                                        // its external_id is SC-1042
        compose.onNodeWithText("WORK").performScrollTo()
        compose.onNodeWithText("Employee ID", substring = true).assertDoesNotExist()
        compose.onNodeWithText("SC-1042", substring = true).assertDoesNotExist()

        compose.onNodeWithTag("worker-edit").performClick()
        waitFor("edit-save")
        compose.onNodeWithText("Employee ID", substring = true).assertDoesNotExist()
        compose.onNodeWithText("SC-1042", substring = true).assertDoesNotExist()
        compose.onNodeWithText("RFID enrolled").performScrollTo().assertIsDisplayed()          // the line keeps the RFID state
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun theEditFormSaysWhenRfidIsNotEnrolled() {
        showPage(abbott, rolodexDetail(abbott))
        compose.onNodeWithTag("worker-edit").performClick()
        waitFor("edit-save")
        compose.onNodeWithText("RFID not enrolled").performScrollTo().assertIsDisplayed()
    }

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

    /** A worker with more jobs than the page lists (the latest 50) says how many there are, below
     *  the last row; one with no more than are shown says nothing. */
    @Config(qualifiers = "w360dp-h800dp")
    @Test fun aLongHistorySaysHowManyJobsThereAre() {
        val fifty = (50 downTo 1).map { i -> migration.copy(initiative_id = "i-$i", initiative_name = "Job $i") }
        showPage(abbott, rolodexDetail(abbott, jobs = fifty, jobsTotal = 73))
        compose.onNodeWithText("Showing the latest 50 of 73 jobs.").performScrollTo().assertIsDisplayed()
        assertTrue(top("Job 1") < top("Showing the latest 50 of 73 jobs."))
    }

    @Config(qualifiers = "w360dp-h800dp")
    @Test fun aShortHistorySaysNothingMore() {
        showPage(abbott, rolodexDetail(abbott, jobs = listOf(migration, refresh)))
        compose.onNodeWithText("Spring Refresh").performScrollTo().assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithTag("worker-jobs-shown").fetchSemanticsNodes().size)
    }

    /** A long custom status keeps to 120 dp (ellipsized) on a 320 dp handheld, so the job's name
     *  keeps its room beside it. */
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test fun aLongStatusChipLeavesTheNameItsRoom() {
        val custom = migration.copy(status_label = "Awaiting client sign-off on the phase two cutover")
        showPage(abbott, rolodexDetail(abbott, jobs = listOf(custom)))
        compose.onNodeWithText(custom.initiative_name).performScrollTo().assertIsDisplayed()
        val chip = compose.onNodeWithTag("worker-job-status", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("the chip is wider than 120 dp: $chip", chip.width <= 120 * 1.5f + 0.5f)
        assertTrue("the status isn't ellipsized", layoutOf(custom.status_label).isLineEllipsized(0))
        val name = compose.onNodeWithText(custom.initiative_name, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("the name is squeezed: $name", name.width >= 120 * 1.5f)
        assertWhole(custom.initiative_name)
        assertTrue(name.right <= chip.left)
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
