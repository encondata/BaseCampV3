package com.serversherpa.kiosk.ui.screens.lookup

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.AssetScanRow
import com.serversherpa.kiosk.core.model.KioskAssetDetail
import com.serversherpa.kiosk.core.model.KioskAssetFull
import com.serversherpa.kiosk.core.model.KioskAssetMove
import com.serversherpa.kiosk.core.model.KioskLookupMatch
import com.serversherpa.kiosk.core.model.KioskLookupResult
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.lookup.AssetLookupRepository
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssetLookupViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    /** As in EnrollViewModelTest: Room and DataStore hop off the test dispatcher,
     *  so each round gets a short real sleep before running what came back.
     *  Ten rounds: an offline open reads several tables twice (find, then open). */
    private fun TestScope.settle() { repeat(10) { Thread.sleep(50); runCurrent() } }

    private val payload = """{"id":"a1","asset_id":"A-1","name":"Core switch","serial_number":"SN-100","make_model":"Dell R740","source_rack":"R12","destination_rack":"R40"}"""
    private val payload2 = """{"id":"a2","asset_id":"A-2","name":"Core router","serial_number":"SN-200","make_model":"Cisco"}"""

    private class Built(val vm: AssetLookupViewModel, val db: KioskDatabase)

    private suspend fun TestScope.build(
        api: FakeKioskApi, admin: Boolean = false, scans: Boolean = false,
    ): Built {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            AssetEntity("a1", "A-1", "Core switch", null, "SN-100", null, null, "Dell R740", null, "{}", payload),
            AssetEntity("a2", "A-2", "Core router", null, "SN-200", null, null, "Cisco", null, "{}", payload2),
        ))
        db.meta().put(MetaEntity(MOVE_META_KEY, """{"initiativeId":"m1","initiativeName":"Move One","assets":2,"people":0,"containers":0,"trucks":0,"syncedAt":"2026-11-10T00:00:00Z"}"""))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.newFolder(), "lookup.preferences_pb") })
        val vm = AssetLookupViewModel(
            AssetLookupRepository(api, db), Identity(prefs),
            isAdmin = { admin }, canScans = { scans }, scopeOverride = backgroundScope,
        )
        settle()
        return Built(vm, db)
    }

    private fun one(id: String) = KioskLookupResult(listOf(KioskLookupMatch(id, "Asset $id", "T-$id")))
    private fun detail(id: String, full: KioskAssetFull? = null) = KioskAssetDetail(id, name = "Asset $id", asset_tag = "T-$id", full = full)
    private val onMove = KioskAssetFull(moves = listOf(KioskAssetMove("m1", "Move One")))
    private fun row(id: String) = AssetScanRow(id, scanned_at = "2026-11-10T12:00:00Z")
    private fun FakeKioskApi.count(prefix: String) = calls.count { it.startsWith(prefix) }

    @Test fun oneMatchOpensDetail() = runTest {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one("x1") }
            assetDetailResult = { _, id -> detail(id) }
        }
        val b = build(api)
        b.vm.onScan("A-1"); settle()
        val ui = b.vm.ui.value
        assertEquals("x1", ui.detail?.id)
        assertEquals("", ui.value)
        assertNull(ui.list); assertNull(ui.miss); assertNull(ui.error)
        assertEquals(false, ui.offline)
        assertEquals(ScanHistory.Hidden, ui.scans)
        assertEquals(listOf("lookupAssets:A-1", "assetDetail:x1"), api.calls)
        assertEquals(0, b.db.outbox().all().size)
    }

    @Test fun severalMatchesShowList() = runTest {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> KioskLookupResult(listOf(KioskLookupMatch("x1", "One"), KioskLookupMatch("x2", "Two"))) }
            assetDetailResult = { _, id -> detail(id) }
        }
        val b = build(api)
        b.vm.onValueChange("core"); b.vm.lookup(); settle()
        assertEquals(listOf("x1", "x2"), b.vm.ui.value.list?.matches?.map { it.id })
        assertNull(b.vm.ui.value.detail)
        assertEquals(0, api.count("assetDetail"))

        b.vm.pick("x2"); settle()
        assertEquals("x2", b.vm.ui.value.detail?.id)
        assertEquals("assetDetail:x2", api.calls.last())
    }

    /** pick opens with the offline flag the list came with: offline, no API detail call. */
    @Test fun pickFromAnOfflineListUsesSyncedRows() = runTest {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> throw ApiError(0, "network", null) }
            assetDetailResult = { _, id -> detail(id) }
        }
        val b = build(api)
        b.vm.onScan("core"); settle()
        assertEquals(true, b.vm.ui.value.offline)
        assertEquals(listOf("a2", "a1"), b.vm.ui.value.list?.matches?.map { it.id })
        b.vm.pick("a1"); settle()
        assertEquals("Core switch", b.vm.ui.value.detail?.name)
        assertEquals(true, b.vm.ui.value.offline)
        assertEquals(0, api.count("assetDetail"))
    }

    @Test fun noMatchKeepsValueAndSaysSo() = runTest {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> KioskLookupResult() } }
        val b = build(api)
        b.vm.onScan("zz-9"); settle()
        assertEquals("zz-9", b.vm.ui.value.miss)
        assertEquals("zz-9", b.vm.ui.value.value)
        assertNull(b.vm.ui.value.error)
    }

    @Test fun errorKeepsValue() = runTest {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> throw ApiError(500, "boom", null) } }
        val b = build(api)
        b.vm.onScan("A-1"); settle()
        assertEquals("Couldn't look that up. Try again.", b.vm.ui.value.error)
        assertEquals("A-1", b.vm.ui.value.value)
        assertNull(b.vm.ui.value.miss)
    }

    /** Online lookup finds it, the details call drops off the network, and the
     *  synced copy doesn't have it: "Couldn't load that asset." */
    @Test fun missingDetailSaysCouldNotLoad() = runTest {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one("gone") }
            assetDetailResult = { _, _ -> throw ApiError(0, "network", null) }
        }
        val b = build(api)
        b.vm.onScan("gone"); settle()
        assertEquals("Couldn't load that asset.", b.vm.ui.value.error)
        assertEquals(true, b.vm.ui.value.offline)
        assertNull(b.vm.ui.value.detail)
    }

    @Test fun pickErrorSaysCouldNotLookUp() = runTest {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> KioskLookupResult(listOf(KioskLookupMatch("x1"), KioskLookupMatch("x2"))) }
            assetDetailResult = { _, _ -> throw ApiError(500, "boom", null) }
        }
        val b = build(api)
        b.vm.onScan("x"); settle()
        b.vm.pick("x1"); settle()
        assertEquals("Couldn't look that up. Try again.", b.vm.ui.value.error)
        assertNull(b.vm.ui.value.detail)
    }

    @Test fun newerLookupWins() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, v -> if (v == "first") { gate.await(); one("old") } else one("new") }
            assetDetailResult = { _, id -> detail(id) }
        }
        val b = build(api)
        b.vm.onScan("first"); settle()
        b.vm.onScan("second"); settle()
        assertEquals("new", b.vm.ui.value.detail?.id)
        gate.complete(Unit); settle()
        assertEquals("new", b.vm.ui.value.detail?.id)
        assertEquals(0, api.calls.count { it == "assetDetail:old" })
        assertNull(b.vm.ui.value.error)
    }

    @Test fun clearDropsInFlightAnswer() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> gate.await(); one("x1") }
            assetDetailResult = { _, id -> detail(id) }
        }
        val b = build(api)
        b.vm.onScan("A-1"); settle()
        b.vm.clear()
        gate.complete(Unit); settle()
        assertEquals(LookupUi(), b.vm.ui.value)
        assertEquals(0, api.count("assetDetail"))
    }

    @Test fun scansOnlyForAdminWithScansViewOnMovedDevice() = runTest {
        data class Case(val name: String, val admin: Boolean, val scans: Boolean, val full: KioskAssetFull?, val expectCalls: Int)
        val cases = listOf(
            Case("worker", admin = false, scans = false, full = null, expectCalls = 0),
            Case("admin without scans:view", admin = true, scans = false, full = onMove, expectCalls = 0),
            Case("admin on no move", admin = true, scans = true, full = KioskAssetFull(), expectCalls = 0),
            Case("admin + scans:view + move", admin = true, scans = true, full = onMove, expectCalls = 1),
        )
        for (c in cases) {
            val api = FakeKioskApi().apply {
                lookupAssetsResult = { _, _ -> one("x1") }
                assetDetailResult = { _, id -> detail(id, c.full) }
                assetScansResult = { _, _, limit -> assertEquals(50, limit); listOf(row("s1"), row("s2")) }
            }
            val b = build(api, admin = c.admin, scans = c.scans)
            b.vm.onScan("A-1"); settle()
            assertEquals(c.name, "x1", b.vm.ui.value.detail?.id)
            assertEquals(c.name, c.expectCalls, api.count("assetScans"))
            val expected = if (c.expectCalls == 1) ScanHistory.Rows(listOf(row("s1"), row("s2"))) else ScanHistory.Hidden
            assertEquals(c.name, expected, b.vm.ui.value.scans)
        }
    }

    /** Offline, an admin still gets the full card, but no history call is made. */
    @Test fun offlineAdminCardLoadsNoScans() = runTest {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> throw ApiError(0, "network", null) }
            assetScansResult = { _, _, _ -> listOf(row("s1")) }
        }
        val b = build(api, admin = true, scans = true)
        b.vm.onScan("SN-100"); settle()
        val ui = b.vm.ui.value
        assertEquals(true, ui.offline)
        assertEquals(ui.toString(), "a1", ui.detail?.id)
        assertEquals(1, ui.detail?.full?.moves?.size)
        assertEquals(ScanHistory.Hidden, ui.scans)
        assertEquals(0, api.count("assetScans"))
    }

    @Test fun scanFailureShowsFailed() = runTest {
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, _ -> one("x1") }
            assetDetailResult = { _, id -> detail(id, onMove) }
            assetScansResult = { _, _, _ -> throw ApiError(500, "boom", null) }
        }
        val b = build(api, admin = true, scans = true)
        b.vm.onScan("A-1"); settle()
        assertEquals(ScanHistory.Failed, b.vm.ui.value.scans)
        assertEquals("x1", b.vm.ui.value.detail?.id)
        assertNull(b.vm.ui.value.error)
    }

    @Test fun scanHistoryShowsLoadingThenDropsWhenStale() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = FakeKioskApi().apply {
            lookupAssetsResult = { _, v -> one(v) }
            assetDetailResult = { _, id -> detail(id, if (id == "x1") onMove else null) }
            assetScansResult = { _, _, _ -> gate.await(); listOf(row("s1")) }
        }
        val b = build(api, admin = true, scans = true)
        b.vm.onScan("x1"); settle()
        assertEquals(ScanHistory.Loading, b.vm.ui.value.scans)
        b.vm.onScan("x2"); settle()
        assertEquals("x2", b.vm.ui.value.detail?.id)
        gate.complete(Unit); settle()
        assertEquals("x2", b.vm.ui.value.detail?.id)
        assertEquals(ScanHistory.Hidden, b.vm.ui.value.scans)
    }

    @Test fun sweepOfOneTagLooksUp() = runTest {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> KioskLookupResult() } }
        val b = build(api)
        b.vm.onSweep(listOf("100348")); settle()
        assertEquals(listOf("lookupAssets:000000000000000000100348"), api.calls)
        assertEquals("000000000000000000100348", b.vm.ui.value.miss)
    }

    @Test fun sweepDedupesByPaddedTag() = runTest {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> KioskLookupResult() } }
        val b = build(api)
        b.vm.onSweep(listOf("100348", "000000000000000000100348", "100348")); settle()
        assertEquals(listOf("lookupAssets:000000000000000000100348"), api.calls)
        assertNull(b.vm.ui.value.notice)
    }

    @Test fun sweepOfSeveralSaysSo() = runTest {
        val api = FakeKioskApi().apply { lookupAssetsResult = { _, _ -> KioskLookupResult() } }
        val b = build(api)
        b.vm.onSweep(listOf("100348", "100349", "000000000000000000100348")); settle()
        assertEquals("2 tags read. Point the reader at one tag and try again.", b.vm.ui.value.notice)
        assertTrue(api.calls.isEmpty())

        // The next lookup clears it.
        b.vm.onScan("A-1"); settle()
        assertNull(b.vm.ui.value.notice)
    }

    @Test fun blankLookupIsNoOp() = runTest {
        val api = FakeKioskApi()
        val b = build(api)
        b.vm.onValueChange("   "); b.vm.lookup(); settle()
        b.vm.onSweep(emptyList()); settle()
        assertTrue(api.calls.isEmpty())
        assertEquals("   ", b.vm.ui.value.value)
        assertNull(b.vm.ui.value.notice)
        assertNull(b.vm.ui.value.error)
    }
}
