package com.serversherpa.kiosk.data.db

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.scan.buildScanIndex
import com.serversherpa.kiosk.core.scan.matchScan
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
class KioskDatabaseTest {
    private lateinit var db: KioskDatabase
    @Before fun setUp() { db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()) }
    @After fun tearDown() { db.close() }

    @Test fun assetsRoundTripAndMatch() = runBlocking {
        val row = KioskAssetRow(id = "a1", asset_id = "A-1", name = "Rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell R740", label = mapOf("asset_id" to "A-1"))
        db.assets().insertAll(listOf(row.toEntity()))
        val all = db.assets().all()
        assertEquals(1, all.size)
        assertEquals("A-1", all[0].label()["asset_id"])
        assertEquals("a1", matchScan(buildScanIndex(all), "100348")?.asset?.id)
        db.assets().updateRfid("a1", "000000000000000000999999")
        assertEquals("000000000000000000999999", db.assets().all()[0].rfid)
        assertEquals(1, db.assets().count())
        db.assets().deleteAll(); assertEquals(0, db.assets().count())
    }

    @Test fun metaAndOutbox() = runBlocking {
        db.meta().put(MetaEntity("sync", "{\"x\":1}"))
        assertEquals("{\"x\":1}", db.meta().get("sync")?.value)
        db.meta().delete("sync"); assertNull(db.meta().get("sync"))

        val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN1", "Dell")
        val r1 = OutboxMachine.newRow(EnqueueInput("A-1", "barcode", asset, "s", "i", "pre_stage"), "c1", 1, 0)
        val r2 = OutboxMachine.newRow(EnqueueInput("zzz", "barcode", null, "s", "i", "pre_stage"), "c2", 2, 0)
        db.outbox().upsert(listOf(r1.toEntity(), r2.toEntity()))
        val rows = db.outbox().all().map { it.toRow() }.sortedBy { it.seq }
        assertEquals(r1, rows[0]); assertEquals(r2, rows[1])
        assertEquals(OutboxStatus.NOMATCH, rows[1].status)
        db.outbox().upsert(listOf(r1.copy(status = OutboxStatus.ACCEPTED).toEntity()))
        assertEquals(OutboxStatus.ACCEPTED, db.outbox().all().first { it.clientScanId == "c1" }.toRow().status)
        db.outbox().delete(listOf("c1", "c2")); assertEquals(0, db.outbox().all().size)
    }
}
