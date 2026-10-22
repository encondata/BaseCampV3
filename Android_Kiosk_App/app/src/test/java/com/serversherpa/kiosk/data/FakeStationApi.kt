package com.serversherpa.kiosk.data

import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.data.api.StationApi

/** A StationApi whose answers are set per test. Every call records the key it was given. */
class FakeStationApi : StationApi {
    val calls = ArrayList<String>()
    val keys = ArrayList<String>()
    @Volatile var peopleResult: () -> List<KioskPersonRow> = { emptyList() }
    @Volatile var statusResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), false) }
    @Volatile var clockInResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), true) }
    @Volatile var clockOutResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), false) }

    @Synchronized private fun record(call: String, key: String) { calls += call; keys += key }

    override suspend fun people(key: String, serial: String): List<KioskPersonRow> { record("people", key); return peopleResult() }
    override suspend fun status(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus { record("status", key); return statusResult(personId) }
    override suspend fun clockIn(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus { record("clockIn", key); return clockInResult(personId) }
    override suspend fun clockOut(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus { record("clockOut", key); return clockOutResult(personId) }
}
