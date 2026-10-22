package com.serversherpa.kiosk.ui.screens.timeclock.flow

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import java.time.ZoneId
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionTcBackendTest {
    @get:Rule val tmp = TemporaryFolder()

    private val row = KioskPersonRow(
        "p1", "Jimmy Henderson", "James", "Henderson", "Jimmy", "100348", true, true,
        badge_uid = "B-UID-1", job_title = "Crew lead", external_id = "E-42",
    )

    @Test fun peopleComeFromTheLocalCopyAndTzRidesOnEveryStatusReadAndPunch() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.people().insertAll(listOf(row.toEntity()))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "tc.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val identity = Identity(prefs)
        var clockIn: ClockInIn? = null
        var clockOut: ClockOutIn? = null
        val api = FakeKioskApi().apply {
            clockInResult = { clockIn = it; KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Jimmy Henderson"), true) }
            clockOutResult = { clockOut = it; KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Jimmy Henderson"), false) }
        }
        val backend = SessionTcBackend(db, api, identity, prefs)

        assertEquals(listOf(row), backend.people())

        backend.status("p1")
        backend.clockIn("p1")
        backend.clockOut("p1")
        val zone = ZoneId.systemDefault().id
        assertEquals(listOf(zone), api.statusZones)
        val serial = identity.get().serial
        assertEquals(ClockInIn(serial, "p1", "s1", "i1", zone), clockIn)
        assertEquals(ClockOutIn(serial, "p1", zone), clockOut)
    }
}
