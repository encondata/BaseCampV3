package com.serversherpa.kiosk.data

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.*
import com.serversherpa.kiosk.data.api.KioskApi

/** A KioskApi whose answers are set per test. Unset answers throw. */
open class FakeKioskApi : KioskApi {
    val calls = ArrayList<String>()
    var loginResult: () -> SessionData = { throw ApiError(401, "invalid_credentials") }
    var heartbeatResult: (HeartbeatIn) -> HeartbeatResult = { HeartbeatResult("d1", it.name, "ok", null) }
    var heartbeats = ArrayList<HeartbeatIn>()
    var systemStatusResult: () -> SystemStatus = { SystemStatus() }
    var pairCreated: () -> PairCreated = { PairCreated("ABCD1234", "pt", "https://portal/link/ABCD1234", "2026-09-15T00:05:00Z") }
    var pollResult: () -> PairPoll = { PairPoll(PairStatus.PENDING, null) }
    var setupOptionsResult: () -> SetupOptions = { SetupOptions() }
    var submitSetupResult: (KioskSetupIn) -> KioskSetupResult = { throw ApiError(500, "unknown_error") }
    var assets: () -> KioskAssetsSync = { KioskAssetsSync("i1", "Move", "now") }
    var people: () -> KioskPeopleSync = { KioskPeopleSync("now") }
    var containers: () -> KioskContainersSync = { KioskContainersSync("i1", "now") }
    var trucks: () -> KioskTrucksSync = { KioskTrucksSync("i1", "now") }
    var postScansResult: (KioskScanBatchIn) -> KioskScanBatchOut = { KioskScanBatchOut(accepted = it.scans.map { s -> s.client_scan_id }) }
    val scanBatches = ArrayList<KioskScanBatchIn>()
    var rfidResult: (String, KioskRfidEnrollIn) -> KioskRfidEnroll = { id, b -> KioskRfidEnroll(id, "Rack", "A-1", "SN", b.rfid_tag) }
    var statusResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), false) }
    var clockInResult: (ClockInIn) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Tina T"), true, KioskTimeclockEntry("e", "2026-09-15T09:00:00Z")) }
    var clockOutResult: (ClockOutIn) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Tina T"), false, null, KioskTimeclockLastEntry("e", "2026-09-15T09:00:00Z", "2026-09-15T12:12:00Z", 192)) }

    override suspend fun login(email: String, password: String) = loginResult().also { calls += "login" }
    override suspend fun logout() { calls += "logout" }
    override suspend fun systemStatus() = systemStatusResult().also { calls += "status" }
    override suspend fun createPairRequest(serial: String, name: String) = pairCreated().also { calls += "pair" }
    override suspend fun pollPair(code: String, pollToken: String) = pollResult().also { calls += "poll" }
    override suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult { calls += "heartbeat"; heartbeats += body; return heartbeatResult(body) }
    override suspend fun signOut(serial: String) { calls += "signOut" }
    override suspend fun setupOptions() = setupOptionsResult().also { calls += "setupOptions" }
    override suspend fun submitSetup(body: KioskSetupIn) = submitSetupResult(body).also { calls += "submitSetup" }
    override suspend fun syncAssets(initiativeId: String) = assets().also { calls += "syncAssets" }
    override suspend fun syncPeople() = people().also { calls += "syncPeople" }
    override suspend fun syncContainers(initiativeId: String) = containers().also { calls += "syncContainers" }
    override suspend fun syncTrucks(initiativeId: String) = trucks().also { calls += "syncTrucks" }
    override suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut { calls += "postScans"; scanBatches += body; return postScansResult(body) }
    override suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn) = rfidResult(assetId, body).also { calls += "rfid" }
    override suspend fun timeclockStatus(personId: String) = statusResult(personId).also { calls += "timeclockStatus" }
    override suspend fun clockIn(body: ClockInIn) = clockInResult(body).also { calls += "clockIn" }
    override suspend fun clockOut(body: ClockOutIn) = clockOutResult(body).also { calls += "clockOut" }
}

fun fakeSession(roles: List<String> = listOf("worker"), maxRank: Int = 20, mustChange: Boolean = false) = SessionData(
    access_token = "tok", expires_in = 900, session_expires_at = "2026-09-16T00:00:00Z",
    person = PersonOut(id = "p1", first_name = "Tina", last_name = "T", display_name = "Tina T"),
    roles = roles, must_change_password = mustChange, perms = mapOf("kiosk" to mapOf("view" to true)), max_rank = maxRank,
)

class FakeRefresher : com.serversherpa.kiosk.data.api.SessionRefresher {
    var refreshResult: () -> SessionData? = { null }
    var stored: SessionData? = null
    var cleared = 0
    override val sessionEnded = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    override suspend fun refresh(): SessionData? = refreshResult()
    override fun clear() { cleared++; stored = null }
    override fun store(data: SessionData) { stored = data }
}

fun testIdentity(tmp: java.io.File, scope: kotlinx.coroutines.CoroutineScope): com.serversherpa.kiosk.data.identity.Identity =
    com.serversherpa.kiosk.data.identity.Identity(
        com.serversherpa.kiosk.data.prefs.KioskPrefs(
            androidx.datastore.preferences.core.PreferenceDataStoreFactory.create(scope = scope) { java.io.File(tmp, "id.preferences_pb") },
        ),
    )
