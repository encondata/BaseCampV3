package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.core.update.UpdateOffer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.InetAddress
import java.util.concurrent.TimeUnit

class ApkDownloaderTest {
    @get:Rule val tmp = TemporaryFolder()

    private val server = MockWebServer().also { it.start() }
    private val client = OkHttpClient.Builder()
        .dns(object : Dns { override fun lookup(hostname: String) = listOf(InetAddress.getLoopbackAddress()) })
        .build()
    private val base get() = "http://devices.test:${server.port}"
    private val dir by lazy { File(tmp.root, "updates") }
    private val downloader by lazy { ApkDownloader(client, dir) }

    private fun offer(url: String = "$base/d/abc", size: Long? = null) =
        UpdateOffer(versionName = "1.4.0", build = 3, notes = null, size = size, installUrl = url)

    private fun bytes(n: Int) = ByteArray(n) { (it % 251).toByte() }

    @After fun stop() { server.shutdown() }

    @Test fun writesTheFileAndReportsProgress() = runBlocking {
        val body = bytes(64 * 1024)
        server.enqueue(MockResponse().setBody(Buffer().write(body)))   // MockWebServer sets Content-Length
        val seen = mutableListOf<Float?>()
        val file = downloader.download(offer(size = body.size.toLong()), base) { seen += it }
        assertEquals(File(dir, "3.apk"), file)
        assertArrayEquals(body, file.readBytes())
        assertEquals(1f, seen.last())
        val req = server.takeRequest()
        assertEquals("/d/abc", req.path)
        assertNull(req.getHeader("Authorization"))
        assertNull(req.getHeader("Cookie"))
        assertEquals(listOf("3.apk"), dir.list()!!.toList())
    }

    @Test fun progressComesFromContentLengthWhenTheOfferHasNoSize() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(bytes(4096))))
        val seen = mutableListOf<Float?>()
        downloader.download(offer(size = null), base) { seen += it }
        assertEquals(1f, seen.last())
    }

    @Test fun refusesALinkOnAnotherHost() = runBlocking {
        try {
            downloader.download(offer(url = "http://evil.test:${server.port}/d/abc"), base) {}
            fail()
        } catch (e: UpdateError) {
            assertEquals("The download link isn't on devices.test.", e.message)
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun refusesAnotherSchemeOrPort() = runBlocking {
        for (url in listOf("https://devices.test:${server.port}/d/abc", "http://devices.test:${server.port + 1}/d/abc", "not a url")) {
            try { downloader.download(offer(url = url), base) {}; fail(url) } catch (e: UpdateError) {
                assertEquals("The download link isn't on devices.test.", e.message)
            }
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun aShortBodyIsRefusedAndDeleted() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(bytes(10))))
        try { downloader.download(offer(size = 1000), base) {}; fail() } catch (e: UpdateError) {
            assertEquals("The download was cut short. Try again.", e.message)
        }
        assertTrue(dir.list().orEmpty().isEmpty())
    }

    @Test fun anHttpErrorIsRefused() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404).setBody("gone"))
        try { downloader.download(offer(), base) {}; fail() } catch (e: UpdateError) {
            assertEquals("The download failed (HTTP 404).", e.message)
        }
        assertTrue(dir.list().orEmpty().isEmpty())
    }

    @Test fun cancelingDeletesThePartFile() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(bytes(64 * 1024))).throttleBody(1024, 50, TimeUnit.MILLISECONDS))
        val started = CompletableDeferred<Unit>()
        val job = launch(Dispatchers.Default) {
            downloader.download(offer(size = 64 * 1024L), base) { if ((it ?: 0f) > 0f) started.complete(Unit) }
        }
        withTimeout(10_000) { started.await() }
        assertTrue(File(dir, "3.apk.part").exists())
        withTimeout(10_000) { job.cancelAndJoin() }
        assertTrue(dir.list().orEmpty().toList().toString(), dir.list().orEmpty().isEmpty())
    }

    @Test fun clearEmptiesTheFolder() {
        dir.mkdirs()
        File(dir, "2.apk").writeText("old")
        File(dir, "3.apk.part").writeText("half")
        downloader.clear()
        assertTrue(dir.list().orEmpty().isEmpty())
    }
}
