package com.serversherpa.kiosk.data.db

import android.content.Context
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Upgrading a device with unsent scans keeps every queued scan and the synced move
 *  (plan Review Focus 3). Version 1 is built from the committed schemas/…/1.json. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MigrationTest {
    @get:Rule val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), KioskDatabase::class.java)
    private val context: Context = ApplicationProvider.getApplicationContext()

    @After fun tearDown() { context.deleteDatabase(KioskDatabase.NAME) }

    private fun seedV1() {
        helper.createDatabase(KioskDatabase.NAME, 1).apply {
            for (i in 1..3) {
                execSQL(
                    "INSERT INTO assets (id, asset_id, name, rfid, serial_number, make, model, make_model, container_id, label_json) " +
                        "VALUES ('a$i', 'A-$i', 'Rack $i', NULL, 'SN$i', 'Dell', 'R740', 'Dell R740', NULL, '{\"asset_id\":\"A-$i\"}')",
                )
            }
            for (i in 1..2) {
                execSQL(
                    "INSERT INTO outbox (client_scan_id, seq, scanned_value, scan_type, scanned_at, asset_id, asset_tag, asset_name, " +
                        "asset_rfid, asset_serial, asset_make_model, matched, status, attempts, next_attempt_at, last_error, site_id, " +
                        "initiative_id, scan_status) VALUES ('c$i', $i, 'A-$i', 'barcode', '2026-10-21T10:00:0${i}Z', 'a$i', 'A-$i', " +
                        "'Rack $i', NULL, 'SN$i', 'Dell R740', 1, 'pending', 0, NULL, NULL, 's1', 'i1', 'pre_stage')",
                )
            }
            execSQL("INSERT INTO meta (`key`, value) VALUES ('sync', '{\"initiativeId\":\"i1\"}')")
            close()
        }
    }

    @Test fun v1ToV2KeepsOutboxAssetsAndMeta() {
        seedV1()
        helper.runMigrationsAndValidate(KioskDatabase.NAME, 2, true, MIGRATION_1_2).apply {
            query("SELECT payload_json FROM assets ORDER BY id").use { c ->
                assertEquals(3, c.count)
                while (c.moveToNext()) assertEquals("{}", c.getString(0))
            }
            close()
        }
    }

    /** Version 3: people gain badge_uid, job_title and external_id (all nullable). A synced
     *  roster survives the upgrade with the new columns empty until the next sync. */
    @Test fun v2ToV3AddsPeopleBadgeJobTitleAndEmployeeId() {
        helper.createDatabase(KioskDatabase.NAME, 2).apply {
            execSQL(
                "INSERT INTO people (id, display_name, first_name, last_name, preferred_name, rfid_tag, is_worker, has_account) " +
                    "VALUES ('p1', 'Tina T', 'Tina', 'T', NULL, '1003', 1, 0)",
            )
            close()
        }
        helper.runMigrationsAndValidate(KioskDatabase.NAME, 3, true, MIGRATION_2_3).apply {
            query("SELECT display_name, rfid_tag, badge_uid, job_title, external_id FROM people").use { c ->
                assertEquals(1, c.count); c.moveToFirst()
                assertEquals("Tina T", c.getString(0)); assertEquals("1003", c.getString(1))
                assertNull(c.getString(2)); assertNull(c.getString(3)); assertNull(c.getString(4))
            }
            close()
        }
    }

    @Test fun v1ToV3RunsEveryMigration() {
        seedV1()
        helper.runMigrationsAndValidate(KioskDatabase.NAME, 3, true, *KioskDatabase.MIGRATIONS).close()
    }

    @Test fun theAppsBuilderOpensAMigratedDatabase() = runBlocking {
        seedV1()
        val db = KioskDatabase.build(context)
        try {
            val outbox = db.outbox().all().map { it.toRow() }.sortedBy { it.seq }
            assertEquals(listOf("c1", "c2"), outbox.map { it.clientScanId })
            assertEquals("Rack 2", outbox[1].asset?.name)
            val assets = db.assets().all().sortedBy { it.id }
            assertEquals(listOf("a1", "a2", "a3"), assets.map { it.id })
            assertEquals("A-3", assets[2].label()["asset_id"])
            assertEquals(listOf("{}", "{}", "{}"), assets.map { it.payloadJson })
            assertEquals("{\"initiativeId\":\"i1\"}", db.meta().get(MOVE_META_KEY)?.value)
            assertEquals(0, db.labelTemplates().count())
            assertEquals(0, db.labelFonts().all().size)
            assertNull(db.generatedLabels().get("a1"))
            db.people().insertAll(listOf(PersonEntity("p1", "Tina T", "Tina", "T", null, "1003", true, false, "b-1", "Mover", "E-7")))
            assertEquals("E-7", db.people().all().single().externalId)
        } finally { db.close() }
    }
}
