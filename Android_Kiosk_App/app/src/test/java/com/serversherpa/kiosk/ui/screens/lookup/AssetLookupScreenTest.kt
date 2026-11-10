package com.serversherpa.kiosk.ui.screens.lookup

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
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
import com.serversherpa.kiosk.core.lookup.scanWhenText
import com.serversherpa.kiosk.core.model.AssetScanRow
import com.serversherpa.kiosk.core.model.KioskAssetDetail
import com.serversherpa.kiosk.core.model.KioskAssetEnd
import com.serversherpa.kiosk.core.model.KioskAssetFull
import com.serversherpa.kiosk.core.model.KioskAssetMove
import com.serversherpa.kiosk.core.model.KioskAssetRoute
import com.serversherpa.kiosk.core.model.KioskLookupMatch
import com.serversherpa.kiosk.core.model.KioskLookupResult
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.KioskApp
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Asset Lookup on screen: the tile, the setup gate, who sees what on the card, the offline
 * notice, the scanner and sled inputs, a 320 dp fit, and that nothing reaches the outbox.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class AssetLookupScreenTest {
    @get:Rule val compose = createComposeRule()

    private val selection = KioskSetupSelection("m1", "Move One", "s1", "Dock 4", "source", "pre_stage", "Pre-stage")
    private val scanPerms = mapOf("kiosk" to mapOf("view" to true), "scans" to mapOf("view" to true))

    private val oneRoute = KioskAssetRoute(
        "m1", "Move One",
        source = KioskAssetEnd(site_name = "Dallas DC", rack = "R12", ru = "14"),
        destination = KioskAssetEnd(site_name = "Austin DC", rack = "R40", ru = "22"),
    )
    private val workerDetail = KioskAssetDetail(
        "a1", name = "Core switch", make_model = "Dell R740", asset_tag = "102466",
        serial_number = "SN-100", rfid = "000000000000000000100418", routes = listOf(oneRoute),
    )
    private val adminFull = KioskAssetFull(
        status = "packed", status_label = "Packed", status_color = "#22aa55",
        moves = listOf(KioskAssetMove("m1", "Move One", "packed", "Loaded", "#3366ff")),
        container_name = "Crate 7", truck_name = "Truck 3",
    )
    private val scanRow = AssetScanRow(
        "s1", scanned_value = "102466", scan_type = "barcode", scan_type_label = "Barcode", scan_type_color = "#3366ff",
        status = "packed", status_label = "Packed", status_color = "#22aa55", scanned_at = "2026-11-08T21:05:00Z",
        device_id = "K-1", operator_name = "Tina T", site_name = "Dallas DC", location_detail = "Cage 4", off_move = true,
    )

    private fun one(id: String = "a1") = KioskLookupResult(listOf(KioskLookupMatch(id, "Core switch", "102466", "SN-100", listOf("asset_tag"))))

    /** A signed-in kiosk; set up for Move One at Dock 4 unless [setup] is false. */
    private fun rig(
        api: FakeKioskApi, admin: Boolean = false, scans: Boolean = admin, setup: Boolean = true,
        reader: FakeRfidReader = FakeRfidReader(),
    ): AppContainer {
        val c = testContainer(rfidReader = reader, api = api)
        runBlocking {
            c.identity.get()
            if (setup) { c.prefs.setSetupSelection(selection); c.prefs.setSetupState(SetupState.COMPLETE) }
            val base = if (admin) fakeSession(roles = listOf("admin"), maxRank = 60) else fakeSession()
            c.auth.completePair(if (scans) base.copy(perms = scanPerms) else base)
        }
        return c
    }

    /** The screen in a two-route graph, on a scrolling page as KioskShell hosts it. */
    private fun show(c: AppContainer): () -> NavHostController {
        var nav: NavHostController? = null
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    val n = rememberNavController().also { nav = it }
                    NavHost(n, startDestination = "lookup") {
                        composable("home") { Text("Home page") }
                        composable("lookup") { Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) { AssetLookupScreen(n) } }
                    }
                }
            }
        }
        return { nav!! }
    }

    private fun waitForText(text: String, substring: Boolean = false) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }

    /** Setup read from prefs: the Search button turns on. */
    private fun waitReady() = compose.waitUntil(5_000) {
        compose.onAllNodes(hasText("Search") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
    }

    private fun search(api: FakeKioskApi, value: String) {
        waitReady()
        compose.onNodeWithTag("scan-input").performTextReplacement(value)
        compose.onNodeWithText("Search").performClick()
        compose.waitUntilIdlingMain { "lookupAssets:$value" in api.calls }
    }

    /** The controller takes arm() and the connect on its own scope: give it a beat. */
    private fun settleSled() { compose.waitForIdle(); Thread.sleep(250); compose.waitForIdle() }

    private fun missing(text: String) = assertEquals("\"$text\" should not be shown", 0, compose.onAllNodesWithText(text).fetchSemanticsNodes().size)

    @Test fun tileOpensTheScreen() {
        val c = rig(FakeKioskApi(), admin = true)
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskApp() } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("tile-LOOKUP") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tile-LOOKUP").performScrollTo().performClick()
        waitForText("Asset tag, serial, RFID, or name")
        compose.waitForIdle()                                            // the navigation's fade
        compose.onNodeWithTag("tile-LOOKUP").assertDoesNotExist()
        compose.onNodeWithText("KIOSK · ASSET LOOKUP").assertIsDisplayed()   // PageHeader capitalizes the eyebrow
        compose.onNodeWithText("Asset Lookup").assertIsDisplayed()
        compose.onNodeWithText("Move One · Dock 4").assertIsDisplayed()
    }

    /** Before Kiosk Setup (a developer can reach the screen): nothing is looked up. */
    @Test fun greyedUntilSetup() {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> one() } }
        val c = rig(api, setup = false)
        runBlocking { c.prefs.setDevMode(true) }
        show(c)
        compose.waitForIdle()
        compose.onNodeWithText("Finish Kiosk Setup first.").assertIsDisplayed()
        compose.onNodeWithText("Search").assertIsNotEnabled()
        compose.onNodeWithTag("scan-input").assertIsNotEnabled()
        c.scanBus.publish(ScanEvent("102466", ScanSource.DATAWEDGE))
        compose.waitForIdle()
        Thread.sleep(200)
        compose.waitForIdle()
        assertFalse(api.calls.any { it.startsWith("lookupAssets") })
    }

    @Test fun workerSeesSourceAndDestinationOnly() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail }
        }
        val c = rig(api)
        show(c)
        search(api, "102466")
        waitForText("Core switch")
        compose.onNodeWithText("Dell R740").assertExists()
        compose.onNodeWithText("Source").assertExists()
        compose.onNodeWithText("Destination").assertExists()
        compose.onNodeWithText("Dallas DC").assertExists()
        compose.onNodeWithText("Austin DC").assertExists()
        compose.onNodeWithText("R12").assertExists()
        compose.onNodeWithText("22").assertExists()
        compose.onNodeWithText("100418").assertExists()                 // RFID in display form
        compose.onNodeWithText("SN-100").assertExists()
        missing("Moves"); missing("Current location"); missing("Scan history"); missing("Packed")
        missing("Move One")                                              // one route: no move name above it
        assertFalse(api.calls.any { it.startsWith("assetScans") })
    }

    @Test fun adminSeesFullCardAndHistory() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail.copy(full = adminFull) }
            assetScansResult = { _, _, _ -> listOf(scanRow, scanRow.copy(id = "s2", status_label = null, status_color = null, off_move = false, operator_name = null, device_id = "")) }
        }
        val c = rig(api, admin = true)
        show(c)
        search(api, "102466")
        waitForText("Tina T")
        compose.onNodeWithText("Current location").assertExists()
        compose.onNodeWithText("Crate 7 · on Truck 3").assertExists()
        // Following the web (058526e9e), the history rows carry no Location label or value.
        compose.onNodeWithText("Location").assertDoesNotExist()
        compose.onNodeWithText("Cage 4").assertDoesNotExist()
        compose.onNodeWithText("Moves").assertExists()
        compose.onNodeWithText("Move One").assertExists()
        compose.onNodeWithText("Loaded").assertExists()                  // the move's own status chip
        compose.onNodeWithText("Scan history").assertExists()
        compose.onNodeWithText("Off move").assertExists()
        assertEquals(1, compose.onAllNodesWithText("Off move").fetchSemanticsNodes().size)
        assertEquals(2, compose.onAllNodesWithText("Barcode").fetchSemanticsNodes().size)
        assertEquals(2, compose.onAllNodesWithText(scanWhenText("2026-11-08T21:05:00Z", ZoneId.systemDefault())).fetchSemanticsNodes().size)
        compose.onNodeWithText("K-1").assertExists()
        // the card's status chip, plus the first history row's
        assertEquals(2, compose.onAllNodesWithText("Packed").fetchSemanticsNodes().size)
        assertTrue(compose.onAllNodesWithText("—").fetchSemanticsNodes().size >= 3)   // second row's status, device, operator
        missing("Latest 50 scans shown.")
        assertEquals(1, api.calls.count { it.startsWith("assetScans") })
    }

    @Test fun fiftyScansSaySo() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail.copy(full = adminFull) }
            assetScansResult = { _, _, _ -> (1..50).map { scanRow.copy(id = "s$it", off_move = false) } }
        }
        show(rig(api, admin = true))
        search(api, "102466")
        waitForText("Latest 50 scans shown.")
    }

    @Test fun positionShownWhenNoRu() {
        val route = oneRoute.copy(
            source = KioskAssetEnd(site_name = "Dallas DC", rack = "R12", position = "Left"),
            destination = KioskAssetEnd(site_name = "Austin DC", rack = "R40", position = "Right"),
        )
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail.copy(routes = listOf(route)) }
        }
        show(rig(api))
        search(api, "102466")
        waitForText("Core switch")
        assertEquals(2, compose.onAllNodesWithText("Position").fetchSemanticsNodes().size)
        compose.onNodeWithText("Left").assertExists()
        compose.onNodeWithText("Right").assertExists()
        missing("RU")
    }

    @Test fun moveNamesShownForTwoRoutes() {
        val second = KioskAssetRoute("m2", "Move Two", KioskAssetEnd(site_name = "Austin DC"), KioskAssetEnd(site_name = "Reno DC"))
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail.copy(routes = listOf(oneRoute, second)) }
        }
        show(rig(api))
        search(api, "102466")
        waitForText("Move Two")
        compose.onNodeWithText("Move One").assertExists()
        assertEquals(2, compose.onAllNodesWithText("Source").fetchSemanticsNodes().size)
        assertEquals(2, compose.onAllNodesWithText("Destination").fetchSemanticsNodes().size)
        compose.onNodeWithText("Reno DC").assertExists()
    }

    @Test fun severalMatchesListAndPick() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ ->
                KioskLookupResult(listOf(
                    KioskLookupMatch("a1", "Core switch", "102466", "SN-100", listOf("asset_tag")),
                    KioskLookupMatch("a2", "Core router", "102467", null, listOf("rfid")),
                ), truncated = true)
            }
            assetDetailResult = { _, id -> workerDetail.copy(id = id, name = if (id == "a2") "Core router" else "Core switch") }
        }
        show(rig(api))
        search(api, "102466")
        waitForText("Core router")
        assertEquals(2, compose.onAllNodesWithText("Matched on").fetchSemanticsNodes().size)
        compose.onNodeWithText("RFID").assertExists()
        compose.onNodeWithText("Refine your search").assertExists()
        compose.onNodeWithText("Core router").performClick()
        compose.waitUntilIdlingMain { "assetDetail:a2" in api.calls }
        waitForText("Source")
    }

    /** On a phone the list stays (as on the web) and the picked card opens below it: it is
     *  scrolled into view rather than left off screen under 25 rows. */
    @Test @Config(qualifiers = "w360dp-h640dp") fun pickedCardIsBroughtIntoView() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ ->
                KioskLookupResult((1..25).map { KioskLookupMatch("a$it", "Rack switch $it", "1024$it", "SN-$it", listOf("name")) })
            }
            assetDetailResult = { _, id -> workerDetail.copy(id = id, name = "Card for $id") }
        }
        show(rig(api))
        search(api, "rack switch")
        waitForText("Rack switch 25")
        compose.onNodeWithText("Rack switch 25").performScrollTo().performClick()
        compose.waitUntilIdlingMain { "assetDetail:a25" in api.calls }
        waitForText("Card for a25")
        compose.waitForIdle()
        compose.onNodeWithText("Card for a25").assertIsDisplayed()
        compose.onNodeWithText("Rack switch 1").assertExists()          // the list is kept
    }

    @Test fun nameMatchesHideMatchedOn() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ ->
                KioskLookupResult(listOf(
                    KioskLookupMatch("a1", "Core switch", "102466", null, listOf("name")),
                    KioskLookupMatch("a2", null, "", null, listOf("name")),
                ))
            }
        }
        show(rig(api))
        search(api, "core")
        waitForText("Unnamed asset")
        missing("Matched on"); missing("Refine your search")
    }

    @Test fun missSaysSoAndKeepsTheValue() {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> KioskLookupResult() } }
        show(rig(api))
        search(api, "ZZ-9")
        waitForText("No asset matches ZZ-9.")
        compose.onNodeWithTag("scan-input").assert(hasText("ZZ-9"))
    }

    @Test fun offlineShowsNotice() {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> throw ApiError(0, "network", null) } }
        val c = rig(api, admin = true)
        runBlocking {
            val payload = """{"id":"a1","asset_id":"102466","name":"Core switch","serial_number":"SN-100","make_model":"Dell R740","source_rack":"R12","destination_rack":"R40","asset_status":"packed","asset_status_label":"Packed"}"""
            c.db.assets().insertAll(listOf(AssetEntity("a1", "102466", "Core switch", null, "SN-100", null, null, "Dell R740", null, "{}", payload)))
            c.db.meta().put(MetaEntity(MOVE_META_KEY, """{"initiativeId":"m1","initiativeName":"Move One","assets":1,"people":0,"containers":0,"trucks":0,"syncedAt":"2026-11-10T00:00:00Z"}"""))
        }
        show(c)
        search(api, "102466")
        waitForText("Offline — showing this move's devices only.")
        waitForText("Core switch")
        compose.onNodeWithText("Packed").assertExists()                  // a plain chip: no color offline
        compose.onNodeWithText("Scan history needs a connection.").assertExists()
        assertFalse(api.calls.any { it.startsWith("assetScans") })
    }

    @Test fun dataWedgeScanLooksUp() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail }
        }
        val c = rig(api)
        show(c)
        waitReady()
        c.scanBus.publish(ScanEvent("102466", ScanSource.DATAWEDGE))
        compose.waitUntilIdlingMain { "lookupAssets:102466" in api.calls }
        waitForText("Core switch")
    }

    /** The sled is armed while the screen is open (one tag read is looked up) and disarmed
     *  after leaving it, so Scanning's trigger behavior is untouched afterward. */
    @Test fun leavingDisarmsTheSled() {
        val reader = FakeRfidReader()
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail }
        }
        val c = rig(api, reader = reader)
        c.rfid.start()
        val nav = show(c)
        waitReady()
        runBlocking { c.rfid.connectNow() }
        settleSled()
        reader.emitTrigger(TriggerEvent.PRESSED)
        compose.waitUntilIdlingMain { reader.inventoryRunning }          // armed: the trigger reads
        reader.emitTag("100418"); reader.emitTag("100418")
        Thread.sleep(100)
        reader.emitTrigger(TriggerEvent.RELEASED)
        compose.waitUntilIdlingMain { "lookupAssets:000000000000000000100418" in api.calls }
        compose.waitUntilIdlingMain { !reader.inventoryRunning }

        compose.runOnIdle { nav().navigate("home") { popUpTo("lookup") { inclusive = true } } }
        waitForText("Home page")
        compose.waitForIdle()
        Thread.sleep(200)
        reader.emitTrigger(TriggerEvent.PRESSED)
        Thread.sleep(300)
        compose.waitForIdle()
        assertFalse("disarmed: the trigger no longer starts a read", reader.inventoryRunning)
        assertEquals(null, c.rfid.session.value)
    }

    /** A latched read shows the live read panel with its Stop button (the on-screen control
     *  for the trigger), and Stop ends the read and looks the one tag up. */
    @Test fun latchedReadShowsThePanelAndStopEndsIt() {
        val reader = FakeRfidReader()
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ -> workerDetail }
        }
        val c = rig(api, reader = reader)
        runBlocking { c.prefs.setRfid(DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerMode = RfidTriggerMode.TOGGLE)) }
        c.rfid.start()
        show(c)
        waitReady()
        runBlocking { c.rfid.connectNow() }
        settleSled()
        reader.emitTrigger(TriggerEvent.PRESSED)
        compose.waitUntilIdlingMain { reader.inventoryRunning }
        reader.emitTrigger(TriggerEvent.RELEASED)
        reader.emitTag("100418")
        waitForText("Reading…")
        compose.onNodeWithText("Stop").assertIsDisplayed().performClick()
        compose.waitUntilIdlingMain { !reader.inventoryRunning }
        compose.waitUntilIdlingMain { "lookupAssets:000000000000000000100418" in api.calls }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Reading…").fetchSemanticsNodes().isEmpty() }
        waitForText("Core switch")
    }

    /** The panel fits the MC2200: Stop stays on screen at 320 dp. */
    @Test @Config(qualifiers = "w320dp-h640dp") fun readPanelFitsAt320dp() {
        val reader = FakeRfidReader()
        val c = rig(FakeKioskApi(), reader = reader)
        runBlocking { c.prefs.setRfid(DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerMode = RfidTriggerMode.TOGGLE)) }
        c.rfid.start()
        show(c)
        waitReady()
        runBlocking { c.rfid.connectNow() }
        settleSled()
        reader.emitTrigger(TriggerEvent.PRESSED)
        compose.waitUntilIdlingMain { reader.inventoryRunning }
        reader.emitTrigger(TriggerEvent.RELEASED)
        reader.emitTag("000000000000000000100418")
        waitForText("Reading…")
        val width = compose.onRoot().fetchSemanticsNode().size.width
        val b = compose.onNodeWithText("Stop").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("clipped: ${b.right} > $width", b.right <= width + 1f)
        compose.onNodeWithText("Stop").performClick()
        compose.waitUntilIdlingMain { !reader.inventoryRunning }
    }

    @Test fun sweepOfSeveralTagsSaysSo() {
        val reader = FakeRfidReader()
        val api = FakeKioskApi()
        val c = rig(api, reader = reader)
        c.rfid.start()
        show(c)
        waitReady()
        runBlocking { c.rfid.connectNow() }
        settleSled()
        reader.emitTrigger(TriggerEvent.PRESSED)
        compose.waitUntilIdlingMain { reader.inventoryRunning }
        reader.emitTag("100418"); reader.emitTag("100419")
        Thread.sleep(100)
        reader.emitTrigger(TriggerEvent.RELEASED)
        waitForText("2 tags read. Point the reader at one tag and try again.")
        assertFalse(api.calls.any { it.startsWith("lookupAssets") })
    }

    @Test @Config(qualifiers = "w320dp-h640dp") fun fitsAt320dp() {
        val long = "Very long asset name for the primary core switch in the north hall of building seven"
        val route = KioskAssetRoute(
            "m1", "Move One",
            source = KioskAssetEnd(site_name = "Dallas North Data Center Building Seven Hall B", rack = "RACK-NORTH-HALL-B-0042", ru = "14"),
            destination = KioskAssetEnd(site_name = "Austin South Colocation Facility Cage 19", rack = "RACK-SOUTH-CAGE-19-0007", ru = "22"),
        )
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one() }
            assetDetailResult = { _, _ ->
                workerDetail.copy(
                    name = long, make_model = "Hewlett Packard Enterprise ProLiant DL380 Gen10 Plus",
                    serial_number = "SN-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", routes = listOf(route),
                    full = adminFull.copy(container_name = "Crate 7 with an unusually long container name", truck_name = "Truck 3 from Dallas to Austin"),
                )
            }
            assetScansResult = { _, _, _ -> listOf(scanRow.copy(location_detail = "Loading dock four, staging lane B, second pallet row")) }
        }
        show(rig(api, admin = true))
        waitReady()
        val width = compose.onRoot().fetchSemanticsNode().size.width
        fun SemanticsNodeInteraction.inside() = apply {
            val b = fetchSemanticsNode().boundsInRoot
            assertTrue("clipped: ${b.right} > $width", b.right <= width + 1f)
            assertTrue("clipped on the left: ${b.left}", b.left >= -1f)
        }
        compose.onNodeWithText("Search").assertIsDisplayed().inside()
        compose.onNodeWithText("Clear").assertIsDisplayed().inside()
        search(api, "102466")
        waitForText("Tina T")
        for (label in listOf("Asset tag", "Serial", "RFID", "Current location", "Source", "Destination", "Site", "Rack", "RU", "Moves", "Scan history", "Device", "Operator")) {
            compose.onAllNodesWithText(label).fetchSemanticsNodes().also { assertTrue("missing $label", it.isNotEmpty()) }
        }
        compose.onNodeWithText("Current location").performScrollTo().assertIsDisplayed().inside()
        compose.onAllNodesWithText("Destination")[0].performScrollTo().assertIsDisplayed().inside()
        compose.onNodeWithText(long).performScrollTo().assertIsDisplayed().inside()
        compose.onNodeWithText("SN-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ").performScrollTo().assertIsDisplayed().inside()
        compose.onNodeWithText("RACK-NORTH-HALL-B-0042").performScrollTo().assertIsDisplayed().inside()
        compose.onNodeWithText("Crate 7 with an unusually long container name · on Truck 3 from Dallas to Austin").performScrollTo().assertIsDisplayed().inside()
        compose.onNodeWithText("Loading dock four, staging lane B, second pallet row").assertDoesNotExist()
        compose.onNodeWithText("Location").assertDoesNotExist()
        compose.onNodeWithText("Search").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Clear").assertIsDisplayed()
    }

    @Test fun outboxStaysEmpty() {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, v -> if (v == "none") KioskLookupResult() else one() }
            assetDetailResult = { _, _ -> workerDetail.copy(full = adminFull) }
            assetScansResult = { _, _, _ -> listOf(scanRow) }
        }
        val c = rig(api, admin = true)
        show(c)
        search(api, "102466")
        waitForText("Tina T")
        search(api, "none")
        waitForText("No asset matches none.")
        waitReady()
        c.scanBus.publish(ScanEvent("SN-100", ScanSource.DATAWEDGE))
        compose.waitUntilIdlingMain { "lookupAssets:SN-100" in api.calls }
        waitForText("Tina T")
        assertEquals(0, runBlocking { c.db.outbox().all().size })
    }
}
