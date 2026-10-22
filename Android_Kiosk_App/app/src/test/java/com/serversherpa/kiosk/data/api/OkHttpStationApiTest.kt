package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.first
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Station calls carry only `Authorization: Station <key>` — never the session's Bearer token,
 *  never a refresh, never a session-ended signal — plus the serial in the query or body. */
class OkHttpStationApiTest {
    @get:Rule val tmp = TemporaryFolder()

    private val status = """{"person":{"id":"p","display_name":"Tina T","job_title":"Mover","external_id":"E-7"},"clocked_in":false,
      "today_minutes":95,"today_entries":[{"clock_in_at":"2026-10-21T08:00:00Z","clock_out_at":"2026-10-21T09:35:00Z","minutes":95}]}"""

    /** A signed-in session too, so a leaked Bearer header would show. */
    private fun ApiHarness.signIn() { server.enqueue(sessionResponse()); runBlocking { api.login("a@b.c", "pw") }; server.takeRequest() }

    @Test fun peopleSendsOnlyTheStationHeaderAndTheSerial() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"generated_at":"x","people":[{"id":"p","display_name":"Tina T","first_name":"Tina","last_name":"T",
              "is_worker":true,"has_account":false,"badge_uid":"B-1","job_title":"Mover","external_id":"E-7"}]}"""))
            val people = h.stationApi.people("k3y", "kiosk android/1")
            assertEquals("B-1", people.single().badge_uid); assertEquals("Mover", people.single().job_title); assertEquals("E-7", people.single().external_id)
            val req = h.server.takeRequest()
            assertEquals("GET", req.method)
            assertEquals("/kiosk/station/sync/people?serial=kiosk%20android%2F1", req.path)
            assertEquals("Station k3y", req.getHeader("Authorization"))
            assertEquals(1, req.headers.values("Authorization").size)
        }
    }

    @Test fun statusSendsSerialAndTzInTheQuery() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(200, status))
            val st = h.stationApi.status("k3y", "s1", "p", "America/Chicago")
            assertEquals(95, st.today_minutes); assertEquals("2026-10-21T09:35:00Z", st.today_entries.single().clock_out_at)
            assertEquals("Mover", st.person.job_title); assertEquals("E-7", st.person.external_id)
            val req = h.server.takeRequest()
            assertEquals("/kiosk/station/timeclock/p?serial=s1&tz=America%2FChicago", req.path)
            assertEquals("Station k3y", req.getHeader("Authorization"))
        }
    }

    @Test fun punchesSendSerialPersonAndTzInTheBody() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, status.replace("\"clocked_in\":false", "\"clocked_in\":true")))
            assertTrue(h.stationApi.clockIn("k3y", "s1", "p", "America/Chicago").clocked_in)
            var req = h.server.takeRequest()
            assertEquals("POST", req.method); assertEquals("/kiosk/station/timeclock/clock-in", req.path)
            assertEquals("Station k3y", req.getHeader("Authorization"))
            assertEquals("""{"serial":"s1","person_id":"p","tz":"America/Chicago"}""", req.body.readUtf8())
            h.server.enqueue(jsonResponse(200, status))
            assertFalse(h.stationApi.clockOut("k3y", "s1", "p", "America/Chicago").clocked_in)
            req = h.server.takeRequest()
            assertEquals("/kiosk/station/timeclock/clock-out", req.path)
            assertEquals("Station k3y", req.getHeader("Authorization"))
            assertEquals("""{"serial":"s1","person_id":"p","tz":"America/Chicago"}""", req.body.readUtf8())
        }
    }

    @Test fun refusalsMapToApiErrorCodesWithNoRefreshAndNoSessionEnd() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val ended = async(start = CoroutineStart.UNDISPATCHED) { withTimeoutOrNull(500) { h.session.sessionEnded.first() } }
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"station_key_invalid"}}"""))
            try { h.stationApi.status("k3y", "s1", "p", "UTC"); fail() } catch (e: ApiError) { assertEquals(401, e.status); assertEquals("station_key_invalid", e.code) }
            h.server.enqueue(jsonResponse(403, """{"detail":{"code":"kiosk_not_registered"}}"""))
            try { h.stationApi.people("k3y", "s1"); fail() } catch (e: ApiError) { assertEquals(403, e.status); assertEquals("kiosk_not_registered", e.code) }
            h.server.enqueue(jsonResponse(403, """{"detail":{"code":"wrong_station_type"}}"""))
            try { h.stationApi.people("k3y", "s1"); fail() } catch (e: ApiError) { assertEquals("wrong_station_type", e.code) }
            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"already_clocked_in"}}"""))
            try { h.stationApi.clockIn("k3y", "s1", "p", "UTC"); fail() } catch (e: ApiError) { assertEquals(409, e.status); assertEquals("already_clocked_in", e.code) }
            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"not_clocked_in"}}"""))
            try { h.stationApi.clockOut("k3y", "s1", "p", "UTC"); fail() } catch (e: ApiError) { assertEquals("not_clocked_in", e.code) }
            h.server.enqueue(jsonResponse(423, """{"detail":{"code":"read_only"}}"""))
            try { h.stationApi.clockOut("k3y", "s1", "p", "UTC"); fail() } catch (e: ApiError) { assertEquals(423, e.status) }
            // six station calls, six requests: nothing went to /auth/refresh
            val paths = (1..6).map { h.server.takeRequest().path!! }
            assertTrue(paths.toString(), paths.none { it.startsWith("/auth") })
            assertEquals(6, h.server.requestCount - 1)
            assertNull(ended.await())
            assertEquals("tok1", h.session.accessToken())
        }
    }

    @Test fun networkFailureIsApiErrorNetwork() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.shutdown()
            try { h.stationApi.people("k3y", "s1"); fail() } catch (e: ApiError) { assertEquals(0, e.status); assertEquals("network", e.code) }
        }
    }
}
