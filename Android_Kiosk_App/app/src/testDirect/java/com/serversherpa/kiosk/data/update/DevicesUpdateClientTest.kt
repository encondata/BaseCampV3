package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.update.BAD_ANSWER
import com.serversherpa.kiosk.core.update.NO_DEVICES_HOST
import com.serversherpa.kiosk.core.update.UpdateAnswer
import com.serversherpa.kiosk.data.api.ApiHarness
import com.serversherpa.kiosk.data.api.jsonResponse
import com.serversherpa.kiosk.data.api.sessionResponse
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.InetAddress

class DevicesUpdateClientTest {
    @get:Rule val tmp = TemporaryFolder()

    private val digest = "a".repeat(64)
    private val available = """{"status":"available","version_name":"1.4.0","build":"3","notes":"Fixes","size":1234,"install_url":"https://devices.test/d/abc"}"""

    private fun ApiHarness.signIn() = runBlocking {
        server.enqueue(sessionResponse()); api.login("a@b.c", "pw"); server.takeRequest()
    }

    private fun ApiHarness.devices(apiUrl: String = "http://api.test:${server.port}") = DevicesUpdateClient(
        client.newBuilder().dns(object : okhttp3.Dns { override fun lookup(hostname: String) = listOf(InetAddress.getLoopbackAddress()) }).build(), session, { apiUrl },
    )

    @Test fun sendsTheContractQueryWithTheBearer() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"status":"up_to_date"}"""))
            assertEquals(UpdateAnswer.UpToDate, h.devices().check("com.serversherpa.kiosk", 2, digest))
            val req = h.server.takeRequest()
            assertEquals("GET", req.method)
            assertEquals("/api/updates?platform=android&package=com.serversherpa.kiosk&version_code=2&signing_digest=$digest", req.path)
            assertEquals("Bearer tok1", req.getHeader("Authorization"))
            assertEquals("devices.test:${h.server.port}", req.getHeader("Host"))
            assertNull(req.getHeader("Cookie"))
        }
    }

    @Test fun devicesBaseSwapsTheHost() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            assertEquals("http://devices.test:${h.server.port}", h.devices().devicesBase())
            assertNull(h.devices("http://10.0.2.2:8010").devicesBase())
        }
    }

    @Test fun mapsAvailable() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, available))
            val a = h.devices().check("com.serversherpa.kiosk", 2, digest) as UpdateAnswer.Available
            assertEquals(3L, a.offer.build)
            assertEquals("1.4.0", a.offer.versionName)
            assertEquals("https://devices.test/d/abc", a.offer.installUrl)
        }
    }

    @Test fun mapsReinstallRequired() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"status":"reinstall_required","message":"Reinstall from the Devices site."}"""))
            assertEquals(UpdateAnswer.Blocked("Reinstall from the Devices site."), h.devices().check("com.serversherpa.kiosk", 2, digest))
        }
    }

    @Test fun refreshesOnceOn401ThenRetries() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(401, """{"detail":"expired"}"""))
            h.server.enqueue(sessionResponse(token = "tok2"))
            h.server.enqueue(jsonResponse(200, available))
            assertTrue(h.devices().check("com.serversherpa.kiosk", 2, digest) is UpdateAnswer.Available)
            assertEquals("/api/updates", h.server.takeRequest().path!!.substringBefore('?'))
            assertEquals("/auth/refresh", h.server.takeRequest().path)
            val retry = h.server.takeRequest()
            assertEquals("Bearer tok2", retry.getHeader("Authorization"))
            assertEquals(4, h.server.requestCount)   // login, check, refresh, retry
        }
    }

    @Test fun a401AfterRefreshThrowsButKeepsTheSession() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(401, """{"detail":"no"}"""))
            h.server.enqueue(sessionResponse(token = "tok2"))
            h.server.enqueue(jsonResponse(401, """{"detail":"no"}"""))
            val seen = java.util.concurrent.atomic.AtomicInteger()
            val job = h.scope.launch(kotlinx.coroutines.Dispatchers.Unconfined) { h.session.sessionEnded.collect { seen.incrementAndGet() } }
            try { h.devices().check("com.serversherpa.kiosk", 2, digest); fail() } catch (e: ApiError) {
                assertEquals(401, e.status)
            }
            job.cancel()
            assertEquals(0, seen.get())
            assertNotNull(h.session.accessToken())
        }
    }

    @Test fun aServerErrorThrows() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(MockResponse().setResponseCode(502).setBody("Bad Gateway"))
            try { h.devices().check("com.serversherpa.kiosk", 2, digest); fail() } catch (e: ApiError) {
                assertEquals(502, e.status)
            }
        }
    }

    @Test fun aRefusedConnectionIsANetworkError() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val client = h.devices()
            h.server.shutdown()
            try { client.check("com.serversherpa.kiosk", 2, digest); fail() } catch (e: ApiError) {
                assertTrue(e.isNetwork)
            }
        }
    }

    @Test fun noDevicesHostMakesNoRequest() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val before = h.server.requestCount
            assertEquals(UpdateAnswer.Blocked(NO_DEVICES_HOST), h.devices("http://10.0.2.2:8010").check("com.serversherpa.kiosk", 2, digest))
            assertEquals(before, h.server.requestCount)
        }
    }

    @Test fun neverSendsCookiesEvenOnesTheJarWouldMatch() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val cookie = okhttp3.Cookie.Builder().name("sid").value("x").domain("test").path("/").build()
            h.cookieJar.saveFromResponse("http://api.test/".toHttpUrl(), listOf(cookie))
            assertTrue(h.cookieJar.loadForRequest("http://devices.test/api/updates".toHttpUrl()).isNotEmpty())
            h.server.enqueue(jsonResponse(200, """{"status":"up_to_date"}"""))
            h.devices().check("com.serversherpa.kiosk", 2, digest)
            assertNull(h.server.takeRequest().getHeader("Cookie"))
        }
    }

    @Test fun aNonJsonAnswerIsBlockedAsBad() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(MockResponse().setResponseCode(200).setBody("<html>hi</html>"))
            assertEquals(UpdateAnswer.Blocked(BAD_ANSWER), h.devices().check("com.serversherpa.kiosk", 2, digest))
        }
    }

    @Test fun a401WithARefusedRefreshThrowsAndEmitsNothing() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(401, """{"detail":"no"}"""))
            h.server.enqueue(jsonResponse(401, """{"detail":"refresh refused"}"""))
            val seen = java.util.concurrent.atomic.AtomicInteger()
            val job = h.scope.launch(kotlinx.coroutines.Dispatchers.Unconfined) { h.session.sessionEnded.collect { seen.incrementAndGet() } }
            try { h.devices().check("com.serversherpa.kiosk", 2, digest); fail() } catch (e: ApiError) {
                assertEquals(401, e.status)
            }
            job.cancel()
            assertEquals(0, seen.get())
        }
    }
}
