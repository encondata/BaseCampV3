package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanIn
import com.serversherpa.kiosk.core.model.KioskSetupIn
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OkHttpKioskApiEndpointsTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun ApiHarness.signIn() { server.enqueue(sessionResponse()); runBlocking { api.login("a@b.c", "pw") }; server.takeRequest() }

    @Test fun setupOptionsAndSubmit() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"initiatives":[{"id":"i1","name":"Move A","status":"in_progress","status_label":"In progress","client_name":"Acme",
              "scheduled_start":"2026-09-20T00:00:00Z","scheduled_end":null,"source_site":{"id":"s1","name":"Origin"},"destination_site":null}],
              "scan_types":[{"key":"pre_stage","label":"Pre-stage","color":"#abc"}]}"""))
            val opts = h.api.setupOptions()
            assertEquals("Move A", opts.initiatives[0].name); assertEquals("Origin", opts.initiatives[0].source_site?.name)
            assertEquals("/kiosk/setup-options", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"device_id":"d","initiative_id":"i1","initiative_name":"Move A","site_id":"s1","site_name":"Origin","site_role":"source","scan_status":"pre_stage","scan_status_label":"Pre-stage"}"""))
            val res = h.api.submitSetup(KioskSetupIn("serial", "i1", "s1", "pre_stage"))
            assertEquals("source", res.site_role)
            val req = h.server.takeRequest(); assertEquals("/kiosk/setup", req.path); assertTrue(req.body.readUtf8().contains("\"scan_status\":\"pre_stage\""))
        }
    }

    @Test fun syncEndpointsEncodeTheInitiative() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"initiative_id":"i 1","initiative_name":"M","generated_at":"2026-09-15T00:00:00Z","assets":[{"id":"a","asset_id":"A-1","make_model":"X","label":{}}]}"""))
            assertEquals(1, h.api.syncAssets("i 1").assets.size)
            assertEquals("/kiosk/sync/assets?initiative_id=i%201", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"generated_at":"2026-09-15T00:00:00Z","people":[{"id":"p","display_name":"T","first_name":"T","last_name":"T","is_worker":true,"has_account":false}]}"""))
            assertEquals("T", h.api.syncPeople().people[0].display_name)
            assertEquals("/kiosk/sync/people", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"initiative_id":"i1","generated_at":"x","containers":[]}"""))
            assertEquals(0, h.api.syncContainers("i1").containers.size)
            assertEquals("/kiosk/sync/containers?initiative_id=i1", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"initiative_id":"i1","generated_at":"x","trucks":[]}"""))
            assertEquals(0, h.api.syncTrucks("i1").trucks.size)
            assertEquals("/kiosk/sync/trucks?initiative_id=i1", h.server.takeRequest().path)
        }
    }

    @Test fun scansRfidAndTimeclock() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"accepted":["c1"],"rejected":[{"client_scan_id":"c2","code":"bad_site"}]}"""))
            val out = h.api.postScans(KioskScanBatchIn("serial", listOf(KioskScanIn("c1", "A-1", "barcode", "2026-09-15T00:00:00Z"))))
            assertEquals(listOf("c1"), out.accepted); assertEquals("bad_site", out.rejected[0].code)
            assertEquals("/kiosk/scans", h.server.takeRequest().path)

            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"rfid_in_use","asset_id":"z","asset_name":"Other rack"}}"""))
            try { h.api.postRfidEnroll("a1", KioskRfidEnrollIn("serial", "000000000000000000100348", "pre_stage", "c3")); fail() } catch (e: ApiError) {
                assertEquals("rfid_in_use", e.code); assertEquals("Other rack", e.detailString("asset_name"))
            }
            assertEquals("/kiosk/assets/a1/rfid", h.server.takeRequest().path)

            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":false,"entry":null,"last_entry":null}"""))
            assertEquals(false, h.api.timeclockStatus("p").clocked_in)
            assertEquals("/kiosk/timeclock/p", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":true,"entry":{"id":"e","started_at":"2026-09-15T09:00:00Z"}}"""))
            val st = h.api.clockIn(ClockInIn("serial", "p", "s1", "i1"))
            assertEquals(true, st.clocked_in)
            val req = h.server.takeRequest(); assertEquals("/kiosk/timeclock/clock-in", req.path); assertTrue(req.body.readUtf8().contains("\"site_id\":\"s1\""))
        }
    }
}
