package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexCreateIn
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexDuplicatesIn
import com.serversherpa.kiosk.core.model.RolodexList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OkHttpKioskApiRolodexTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun ApiHarness.signIn() { server.enqueue(sessionResponse()); runBlocking { api.login("a@b.c", "pw") }; server.takeRequest() }

    private val pid = "6f1c2d3e-0000-4000-8000-000000000001"

    private val rowJson = """"person_id":"$pid","first_name":"Marcus","last_name":"Reed","preferred_name":null,
        "display_name":"Marcus Reed","job_title":"Rigger","company":{"id":"c1","name":"Summit Crew"},"trade":"Rigging",
        "level":"L2","level_color":"#64748B","status":"active","status_label":"Active","status_color":"#16A34A",
        "has_photo":true,"photo_url":"https://files.example/p.jpg?sig=1","photo_version":"0123456789abcdef",
        "rfid_enrolled":true,"has_account":false"""

    private val detailJson = """{$rowJson,"email":"marcus@example.com","phone":"312-555-0142","external_id":"E-17",
        "status_note":null,"can_edit":true,"can_change_status":false,"edit_block_reason":null,"status_block_reason":"self"}"""

    @Test fun listAndDetail() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"generated_at":"2026-10-22T15:42:00Z","workers":[{$rowJson},
              {"person_id":"p2","first_name":"Ana","last_name":"Ortiz","preferred_name":null,"display_name":"Ana Ortiz",
               "job_title":null,"company":null,"trade":null,"level":null,"level_color":null,"status":"standby",
               "status_label":"Standby","status_color":null,"has_photo":false,"photo_url":null,"photo_version":null,
               "rfid_enrolled":false,"has_account":true}]}"""))
            val list = h.api.rolodexWorkers()
            assertEquals("2026-10-22T15:42:00Z", list.generated_at)
            assertEquals(listOf(pid, "p2"), list.workers.map { it.person_id })
            assertEquals("Summit Crew", list.workers[0].company?.name); assertTrue(list.workers[0].rfid_enrolled)
            assertNull(list.workers[1].company); assertFalse(list.workers[1].has_photo); assertTrue(list.workers[1].has_account)
            val req = h.server.takeRequest()
            assertEquals("GET", req.method); assertEquals("/kiosk/rolodex/workers", req.path)
            assertEquals("Bearer tok1", req.getHeader("Authorization"))

            h.server.enqueue(jsonResponse(200, detailJson))
            val d = h.api.rolodexWorker(pid)
            assertEquals("312-555-0142", d.phone); assertEquals("E-17", d.external_id)
            assertTrue(d.jobs.isEmpty())                                   // an API without jobs: none
            assertTrue(d.can_edit); assertFalse(d.can_change_status)
            assertNull(d.edit_block_reason); assertEquals("self", d.status_block_reason)
            assertEquals(list.workers[0], d.toRow())
            val dreq = h.server.takeRequest()
            assertEquals("GET", dreq.method); assertEquals("/kiosk/rolodex/workers/$pid", dreq.path)
        }
    }

    /** The worker page's "Previous jobs", newest first as the API sends them; the nullable parts stay null. */
    @Test fun detailCarriesPreviousJobs() {
        val d = KioskJson.decodeFromString(RolodexDetail.serializer(), detailJson.dropLast(1) + ""","jobs":[
            {"initiative_id":"i2","initiative_name":"NAP11 Hall Migration","type_label":"Move","type_color":"#a36207",
             "status_label":"In progress","status_color":"#1668a7","work_type_label":"Lead","site_worked_name":"NAP11 Las Vegas",
             "added_at":"2026-10-03T15:00:00Z"},
            {"initiative_id":"i1","initiative_name":"Spring Refresh","type_label":"Project","type_color":"#1668a7",
             "status_label":"Completed","status_color":"#178a4c","work_type_label":null,"site_worked_name":null,
             "added_at":"2026-03-02T15:00:00Z"}]}""")
        assertEquals(listOf("i2", "i1"), d.jobs.map { it.initiative_id })
        val job = d.jobs[0]
        assertEquals("NAP11 Hall Migration", job.initiative_name)
        assertEquals("Move", job.type_label); assertEquals("In progress", job.status_label); assertEquals("#1668a7", job.status_color)
        assertEquals("Lead", job.work_type_label); assertEquals("NAP11 Las Vegas", job.site_worked_name)
        assertEquals("2026-10-03T15:00:00Z", job.added_at)
        assertNull(d.jobs[1].work_type_label); assertNull(d.jobs[1].site_worked_name)
    }

    /** The cached list is the list payload re-encoded: email or phone in a row never survive it. */
    @Test fun listRowsNeverCarryEmailOrPhone() {
        val decoded = KioskJson.decodeFromString(RolodexList.serializer(),
            """{"generated_at":"x","workers":[{$rowJson,"email":"leak@example.com","phone":"312-555-0199"}]}""")
        val cached = KioskJson.encodeToString(RolodexList.serializer(), decoded)
        assertFalse(cached, cached.contains("email")); assertFalse(cached, cached.contains("phone"))
        assertFalse(cached.contains("leak@example.com"))
    }

    @Test fun options() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"levels":[{"level":"L1","title":"Helper","color":"#94A3B8"},{"level":"L4","title":"Lead","color":"#0EA5E9"}],
              "statuses":[{"key":"active","label":"Active","color":"#16A34A"},{"key":"standby","label":"Standby","color":"#F59E0B"},
                          {"key":"blacklist","label":"Blacklist","color":"#DC2626"}],
              "partners":[{"id":"c1","name":"Summit Crew"}]}"""))
            val o = h.api.rolodexOptions()
            assertEquals(listOf("L1", "L4"), o.levels.map { it.level }); assertEquals("Lead", o.levels[1].title)
            assertEquals(listOf("active", "standby", "blacklist"), o.statuses.map { it.key }); assertEquals("Blacklist", o.statuses[2].label)
            assertEquals("Summit Crew", o.partners.single().name)
            val req = h.server.takeRequest()
            assertEquals("GET", req.method); assertEquals("/kiosk/rolodex/options", req.path)
        }
    }

    @Test fun duplicatesPostsTheNamesInTheBody() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"matches":[{"person_id":"p9","display_name":"Ana Ortiz","job_title":"Coordinator",
              "company":"Acme","is_worker":false,"has_account":true,"photo_url":null,"photo_version":null,"matched_on":["name","email"]}]}"""))
            val matches = h.api.rolodexDuplicates(RolodexDuplicatesIn(first_name = "Ana", last_name = "Ortiz", email = "ana@example.com"))
            assertEquals("p9", matches.single().person_id); assertEquals("Acme", matches[0].company)
            assertFalse(matches[0].is_worker); assertEquals(listOf("name", "email"), matches[0].matched_on)
            val req = h.server.takeRequest()
            assertEquals("POST", req.method); assertEquals("/kiosk/rolodex/duplicates", req.path)
            assertEquals("""{"first_name":"Ana","last_name":"Ortiz","email":"ana@example.com"}""", req.body.readUtf8())
        }
    }

    @Test fun createPostsTheWorkerAndReadsTheDetail() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(201, detailJson))
            val d = h.api.rolodexCreate(RolodexCreateIn(first_name = "Marcus", last_name = "Reed", job_title = "Rigger",
                partner_id = "c1", level = "L2", photo_skipped = true))
            assertEquals(pid, d.person_id)
            val req = h.server.takeRequest()
            assertEquals("POST", req.method); assertEquals("/kiosk/rolodex/workers", req.path)
            assertEquals("""{"first_name":"Marcus","last_name":"Reed","job_title":"Rigger","partner_id":"c1","level":"L2",""" +
                """"allow_duplicate":false,"photo_skipped":true}""", req.body.readUtf8())
        }
    }

    @Test fun updatePatchesAndKeepsExplicitNulls() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, detailJson))
            val d = h.api.rolodexUpdate(pid, buildJsonObject { put("phone", JsonNull); put("level", "L4"); put("partner_id", JsonNull) })
            assertEquals(pid, d.person_id)
            val req = h.server.takeRequest()
            assertEquals("PATCH", req.method); assertEquals("/kiosk/rolodex/workers/$pid", req.path)
            assertTrue(req.getHeader("Content-Type")!!.startsWith("application/json"))
            assertEquals("""{"phone":null,"level":"L4","partner_id":null}""", req.body.readUtf8())
        }
    }

    @Test fun photoPutsTheRawJpegBytes() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val jpeg = byteArrayOf(-1, -40, -1, -32, 0, 16, 74, 70, 73, 70, 0, -1, -39)
            h.server.enqueue(jsonResponse(200, """{"photo_url":"https://files.example/new.jpg?sig=2","photo_version":"fedcba9876543210"}"""))
            val out = h.api.rolodexPhoto(pid, jpeg)
            assertEquals("fedcba9876543210", out.photo_version); assertEquals("https://files.example/new.jpg?sig=2", out.photo_url)
            val req = h.server.takeRequest()
            assertEquals("PUT", req.method); assertEquals("/kiosk/rolodex/workers/$pid/photo", req.path)
            assertEquals("image/jpeg", req.getHeader("Content-Type"))
            assertEquals(jpeg.size.toString(), req.getHeader("Content-Length"))
            assertArrayEquals(jpeg, req.body.readByteArray())
        }
    }

    /** The photo body is sent again on the retry after a 401 refresh (the bytes are replayable). */
    @Test fun photoBodySurvivesTheRefreshRetry() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val jpeg = byteArrayOf(-1, -40, 1, 2, 3, -1, -39)
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"not_authenticated"}}"""))
            h.server.enqueue(sessionResponse(cookie = null, token = "tok2"))
            h.server.enqueue(jsonResponse(200, """{"photo_url":"u","photo_version":"v"}"""))
            assertEquals("v", h.api.rolodexPhoto(pid, jpeg).photo_version)
            assertArrayEquals(jpeg, h.server.takeRequest().body.readByteArray())
            assertEquals("/auth/refresh", h.server.takeRequest().path)
            val retry = h.server.takeRequest()
            assertEquals("Bearer tok2", retry.getHeader("Authorization")); assertArrayEquals(jpeg, retry.body.readByteArray())
        }
    }

    @Test fun errorsMapToApiErrorCodes() = runBlocking<Unit> {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"possible_duplicate"}}"""))
            try { h.api.rolodexCreate(RolodexCreateIn(first_name = "Ana", last_name = "Ortiz")); fail() } catch (e: ApiError) {
                assertEquals(409, e.status); assertEquals("possible_duplicate", e.code)
            }
            h.server.takeRequest()
            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"email_in_use"}}"""))
            try { h.api.rolodexUpdate(pid, buildJsonObject { put("email", "x@example.com") }); fail() } catch (e: ApiError) { assertEquals("email_in_use", e.code) }
            h.server.takeRequest()
            h.server.enqueue(jsonResponse(423, """{"detail":{"code":"read_only_mode"}}"""))
            try { h.api.rolodexPhoto(pid, byteArrayOf(1)); fail() } catch (e: ApiError) { assertEquals(423, e.status); assertEquals("read_only_mode", e.code) }
            h.server.takeRequest()
            h.server.enqueue(jsonResponse(404, """{"detail":{"code":"person_not_found"}}"""))
            try { h.api.rolodexWorker("nope"); fail() } catch (e: ApiError) { assertEquals("person_not_found", e.code) }
            h.server.takeRequest()
            h.server.enqueue(jsonResponse(403, """{"detail":{"code":"forbidden","min_rank":60}}"""))
            try { h.api.rolodexWorkers(); fail() } catch (e: ApiError) { assertEquals("forbidden", e.code) }
            h.server.takeRequest()
        }
    }
}
