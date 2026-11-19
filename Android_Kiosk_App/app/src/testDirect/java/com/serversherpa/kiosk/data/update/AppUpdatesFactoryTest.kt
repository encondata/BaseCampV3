package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.data.api.ApiHarness
import com.serversherpa.kiosk.data.api.sessionResponse
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.InetAddress

class AppUpdatesFactoryTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun ApiHarness.signIn() = runBlocking {
        server.enqueue(sessionResponse()); api.login("a@b.c", "pw"); server.takeRequest()
    }

    private fun ApiHarness.checker(): UpdateChecker {
        val loopback = client.newBuilder().dns(object : okhttp3.Dns {
            override fun lookup(hostname: String) = listOf(InetAddress.getLoopbackAddress())
        }).build()
        val apiUrl = "http://api.test:${server.port}"
        return devicesChecker(DevicesUpdateClient(loopback, session) { apiUrl }, "com.serversherpa.kiosk", 2) { "a".repeat(64) }
    }

    private suspend fun UpdateChecker.failure(): String {
        try { check(); fail("expected an UpdateError") } catch (e: UpdateError) { return e.message!! }
        error("unreachable")
    }

    @Test fun anUnreachableDevicesSiteNamesItsHost() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            val checker = h.checker()
            h.server.shutdown()
            assertEquals("Couldn't reach devices.test. Try again later.", checker.failure())
        }
    }

    @Test fun aProxyErrorNamesTheStatus() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(MockResponse().setResponseCode(502).setBody("Bad Gateway"))
            assertEquals("The Devices site answered 502. Try again later.", h.checker().failure())
        }
    }
}
