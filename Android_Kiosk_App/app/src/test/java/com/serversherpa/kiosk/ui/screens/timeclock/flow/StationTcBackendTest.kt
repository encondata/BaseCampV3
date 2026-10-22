package com.serversherpa.kiosk.ui.screens.timeclock.flow

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.data.FakeStationApi
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.station.StationKeyStore
import com.serversherpa.kiosk.data.station.StationStatus
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StationTcBackendTest {
    @get:Rule val tmp = TemporaryFolder()

    private companion object { const val BASE = "https://api.example.com"; const val ORIGIN = "https://api.example.com:443" }

    private val tina = KioskPersonRow("p1", "Tina Turner", "Tina", "Turner", badge_uid = "B1")
    private val sam = KioskPersonRow("p2", "Sam Stone", "Sam", "Stone")

    private class Rig(val backend: StationTcBackend, val api: FakeStationApi, val db: KioskDatabase, val keys: StationKeyStore, val status: StationStatus, val serial: String)

    private var apiBase = BASE

    private suspend fun rig(key: String? = "k1", keyOrigin: String = ORIGIN, configure: FakeStationApi.() -> Unit = {}): Rig {
        val api = FakeStationApi().apply { peopleResult = { listOf(tina, sam) }; configure() }
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        val keys = StationKeyStore(MemorySecretStore()).apply { if (key != null) put(key, keyOrigin) }
        val status = StationStatus(keys, apiBase = { apiBase })
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create { File(tmp.root, "id.preferences_pb") })
        val identity = Identity(prefs)
        return Rig(StationTcBackend(db, api, status, identity, zone = { "America/Chicago" }), api, db, keys, status, identity.get().serial)
    }

    @Test fun peopleComeFromTheStationRouteAndReplaceTheLocalCopy() = runTest {
        val r = rig()
        r.db.people().insertAll(listOf(KioskPersonRow("old", "Gone Person").toEntity()))
        assertEquals(listOf("p1", "p2"), r.backend.people().map { it.id })
        assertEquals(setOf("p1", "p2"), r.db.people().all().map { it.id }.toSet())
        assertEquals("B1", r.db.people().all().first { it.id == "p1" }.badgeUid)
        assertEquals(listOf("k1"), r.api.keys)
        assertEquals(false, r.status.paused.value)
    }

    @Test fun statusAndPunchesGoUnderTheKeyWithTheZone() = runTest {
        val r = rig()
        r.backend.status("p1"); r.backend.clockIn("p1"); r.backend.clockOut("p1")
        assertEquals(listOf("status", "clockIn", "clockOut"), r.api.calls)
        assertEquals(listOf("k1", "k1", "k1"), r.api.keys)
        assertEquals(listOf(BASE, BASE, BASE), r.api.bases)                 // the validated base
    }

    @Test fun offlineKeepsTheLastPeopleList() = runTest {
        val r = rig()
        r.backend.people()
        r.api.peopleResult = { throw ApiError(0, "network") }
        assertEquals(setOf("p1", "p2"), r.backend.people().map { it.id }.toSet())
    }

    @Test fun offlineWithNoPeopleYetFails() = runTest {
        val r = rig { peopleResult = { throw ApiError(0, "network") } }
        try { r.backend.people(); fail("expected a failure") } catch (e: ApiError) { assertEquals("network", e.code) }
    }

    @Test fun anInvalidKeyIsDropped() = runTest {
        val r = rig { statusResult = { throw ApiError(401, "station_key_invalid") } }
        try { r.backend.status("p1"); fail("expected a failure") } catch (e: ApiError) { assertEquals(401, e.status) }
        assertNull(r.keys.get(ORIGIN))
        assertEquals(false, r.status.hasKey.value)
    }

    @Test fun aLapsedRegistrationPausesAndKeepsTheKey() = runTest {
        val r = rig { peopleResult = { throw ApiError(403, "kiosk_not_registered") } }
        r.db.people().insertAll(listOf(KioskPersonRow("p1", "Tina Turner").toEntity()))
        assertEquals(listOf("p1"), r.backend.people().map { it.id })     // the local copy, no error line
        assertEquals(true, r.status.paused.value)
        assertEquals("k1", r.keys.get(ORIGIN))
        r.api.peopleResult = { listOf(tina) }
        r.backend.people()
        assertEquals(false, r.status.paused.value)                        // renewed: running again
    }

    @Test fun noKeyMakesNoCall() = runTest {
        val r = rig(key = null)
        assertEquals(emptyList<KioskPersonRow>(), r.backend.people())
        try { r.backend.status("p1"); fail("expected a failure") } catch (e: ApiError) { assertEquals("station_key_missing", e.code) }
        assertEquals(emptyList<String>(), r.api.calls)
        assertEquals(false, r.status.hasKey.value)
    }

    /** The API URL was changed after the key was issued: the key is cleared, nothing is sent. */
    @Test fun aKeyFromAnotherOriginIsNeverSent() = runTest {
        apiBase = "https://evil.example.com"
        val r = rig()
        assertEquals(emptyList<KioskPersonRow>(), r.backend.people())
        try { r.backend.clockIn("p1"); fail("expected a failure") } catch (e: ApiError) { assertEquals("station_key_missing", e.code) }
        assertEquals(emptyList<String>(), r.api.calls)
        assertEquals(false, r.status.hasKey.value)
        apiBase = BASE
        assertNull(r.keys.get(ORIGIN))                                     // dropped, not just hidden
    }

    /** A punch that started under the old key answers 401 after a new key was issued (a re-setup
     *  while it ran): the new key is kept. */
    @Test fun aLatePunch401UnderAnOldKeyKeepsTheNewKey() = runTest {
        lateinit var keys: StationKeyStore
        val r = rig(key = "old") {
            clockInResult = { keys.put("new", ORIGIN); throw ApiError(401, "station_key_invalid") }
        }
        keys = r.keys
        try { r.backend.clockIn("p1"); fail("expected ApiError") } catch (e: ApiError) { assertEquals(401, e.status) }
        assertEquals(listOf("old"), r.api.keys)
        assertEquals("new", r.keys.get(ORIGIN))
    }
}
