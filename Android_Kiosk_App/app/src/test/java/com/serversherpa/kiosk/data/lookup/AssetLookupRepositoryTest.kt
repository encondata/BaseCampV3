package com.serversherpa.kiosk.data.lookup

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskAssetDetail
import com.serversherpa.kiosk.core.model.KioskLookupMatch
import com.serversherpa.kiosk.core.model.KioskLookupResult
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.ContainerEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Runnable
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssetLookupRepositoryTest {
    private val payload = """{"id":"a1","asset_id":"A-1","name":"Core switch","rfid":null,"serial_number":"SN-100","make":"Dell","model":"R740","make_model":"Dell R740","container_id":"c1","source_rack":"R12","source_ru":"14","destination_rack":"R40","destination_ru":"20","asset_status":"staged","asset_status_label":"Staged","location_detail":"","extra_unknown":1}"""

    private suspend fun seeded(labelContext: String = """{"source_site":"Old DC","destination_site":"New DC","other":1}"""): KioskDatabase {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            AssetEntity("a1", "A-1", "Core switch", null, "SN-100", "Dell", "R740", "Dell R740", "c1", "{}", payload),
            AssetEntity("bad", "B-1", "Broken", null, null, null, null, "", null, "{}", "not json"),
        ))
        db.containers().insertAll(listOf(ContainerEntity("c1", "Crate 7", null, null, null, "open", "Open", null, null, 1)))
        db.meta().put(MetaEntity(LABEL_CONTEXT_META_KEY, labelContext))
        db.meta().put(MetaEntity(MOVE_META_KEY, """{"initiativeId":"m1","initiativeName":"Move One","assets":1,"people":0,"containers":1,"trucks":0,"syncedAt":"2026-11-10T00:00:00Z"}"""))
        return db
    }

    private fun offlineApi() = FakeKioskApi().apply {
        lookupAssetsResult = { _, _ -> throw ApiError(0, "network", null) }
        assetDetailResult = { _, _ -> throw ApiError(0, "network", null) }
        assetScansResult = { _, _, _ -> throw ApiError(0, "network", null) }
    }

    @Test fun onlineUsesTheApi() = runTest {
        val db = seeded()
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> KioskLookupResult(listOf(KioskLookupMatch("x9", "Remote", "R-9"))) }
        }
        val found = AssetLookupRepository(api, db).find("K1", "SN-100")
        assertFalse(found.offline)
        assertEquals("x9", found.result.matches.single().id)
        assertEquals(0, db.outbox().all().size)
    }

    @Test fun networkErrorFallsBackToSyncedAssets() = runTest {
        val db = seeded()
        val found = AssetLookupRepository(offlineApi(), db).find("K1", "SN-100")
        assertTrue(found.offline)
        assertEquals("a1", found.result.matches.single().id)
        assertEquals(0, db.outbox().all().size)
    }

    @Test fun edgeOfflineCodeFallsBack() = runTest {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> throw ApiError(502, "edge_offline", null) } }
        assertTrue(AssetLookupRepository(api, seeded()).find("K1", "SN-100").offline)
    }

    @Test fun detailFallsBackWhenNetworkDropsAfterLookup() = runTest {
        val db = seeded()
        val api = offlineApi().apply {
            lookupAssetsResult = { _, _ -> KioskLookupResult(listOf(KioskLookupMatch("a1", "Core switch", "A-1"))) }
        }
        val repo = AssetLookupRepository(api, db)
        assertFalse(repo.find("K1", "A-1").offline)
        val opened = repo.open("K1", "a1", offline = false, admin = true)
        assertTrue(opened.offline)
        assertEquals("a1", opened.detail!!.id)
        assertEquals("Crate 7", opened.detail!!.full!!.container_name)
    }

    @Test fun offlineSkipsTheApiAndNonAdminHasNoFullCard() = runTest {
        val api = FakeKioskApi()
        val opened = AssetLookupRepository(api, seeded()).open("K1", "a1", offline = true, admin = false)
        assertTrue(opened.offline)
        assertNull(opened.detail!!.full)
        assertTrue(api.calls.isEmpty())
    }

    @Test fun onlineDetailPassesThrough() = runTest {
        val api = FakeKioskApi().apply { assetDetailResult = { _, id -> KioskAssetDetail(id = id) } }
        val opened = AssetLookupRepository(api, seeded()).open("K1", "zz", offline = false, admin = true)
        assertFalse(opened.offline)
        assertEquals("zz", opened.detail!!.id)
    }

    @Test fun forbiddenDoesNotFallBack() = runTest {
        for (status in listOf(404, 403)) {
            val api = FakeKioskApi().apply {
                lookupAssetsResult = { _, _ -> throw ApiError(status, "nope", null) }
                assetDetailResult = { _, _ -> throw ApiError(status, "nope", null) }
            }
            val repo = AssetLookupRepository(api, seeded())
            try { repo.find("K1", "SN-100"); fail("find should throw") } catch (e: ApiError) { assertEquals(status, e.status) }
            try { repo.open("K1", "a1", offline = false, admin = true); fail("open should throw") } catch (e: ApiError) { assertEquals(status, e.status) }
        }
    }

    @Test fun offlineDetailCarriesSitesFromLabelContext() = runTest {
        val d = AssetLookupRepository(offlineApi(), seeded()).open("K1", "a1", offline = false, admin = false).detail!!
        val route = d.routes.single()
        assertEquals("m1", route.initiative_id)
        assertEquals("Move One", route.initiative_name)
        assertEquals("Old DC", route.source.site_name)
        assertEquals("New DC", route.destination.site_name)
        assertEquals("R12", route.source.rack)
        assertEquals("20", route.destination.ru)
    }

    @Test fun blankOrUnreadableLabelContextGivesNoSites() = runTest {
        for (ctx in listOf("null", "{not json", """{"source_site":"","destination_site":5}""")) {
            val data = AssetLookupRepository(offlineApi(), seeded(ctx)).loadLocal()
            assertNull(ctx, data.sourceSite)
            assertNull(ctx, data.destinationSite)
        }
    }

    @Test fun unknownIdOfflineIsNull() = runTest {
        val opened = AssetLookupRepository(offlineApi(), seeded()).open("K1", "nope", offline = true, admin = true)
        assertTrue(opened.offline)
        assertNull(opened.detail)
    }

    @Test fun loadLocalSkipsUndecodableRows() = runTest {
        val data = AssetLookupRepository(offlineApi(), seeded()).loadLocal()
        assertEquals(listOf("a1"), data.assets.map { it.id })
        assertEquals("Crate 7", data.containerNames["c1"])
    }

    @Test fun scansUseTheLimitAndPropagateErrors() = runTest {
        val api = FakeKioskApi().apply { assetScansResult = { _, _, limit -> assertEquals(50, limit); emptyList() } }
        assertTrue(AssetLookupRepository(api, seeded()).scans("K1", "a1").isEmpty())
        try { AssetLookupRepository(offlineApi(), seeded()).scans("K1", "a1"); fail() } catch (e: ApiError) { assertTrue(e.isNetwork) }
    }

    /** Counts the hops onto it, then runs the work on Default as production does. */
    private class CountingDispatcher : CoroutineDispatcher() {
        val hops = AtomicInteger()
        override fun dispatch(context: CoroutineContext, block: Runnable) {
            hops.incrementAndGet()
            Dispatchers.Default.dispatch(context, block)
        }
    }

    /** Decoding every synced payload is CPU work: it runs on the injected (Default) dispatcher,
     *  not the caller's (Main) thread, and only when the lookup actually falls back. */
    @Test fun offlineDecodeRunsOffTheCallersThread() = runTest {
        val decode = CountingDispatcher()
        val online = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> KioskLookupResult() } }
        AssetLookupRepository(online, seeded(), decode).find("K1", "SN-100")
        assertEquals("an online answer decodes nothing", 0, decode.hops.get())

        val found = AssetLookupRepository(offlineApi(), seeded(), decode).find("K1", "SN-100")
        assertEquals("a1", found.result.matches.single().id)
        assertTrue("the fallback decodes on the injected dispatcher", decode.hops.get() > 0)
    }

    /** One offline lookup decodes once: the single match's open reuses what find loaded. */
    @Test fun anOfflineOpenReusesTheFindsData() = runTest {
        val decode = CountingDispatcher()
        val repo = AssetLookupRepository(offlineApi(), seeded(), decode)
        repo.find("K1", "SN-100")
        val afterFind = decode.hops.get()
        val opened = repo.open("K1", "a1", offline = true, admin = false)
        assertEquals("a1", opened.detail!!.id)
        assertEquals("no second decode", afterFind, decode.hops.get())
        repo.open("K1", "a1", offline = true, admin = false)
        assertTrue("used once: a later open loads fresh", decode.hops.get() > afterFind)
    }

    @Test fun nothingIsWrittenToTheOutbox() = runTest {
        val db = seeded()
        val repo = AssetLookupRepository(offlineApi(), db)
        repo.find("K1", "A-1"); repo.open("K1", "a1", false, true); repo.loadLocal()
        assertEquals(0, db.outbox().all().size)
        assertNotNull(db.assets().all())
    }
}
