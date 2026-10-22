package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanIn
import com.serversherpa.kiosk.core.model.KioskSetupIn
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test fun labelEndpointsReturnRawBodiesAndFontBytes() = runBlocking<Unit> {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val assets = """{"initiative_id":"i1","initiative_name":"M","generated_at":"x","assets":[{"id":"a","raw_ft":{"RU":12.0}}],"label_context":null}"""
            h.server.enqueue(jsonResponse(200, assets))
            assertEquals(assets, h.api.assetsSyncRaw("i 1"))
            assertEquals("/kiosk/sync/assets?initiative_id=i%201", h.server.takeRequest().path)
            val templates = """{"initiative_id":"i1","generated_at":"x","templates":[{"id":"t","version":2.0}]}"""
            h.server.enqueue(jsonResponse(200, templates))
            assertEquals(templates, h.api.labelTemplatesRaw("i1"))
            assertEquals("/kiosk/sync/label-templates?initiative_id=i1", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"fonts":[{"id":"f1","name":"ROBOTO.TTF","size":3,"resident":false},{"id":"f2","name":"TT0003M_.TTF","size":9,"resident":true}],"missing":["X.TTF"]}"""))
            val fonts = h.api.labelFonts("i1")
            assertEquals(listOf("f1", "f2"), fonts.fonts.map { it.id }); assertEquals(true, fonts.fonts[1].resident); assertEquals(listOf("X.TTF"), fonts.missing)
            assertEquals("/kiosk/labels/fonts?initiative_id=i1", h.server.takeRequest().path)
            h.server.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(200).setBody(okio.Buffer().write(byteArrayOf(0, 1, -1))))
            assertTrue(byteArrayOf(0, 1, -1).contentEquals(h.api.labelFontContent("f1", "i1")))
            assertEquals("/kiosk/labels/fonts/f1/content?initiative_id=i1", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(403, """{"detail":{"code":"font_not_servable"}}"""))
            try { h.api.labelFontContent("f2", "i1"); fail() } catch (e: ApiError) { assertEquals("font_not_servable", e.code) }
            h.server.takeRequest()
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

    /** A Time Clock station's setup: no move, no scan type; the reply's move fields are null. */
    @Test fun timeclockStationSetupAndSites() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"initiatives":[],"scan_types":[],"sites":[{"id":"s1","name":"Dallas"}]}"""))
            assertEquals("Dallas", h.api.setupOptions().sites.single().name)
            h.server.takeRequest()
            h.server.enqueue(jsonResponse(200, """{"device_id":"d","initiative_id":null,"initiative_name":null,"site_id":"s1","site_name":"Dallas",
              "site_role":"other","scan_status":null,"scan_status_label":null}"""))
            val res = h.api.submitSetup(KioskSetupIn("serial", site_id = "s1", station_type = "timeclock"))
            assertNull(res.initiative_id); assertNull(res.scan_status); assertEquals("other", res.site_role)
            val body = h.server.takeRequest().body.readUtf8()
            assertEquals("""{"serial":"serial","site_id":"s1","station_type":"timeclock"}""", body)
        }
    }

    @Test fun sessionTimeclockSendsTheDeviceZone() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":false,"today_minutes":30,"today_entries":[]}"""))
            assertEquals(30, h.api.timeclockStatus("p", "America/Chicago").today_minutes)
            assertEquals("/kiosk/timeclock/p?tz=America%2FChicago", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":true}"""))
            h.api.clockIn(ClockInIn("serial", "p", tz = "America/Chicago"))
            assertTrue(h.server.takeRequest().body.readUtf8().contains("\"tz\":\"America/Chicago\""))
            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":false}"""))
            assertFalse(h.api.clockOut(ClockOutIn("serial", "p", "America/Chicago")).clocked_in)
            assertEquals("""{"serial":"serial","person_id":"p","tz":"America/Chicago"}""", h.server.takeRequest().body.readUtf8())
        }
    }

    @Test fun issueStationKeyIsASessionCall() = runBlocking<Unit> {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"key":"k3y"}"""))
            assertEquals("k3y", h.api.issueStationKey("serial"))
            val req = h.server.takeRequest()
            assertEquals("POST", req.method); assertEquals("/kiosk/station-key", req.path)
            assertEquals("Bearer tok1", req.getHeader("Authorization"))
            assertEquals("""{"serial":"serial"}""", req.body.readUtf8())
            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"kiosk_not_registered"}}"""))
            try { h.api.issueStationKey("serial"); fail() } catch (e: ApiError) { assertEquals("kiosk_not_registered", e.code) }
            h.server.takeRequest()
        }
    }
}
