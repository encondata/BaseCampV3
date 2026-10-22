package com.serversherpa.kiosk.data

import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.data.api.StationApi
import com.serversherpa.kiosk.data.api.StationCredentials

/** A StationApi whose answers are set per test. Every call records the key and base URL it was given. */
class FakeStationApi : StationApi {
    val calls = ArrayList<String>()
    val keys = ArrayList<String>()
    val bases = ArrayList<String>()
    @Volatile var peopleResult: () -> List<KioskPersonRow> = { emptyList() }
    @Volatile var statusResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), false) }
    @Volatile var clockInResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), true) }
    @Volatile var clockOutResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), false) }

    @Synchronized private fun record(call: String, creds: StationCredentials) { calls += call; keys += creds.key; bases += creds.baseUrl }

    override suspend fun people(creds: StationCredentials, serial: String): List<KioskPersonRow> { record("people", creds); return peopleResult() }
    override suspend fun status(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus { record("status", creds); return statusResult(personId) }
    override suspend fun clockIn(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus { record("clockIn", creds); return clockInResult(personId) }
    override suspend fun clockOut(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus { record("clockOut", creds); return clockOutResult(personId) }
}
