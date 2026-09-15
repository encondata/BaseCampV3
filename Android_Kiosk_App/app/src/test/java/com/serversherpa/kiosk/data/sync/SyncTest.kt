package com.serversherpa.kiosk.data.sync

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskAssetsSync
import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncTest {
    private lateinit var db: KioskDatabase
    private val api = FakeKioskApi()
    @Before fun setUp() { db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()) }
    @After fun tearDown() { db.close() }

    private fun sync() = Sync(api, db, kotlinx.coroutines.GlobalScope, clock = { 1_700_000_000_000L })

    @Test fun successReplacesTablesAndWritesMeta() = runBlocking {
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a1", "A-1", make_model = "X"), KioskAssetRow("a2", "A-2", make_model = "Y"))) }
        api.people = { KioskPeopleSync("now", listOf(KioskPersonRow("p1", "Tina T", "Tina", "T"))) }
        val s = sync()
        s.runNow("i1", "Move A")
        val st = s.status.value
        assertEquals(SyncPhase.DONE, st.phase); assertEquals(2, st.assets); assertEquals(1, st.people); assertEquals(0, st.containers); assertEquals(0, st.trucks)
        assertEquals("2023-11-14T22:13:20Z", st.syncedAt)
        assertEquals(2, db.assets().count())
        val meta = Sync.readMeta(db)
        assertEquals("Move A", meta?.initiativeName); assertEquals(2, meta?.assets)
        // A second sync with fewer assets replaces, not appends.
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a9", "A-9", make_model = "Z"))) }
        s.runNow("i1", "Move A")
        assertEquals(listOf("a9"), db.assets().all().map { it.id })
    }

    @Test fun failedFetchLeavesTablesAndReportsCode() = runBlocking {
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a1", "A-1", make_model = "X"))) }
        val s = sync(); s.runNow("i1", "Move A")
        api.people = { throw ApiError(0, "network") }
        s.runNow("i1", "Move A")
        assertEquals(SyncPhase.ERROR, s.status.value.phase)
        assertEquals("network", s.status.value.error)
        assertEquals(1, s.status.value.assets)          // previous counts kept
        assertEquals(1, db.assets().count())
    }

    @Test fun hydrateReadsMetaAndClearEmptiesMoveTablesOnly() = runBlocking {
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a1", "A-1", make_model = "X"))) }
        sync().runNow("i1", "Move A")
        db.outbox().upsert(listOf(OutboxMachine.newRow(EnqueueInput("A-1", "barcode", null, "s", "i", "x"), "c1", 1, 0).toEntity()))
        val fresh = sync()
        assertEquals(SyncPhase.IDLE, fresh.status.value.phase)
        fresh.hydrate()
        assertEquals(SyncPhase.DONE, fresh.status.value.phase); assertEquals(1, fresh.status.value.assets)
        fresh.clearLocalData()
        assertEquals(SyncPhase.IDLE, fresh.status.value.phase)
        assertEquals(0, db.assets().count()); assertNull(db.meta().get(com.serversherpa.kiosk.data.db.MOVE_META_KEY))
        assertEquals(1, db.outbox().all().size)
    }
}
