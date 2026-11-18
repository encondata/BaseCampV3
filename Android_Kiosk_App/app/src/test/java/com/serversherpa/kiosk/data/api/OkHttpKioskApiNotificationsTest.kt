package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The app's notification routes under the session (api/.../routes/kiosk_push.py). */
class OkHttpKioskApiNotificationsTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun ApiHarness.signIn() = runBlocking {
        server.enqueue(sessionResponse()); api.login("a@b.c", "pw"); server.takeRequest()
    }

    @Test fun listReadsThePageAndSendsTheCursor() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"unread_count":1,"total":2,"next_cursor":"c2","items":[
                {"id":"n1","kind":"off_move_alert","category":"moves","title":"Off-move alert","body":"3 assets","link":null,
                 "payload":{"x":1},"created_at":"2026-11-17T14:32:00+00:00","read_at":null,"push_snoozed_until":"2026-11-17T14:37:00+00:00"}]}"""))
            val page = h.api.listNotifications(null)
            assertEquals(1, page.unread_count)
            assertEquals("c2", page.next_cursor)
            assertEquals("n1", page.items.single().id)
            assertEquals("2026-11-17T14:37:00+00:00", page.items.single().push_snoozed_until)
            assertNull(page.items.single().read_at)
            val first = h.server.takeRequest()
            assertEquals("GET", first.method)
            assertEquals("/kiosk/notifications", first.path)
            assertEquals("Bearer tok1", first.getHeader("Authorization"))

            h.server.enqueue(jsonResponse(200, """{"unread_count":0,"total":2,"items":[]}"""))
            h.api.listNotifications("c2")
            assertEquals("/kiosk/notifications?cursor=c2", h.server.takeRequest().path)
        }
    }

    @Test fun readUnreadSnoozeAndHide() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(MockResponse().setResponseCode(204))
            h.api.markRead("n1")
            h.server.takeRequest().let { assertEquals("POST", it.method); assertEquals("/kiosk/notifications/n1/read", it.path) }
            h.server.enqueue(MockResponse().setResponseCode(204))
            h.api.markUnread("n1")
            h.server.takeRequest().let { assertEquals("POST", it.method); assertEquals("/kiosk/notifications/n1/unread", it.path) }
            h.server.enqueue(jsonResponse(200, """{"snoozed_until":"2026-11-17T14:37:00+00:00"}"""))
            assertEquals("2026-11-17T14:37:00+00:00", h.api.snooze("n1").snoozedUntil)
            h.server.takeRequest().let { assertEquals("POST", it.method); assertEquals("/kiosk/notifications/n1/snooze", it.path) }
            h.server.enqueue(MockResponse().setResponseCode(204))
            h.api.hide("n1")
            h.server.takeRequest().let {
                assertEquals("DELETE", it.method); assertEquals("/kiosk/notifications/n1", it.path)
                assertEquals("Bearer tok1", it.getHeader("Authorization"))
            }
        }
    }

    @Test fun refusalsCarryTheirCodes() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"not_live"}}"""))
            try { h.api.snooze("n1"); fail() } catch (e: ApiError) { assertEquals(409, e.status); assertEquals("not_live", e.code) }
            h.server.enqueue(jsonResponse(403, """{"detail":{"code":"not_admin"}}"""))
            try { h.api.markRead("n1"); fail() } catch (e: ApiError) { assertEquals("not_admin", e.code) }
        }
    }
}
