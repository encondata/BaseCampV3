package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.data.push.PushKey
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** "This is my phone" and the push registration routes (api/.../routes/kiosk_push.py). */
class OkHttpKioskApiPushTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun ApiHarness.signIn() = runBlocking {
        server.enqueue(sessionResponse()); api.login("a@b.c", "pw"); server.takeRequest()
    }

    @Test fun getPersonalReadsTheState() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"on":false,"owner_name":"Sam S","push_registered":false}"""))
            assertEquals(PersonalState(on = false, ownerName = "Sam S", pushRegistered = false), h.api.getPersonal())
            val req = h.server.takeRequest()
            assertEquals("GET", req.method)
            assertEquals("/kiosk/personal", req.path)
            assertEquals("Bearer tok1", req.getHeader("Authorization"))
        }
    }

    @Test fun setPersonalSendsOnAndReadsAnswerWithoutPushRegistered() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"on":true,"owner_name":"Tina T"}"""))
            assertEquals(PersonalState(on = true, ownerName = "Tina T", pushRegistered = false), h.api.setPersonal(true))
            val req = h.server.takeRequest()
            assertEquals("PUT", req.method)
            assertEquals("/kiosk/personal", req.path)
            assertEquals("""{"on":true}""", req.body.readUtf8())
        }
    }

    @Test fun setPersonalRefusalCarriesTheReason() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(422, """{"detail":{"code":"not_eligible","reason":"shared_station"}}"""))
            try { h.api.setPersonal(true); fail() } catch (e: ApiError) {
                assertEquals(422, e.status); assertEquals("not_eligible", e.code); assertEquals("shared_station", e.detailString("reason"))
            }
        }
    }

    @Test fun registerAndDeletePush() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"registration_id":"9b0c","push_key":"s3cret"}"""))
            val reg = h.api.registerPush("fcm-1")
            assertEquals("9b0c", reg.registrationId); assertEquals("s3cret", reg.pushKey)
            val post = h.server.takeRequest()
            assertEquals("POST", post.method)
            assertEquals("/kiosk/push/registration", post.path)
            assertEquals("""{"token":"fcm-1"}""", post.body.readUtf8())
            assertEquals("Bearer tok1", post.getHeader("Authorization"))
            h.server.enqueue(MockResponse().setResponseCode(204))
            h.api.deletePush()
            val delete = h.server.takeRequest()
            assertEquals("DELETE", delete.method)
            assertEquals("/kiosk/push/registration", delete.path)
        }
    }

    @Test fun updatePushTokenSendsOnlyThePushKey() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()          // a session and its refresh cookie exist: neither may be sent
            h.server.enqueue(MockResponse().setResponseCode(204))
            val base = h.server.url("/").toString().trimEnd('/')
            h.api.updatePushToken("fcm-2", PushKey("9b0c", "s3cret", base))
            val req = h.server.takeRequest()
            assertEquals("PUT", req.method)
            assertEquals("/kiosk/push/registration/token", req.path)
            assertEquals("PushKey 9b0c.s3cret", req.getHeader("Authorization"))
            assertNull(req.getHeader("Cookie"))
            assertEquals("""{"token":"fcm-2"}""", req.body.readUtf8())
            assertEquals(2, h.server.requestCount)      // the sign-in and this: no refresh
        }
    }

    @Test fun updatePushTokenInvalidKeyIsNotASessionEnd() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"push_key_invalid"}}"""))
            try {
                h.api.updatePushToken("fcm-2", PushKey("9b0c", "bad", h.server.url("/").toString().trimEnd('/'))); fail()
            } catch (e: ApiError) { assertEquals(401, e.status); assertEquals("push_key_invalid", e.code) }
            assertEquals(2, h.server.requestCount)      // no refresh, no retry
            assertTrue("the session is untouched", h.session.accessToken() == "tok1")
        }
    }
}
