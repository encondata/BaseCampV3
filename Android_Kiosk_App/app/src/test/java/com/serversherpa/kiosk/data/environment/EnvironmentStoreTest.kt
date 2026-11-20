package com.serversherpa.kiosk.data.environment

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.serversherpa.kiosk.core.environment.Env
import com.serversherpa.kiosk.core.environment.Environments
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.core.environment.asSaved
import com.serversherpa.kiosk.core.environment.portalUrl
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EnvironmentStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var data: DataStore<Preferences>
    private lateinit var store: EnvironmentStore

    private val legacyApi = stringPreferencesKey("ss.kiosk.apiUrl")
    private val legacyPortal = stringPreferencesKey("ss.kiosk.portalUrl")
    private val environmentKey = stringPreferencesKey("ss.kiosk.environment")
    private val listKey = stringPreferencesKey("ss.kiosk.environmentList")
    private val defaultPortal = "https://portal.dev.serversherpa.com"
    private val uat = SavedEnvironment.Named("uat", "UAT", "uat.serversherpa.com")

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        data = PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") }
        store = EnvironmentStore(KioskPrefs(data))
    }

    @After fun tearDown() { scope.cancel() }

    private suspend fun raw(): Preferences = data.data.first()

    @Test fun nothingSavedAtFirst() = runBlocking {
        assertNull(store.saved.first())
        assertFalse(store.everRegistered.first())
        assertNull(store.cachedList())
    }

    @Test fun savesNamedAndCustomInTheSharedShape() = runBlocking {
        store.save(uat)
        assertEquals(uat, store.saved.first())
        assertEquals("""{"kind":"named","id":"uat","name":"UAT","domain":"uat.serversherpa.com"}""", raw()[environmentKey])
        val custom = SavedEnvironment.Custom("http://10.10.48.103:8000", "http://10.10.48.103:5173")
        store.save(custom)
        assertEquals(custom, store.saved.first())
        assertEquals("""{"kind":"custom","api_url":"http://10.10.48.103:8000","portal_url":"http://10.10.48.103:5173"}""", raw()[environmentKey])
    }

    /** A saved Named entry is checked with the list's rules when read back: a tampered one
     *  (a foreign domain, a bad id, a blank name) counts as nothing saved, as on the edge. */
    @Test fun aTamperedSavedNamedCountsAsNothingSaved() = runBlocking {
        for (bad in listOf(
            """{"kind":"named","id":"uat","name":"UAT","domain":"evil.example.com"}""",
            """{"kind":"named","id":"uat","name":"UAT","domain":"uat.serversherpa.com:8443"}""",
            """{"kind":"named","id":"UAT!","name":"UAT","domain":"uat.serversherpa.com"}""",
            """{"kind":"named","id":"uat","name":"  ","domain":"uat.serversherpa.com"}""",
            """{"kind":"custom","api_url":"ftp://x","portal_url":"http://p"}""",
            """{"kind":"custom","api_url":"http://a:1","portal_url":""}""",
            """{"kind":"other"}""",
            """not json""",
        )) {
            data.edit { it[environmentKey] = bad }
            assertNull(bad, store.saved.first())
        }
    }

    @Test fun theRegisteredFlagIsSetOnceAndStays() = runBlocking {
        store.markRegistered()
        assertTrue(store.everRegistered.first())
        store.markRegistered()
        store.save(uat)
        assertTrue(store.everRegistered.first())
    }

    @Test fun theLastGoodListRoundTripsAndIsCheckedWhenRead() = runBlocking {
        val list = listOf(Env("rc2", "RC2", "rc2.serversherpa.com"), Env("dev", "Dev", "dev.serversherpa.com"))
        store.cacheList(list)
        assertEquals(list, store.cachedList())
        data.edit { it[listKey] = """{"version":1,"environments":[{"id":"x1","name":"X","domain":"evil.example.com"}]}""" }
        assertNull(store.cachedList())
        data.edit { it[listKey] = "garbage" }
        assertNull(store.cachedList())
    }

    // ---- migration of the URLs typed before the picker (Review Focus 4) ----

    @Test fun aBuiltInApiUrlBecomesThatEnvironmentAndTheOldKeysGo() = runBlocking {
        data.edit { it[legacyApi] = "https://api.uat.serversherpa.com"; it[legacyPortal] = "https://portal.uat.serversherpa.com" }
        store.migrateIfNeeded(defaultPortal)
        assertEquals(uat, store.saved.first())
        assertNull(raw()[legacyApi]); assertNull(raw()[legacyPortal])
    }

    @Test fun anyOtherApiUrlBecomesCustomWithItsPortalOrTheDefault() = runBlocking {
        data.edit { it[legacyApi] = "http://10.10.48.103:8000"; it[legacyPortal] = "http://10.10.48.103:5173" }
        store.migrateIfNeeded(defaultPortal)
        assertEquals(SavedEnvironment.Custom("http://10.10.48.103:8000", "http://10.10.48.103:5173"), store.saved.first())

        data.edit { it.remove(environmentKey); it[legacyApi] = "http://10.10.48.103:8000" }
        store.migrateIfNeeded(defaultPortal)
        assertEquals(SavedEnvironment.Custom("http://10.10.48.103:8000", defaultPortal), store.saved.first())
    }

    /** A host java.net.URI can't read (an underscore) worked before the upgrade: it stays Custom,
     *  never falls to the build default with the typed URL deleted. */
    @Test fun anUnderscoreHostStaysCustom() = runBlocking {
        data.edit { it[legacyApi] = "http://my_host:8000" }
        store.migrateIfNeeded(defaultPortal)
        assertEquals(SavedEnvironment.Custom("http://my_host:8000", defaultPortal), store.saved.first())
    }

    @Test fun nothingIsMigratedWhenNothingWasSaved() = runBlocking {
        store.migrateIfNeeded(defaultPortal)
        assertNull(store.saved.first())
        assertNull(raw()[environmentKey])
    }

    /** Once: the old keys are gone after the first run, so a later run changes nothing, and a
     *  saved environment is never replaced by old URLs. */
    @Test fun migrationRunsOnceAndNeverReplacesASavedEnvironment() = runBlocking {
        data.edit { it[legacyApi] = "https://api.uat.serversherpa.com" }
        store.migrateIfNeeded(defaultPortal)
        val dev = Environments.byId("dev")!!.asSaved()
        store.save(dev)
        store.migrateIfNeeded(defaultPortal)
        assertEquals(dev, store.saved.first())

        data.edit { it[legacyApi] = "http://10.0.2.2:8000" }   // old keys beside a saved environment
        store.migrateIfNeeded(defaultPortal)
        assertEquals(dev, store.saved.first())
        assertNull(raw()[legacyApi])
    }

    /** Before the migration has run (it runs in the background at start), what the kiosk connects
     *  to is already what the migration will save, so no call goes to the build default meanwhile. */
    @Test fun theOldUrlsAreUsedUntilTheMigrationLands() = runBlocking {
        val default = SavedEnvironment.Named("dev", "Dev", "dev.serversherpa.com")
        assertEquals(default, store.current(default).first())
        data.edit { it[legacyApi] = "http://10.10.48.103:8000" }
        assertEquals(SavedEnvironment.Custom("http://10.10.48.103:8000", default.portalUrl), store.current(default).first())
        store.migrateIfNeeded(default.portalUrl)
        assertEquals(SavedEnvironment.Custom("http://10.10.48.103:8000", default.portalUrl), store.current(default).first())
        data.edit { it[environmentKey] = """{"kind":"named","id":"uat","name":"UAT","domain":"evil.example.com"}""" }
        assertEquals(default, store.current(default).first())   // tampered: the build default, as on the edge
    }
}
