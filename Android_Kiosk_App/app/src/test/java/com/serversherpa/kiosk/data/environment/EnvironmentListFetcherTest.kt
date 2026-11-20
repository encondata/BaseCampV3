package com.serversherpa.kiosk.data.environment

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.environment.Env
import com.serversherpa.kiosk.core.environment.Environments
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EnvironmentListFetcherTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var server: MockWebServer
    private lateinit var store: EnvironmentStore
    private lateinit var fetcher: EnvironmentListFetcher

    /** The app's shared client carries the session's cookies and follows redirects; the
     *  fetcher must do neither. */
    private val sessionCookies = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {}
        override fun loadForRequest(url: HttpUrl): List<Cookie> =
            listOf(Cookie.Builder().name("ss_refresh").value("secret").hostOnlyDomain(url.host).build())
    }
    private val appClient = OkHttpClient.Builder().cookieJar(sessionCookies).build()

    private val twoEnvs = """{"version":1,"environments":[
        {"id":"rc2","name":"RC2","domain":"rc2.serversherpa.com"},
        {"id":"dev","name":"Dev","domain":"dev.serversherpa.com"}]}"""
    private val twoParsed = listOf(Env("rc2", "RC2", "rc2.serversherpa.com"), Env("dev", "Dev", "dev.serversherpa.com"))

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        server = MockWebServer().also { it.start() }
        store = EnvironmentStore(KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") }))
        fetcher = EnvironmentListFetcher(appClient, store, url = server.url("/environments.json").toString())
    }

    // Held, so the level set on it isn't lost to garbage collection.
    private val serverLog: Logger = Logger.getLogger(MockWebServer::class.java.name)
    private val serverLogLevel: Level? = serverLog.level

    @After fun tearDown() { server.shutdown(); scope.cancel(); serverLog.level = serverLogLevel }

    private fun ok(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    @Test fun freshThenSavedThenBuiltIn() = runBlocking {
        server.enqueue(ok(twoEnvs))
        assertEquals(twoParsed to ListSource.FRESH, fetcher.current())
        val req = server.takeRequest()
        assertEquals("/environments.json", req.path)
        assertNull(req.getHeader("Cookie"))               // no cookie and no auth ever go out
        assertNull(req.getHeader("Authorization"))

        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(twoParsed to ListSource.SAVED, fetcher.current())

        server.shutdown()                                 // offline, and nothing saved
        val fresh = EnvironmentStore(KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "u.preferences_pb") }))
        assertEquals(Environments.BUILT_IN to ListSource.BUILT_IN, EnvironmentListFetcher(appClient, fresh, server.url("/environments.json").toString()).current())
    }

    @Test fun anUnusableFileIsAFailedDownloadAndIsNotSaved() = runBlocking {
        server.enqueue(ok("""{"version":2,"environments":[{"id":"dev","name":"Dev","domain":"dev.serversherpa.com"}]}"""))
        assertEquals(Environments.BUILT_IN to ListSource.BUILT_IN, fetcher.current())
        server.enqueue(ok("""{"version":1,"environments":[{"id":"x1","name":"X","domain":"evil.example.com"}]}"""))
        assertEquals(Environments.BUILT_IN to ListSource.BUILT_IN, fetcher.current())
        assertNull(store.cachedList())
    }

    /** Review Focus 5: a redirect is a failure, and its target is never asked. */
    @Test fun aRedirectIsAFailureAndItsTargetIsNeverHit() = runBlocking {
        val target = MockWebServer().also { it.start() }
        try {
            target.enqueue(ok(twoEnvs))
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", target.url("/environments.json").toString()))
            assertEquals(Environments.BUILT_IN to ListSource.BUILT_IN, fetcher.current())
            assertEquals(0, target.requestCount)
        } finally { target.shutdown() }
    }

    @Test fun anOversizedBodyIsAFailure() = runBlocking {
        val padding = " ".repeat(Environments.MAX_BODY)
        server.enqueue(ok(twoEnvs + padding))
        assertEquals(Environments.BUILT_IN to ListSource.BUILT_IN, fetcher.current())
        // Without a Content-Length too (chunked), the read stops past the limit.
        server.enqueue(MockResponse().setChunkedBody(twoEnvs + padding, 4096))
        assertEquals(Environments.BUILT_IN to ListSource.BUILT_IN, fetcher.current())
        assertNull(store.cachedList())
    }

    /** A server that never answers falls back after the 5 s call timeout, to the saved list. */
    @Test fun aSilentServerFallsBackAfterTheTimeout() = runBlocking {
        store.cacheList(twoParsed)
        serverLog.level = Level.SEVERE   // the abandoned connection makes MockWebServer warn
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val started = System.nanoTime()
        assertEquals(twoParsed to ListSource.SAVED, fetcher.current())
        val tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertTrue("took $tookMs ms", tookMs in 4_000..9_000)
    }

    /** Review Focus 1: the kiosk keeps connecting to its saved domain whatever a later list says
     *  (the entry's domain changed there, or the entry is gone). */
    @Test fun aLaterListNeverMovesTheSavedEnvironment() = runBlocking {
        val rc1 = SavedEnvironment.Named("rc1", "RC1", "rc1.serversherpa.com")
        store.save(rc1)
        val config = KioskConfig(store, SavedEnvironment.Named("dev", "Dev", "dev.serversherpa.com"), "0.1.0")
        server.enqueue(ok("""{"version":1,"environments":[{"id":"rc1","name":"RC1","domain":"rc1-new.serversherpa.com"}]}"""))
        assertEquals(ListSource.FRESH, fetcher.current().second)
        assertEquals("https://api.rc1.serversherpa.com", config.apiUrlNow())
        server.enqueue(ok(twoEnvs))                       // rc1 dropped from the list
        assertEquals(ListSource.FRESH, fetcher.current().second)
        assertEquals("https://api.rc1.serversherpa.com", config.apiUrlNow())
        assertEquals("https://portal.rc1.serversherpa.com", config.portalUrlNow())
        assertEquals(rc1, store.saved.first())
    }
}
