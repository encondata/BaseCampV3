package com.serversherpa.kiosk.data.config

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.environment.Env
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.data.environment.EnvironmentStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class KioskConfigTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var store: EnvironmentStore
    private lateinit var config: KioskConfig
    private val dev = SavedEnvironment.Named("dev", "Dev", "dev.serversherpa.com")

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        store = EnvironmentStore(KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") }))
        config = KioskConfig(store, dev, "0.1.0")
    }

    @After fun tearDown() { scope.cancel() }

    @Test fun theDefaultEnvironmentThenTheSavedOne() = runBlocking {
        assertEquals("https://api.dev.serversherpa.com", config.apiUrlNow())
        assertEquals("https://portal.dev.serversherpa.com", config.portalUrlNow())
        store.save(SavedEnvironment.Named("uat", "UAT", "uat.serversherpa.com"))
        assertEquals("https://api.uat.serversherpa.com", config.apiUrlNow())
        assertEquals("https://portal.uat.serversherpa.com", config.portalUrlNow())
        store.save(SavedEnvironment.Custom("http://10.10.48.103:8000", "http://10.10.48.103:5173"))
        assertEquals("http://10.10.48.103:8000", config.apiUrlNow())
        assertEquals("http://10.10.48.103:5173", config.portalUrlNow())
        assertEquals("0.1.0", config.kioskVersion)
    }

    /** Review Focus 1: a saved environment keeps its saved domain whatever the last good list
     *  says about its id (another domain, or gone). */
    @Test fun theSavedDomainWinsOverAnyLaterList() = runBlocking {
        store.save(SavedEnvironment.Named("rc1", "RC1", "rc1.serversherpa.com"))
        store.cacheList(listOf(Env("rc1", "RC1", "rc1-moved.serversherpa.com")))
        assertEquals("https://api.rc1.serversherpa.com", config.apiUrlNow())
        store.cacheList(listOf(Env("prod", "Prod", "serversherpa.com")))
        assertEquals("https://api.rc1.serversherpa.com", config.apiUrlNow())
    }

    @Test fun normalize() {
        assertEquals("https://x.example", KioskConfig.normalizeUrl("  https://x.example/// "))
        assertNull(KioskConfig.normalizeUrl("x.example"))
        assertNull(KioskConfig.normalizeUrl("ftp://x"))
        assertNull(KioskConfig.normalizeUrl(""))
    }
}
