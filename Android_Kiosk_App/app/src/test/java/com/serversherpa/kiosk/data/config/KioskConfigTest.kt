package com.serversherpa.kiosk.data.config

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
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
    private lateinit var prefs: KioskPrefs
    private lateinit var config: KioskConfig

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") })
        config = KioskConfig(prefs, "https://api.dev.serversherpa.com", "https://portal.dev.serversherpa.com", "0.1.0")
    }

    @After fun tearDown() { scope.cancel() }

    @Test fun defaultsThenOverride() = runBlocking {
        assertEquals("https://api.dev.serversherpa.com", config.apiUrlNow())
        assertEquals("https://portal.dev.serversherpa.com", config.portalUrlNow())
        prefs.setApiUrl("http://10.10.48.103:8000")
        assertEquals("http://10.10.48.103:8000", config.apiUrlNow())
        assertEquals("0.1.0", config.kioskVersion)
    }

    @Test fun normalize() {
        assertEquals("https://x.example", KioskConfig.normalizeUrl("  https://x.example/// "))
        assertNull(KioskConfig.normalizeUrl("x.example"))
        assertNull(KioskConfig.normalizeUrl("ftp://x"))
        assertNull(KioskConfig.normalizeUrl(""))
    }
}
