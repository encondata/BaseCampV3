package com.serversherpa.kiosk.data

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.*
import com.serversherpa.kiosk.data.api.KioskApi

/** A KioskApi whose answers are set per test. Unset answers throw. */
open class FakeKioskApi : KioskApi {
    val calls = ArrayList<String>()
    var loginResult: () -> SessionData = { throw ApiError(401, "invalid_credentials") }
    var moveLoginResult: (String) -> SessionData = { throw ApiError(401, "invalid_move_password") }
    val moveLoginPasswords = ArrayList<String>()
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
    /** The raw /kiosk/sync/assets body; null encodes [assets]. */
    var assetsRaw: (() -> String)? = null
    var templatesRaw: () -> String = { """{"initiative_id":"i1","generated_at":"now","templates":[]}""" }
    var fonts: () -> KioskLabelFonts = { KioskLabelFonts() }
    var fontContent: (String) -> ByteArray = { throw ApiError(404, "font_not_found") }
    /** Suspending so a test can hold a POST open (stop/start mid-flight). */
    var postScansResult: suspend (KioskScanBatchIn) -> KioskScanBatchOut = { KioskScanBatchOut(accepted = it.scans.map { s -> s.client_scan_id }) }
    val scanBatches = ArrayList<KioskScanBatchIn>()
    var rfidResult: (String, KioskRfidEnrollIn) -> KioskRfidEnroll = { id, b -> KioskRfidEnroll(id, "Rack", "A-1", "SN", b.rfid_tag) }
    var statusResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), false) }
    var clockInResult: (ClockInIn) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Tina T"), true, KioskTimeclockEntry("e", "2026-09-15T09:00:00Z")) }
    var clockOutResult: (ClockOutIn) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Tina T"), false, null, KioskTimeclockLastEntry("e", "2026-09-15T09:00:00Z", "2026-09-15T12:12:00Z", 192)) }

    override suspend fun login(email: String, password: String) = loginResult().also { calls += "login" }
    override suspend fun moveLogin(password: String): SessionData { calls += "moveLogin"; moveLoginPasswords += password; return moveLoginResult(password) }
    override suspend fun logout() { calls += "logout" }
    override suspend fun systemStatus() = systemStatusResult().also { calls += "status" }
    override suspend fun createPairRequest(serial: String, name: String) = pairCreated().also { calls += "pair" }
    override suspend fun pollPair(code: String, pollToken: String) = pollResult().also { calls += "poll" }
    override suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult { calls += "heartbeat"; heartbeats += body; return heartbeatResult(body) }
    override suspend fun signOut(serial: String) { calls += "signOut" }
    // ── biometric sign-in ──
    // Suspending, so a test can hold a call open. Each call is recorded in `calls` first.
    var bioEnrollChallengeResult: suspend (String) -> String = { "nonce-1" }
    var bioEnrollResult: suspend (String, String, List<String>) -> BiometricEnrollOut = { _, _, _ -> BiometricEnrollOut("key-1", "tee", "2026-11-22T00:00:00Z") }
    val bioEnrolls = ArrayList<Triple<String, String, List<String>>>()
    var bioChallengeResult: suspend (String) -> BiometricChallengeOut = { throw ApiError(404, "no_biometric") }
    var bioSignInResult: suspend (String, String, String) -> SessionData = { _, _, _ -> fakeSession() }
    val bioSignIns = ArrayList<Triple<String, String, String>>()
    var bioForgetResult: suspend (String) -> Unit = { }
    override suspend fun biometricEnrollChallenge(serial: String): String { calls += "bioEnrollChallenge"; return bioEnrollChallengeResult(serial) }
    override suspend fun biometricEnroll(serial: String, nonce: String, chain: List<String>): BiometricEnrollOut { calls += "bioEnroll"; bioEnrolls += Triple(serial, nonce, chain); return bioEnrollResult(serial, nonce, chain) }
    override suspend fun biometricChallenge(serial: String): BiometricChallengeOut { calls += "bioChallenge"; return bioChallengeResult(serial) }
    override suspend fun biometricSignIn(keyId: String, challenge: String, signature: String): SessionData { calls += "bioSignIn"; bioSignIns += Triple(keyId, challenge, signature); return bioSignInResult(keyId, challenge, signature) }
    override suspend fun biometricForget(serial: String) { calls += "bioForget:$serial"; bioForgetResult(serial) }
    override suspend fun setupOptions() = setupOptionsResult().also { calls += "setupOptions" }
    override suspend fun submitSetup(body: KioskSetupIn) = submitSetupResult(body).also { calls += "submitSetup" }
    override suspend fun syncAssets(initiativeId: String) = assets().also { calls += "syncAssets" }
    override suspend fun syncPeople() = people().also { calls += "syncPeople" }
    override suspend fun syncContainers(initiativeId: String) = containers().also { calls += "syncContainers" }
    override suspend fun syncTrucks(initiativeId: String) = trucks().also { calls += "syncTrucks" }
    override suspend fun assetsSyncRaw(initiativeId: String): String =
        (assetsRaw?.invoke() ?: com.serversherpa.kiosk.data.api.KioskJson.encodeToString(KioskAssetsSync.serializer(), assets()))
            .also { calls += "syncAssets" }
    override suspend fun labelTemplatesRaw(initiativeId: String) = templatesRaw().also { calls += "labelTemplates" }
    override suspend fun labelFonts(initiativeId: String) = fonts().also { calls += "labelFonts" }
    /** Recorded before answering, so a refused download still shows as a call. */
    override suspend fun labelFontContent(id: String, initiativeId: String): ByteArray { calls += "fontContent:$id"; return fontContent(id) }
    override suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut { calls += "postScans"; scanBatches += body; return postScansResult(body) }
    override suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn) = rfidResult(assetId, body).also { calls += "rfid" }
    val statusZones = ArrayList<String?>()
    override suspend fun timeclockStatus(personId: String, tz: String?): KioskTimeclockStatus { statusZones += tz; return statusResult(personId).also { calls += "timeclockStatus" } }
    override suspend fun clockIn(body: ClockInIn) = clockInResult(body).also { calls += "clockIn" }
    override suspend fun clockOut(body: ClockOutIn) = clockOutResult(body).also { calls += "clockOut" }
    var issueStationKeyResult: (String) -> String = { "station-key-1" }
    override suspend fun issueStationKey(serial: String) = issueStationKeyResult(serial).also { calls += "issueStationKey" }

    // ── rolodex ─────────────────────────────────────────────────────
    // Suspending, so a test can hold a call open (a double tap while saving). Each call is
    // recorded in `calls` (and its body below) before it answers, so a refused one still shows.
    var rolodexWorkersResult: suspend () -> RolodexList = { RolodexList("now") }
    var rolodexWorkerResult: suspend (String) -> RolodexDetail = { throw ApiError(404, "person_not_found") }
    var rolodexOptionsResult: suspend () -> RolodexOptions = { RolodexOptions() }
    var rolodexDuplicatesResult: suspend (RolodexDuplicatesIn) -> List<RolodexMatch> = { emptyList() }
    val rolodexDuplicateBodies = ArrayList<RolodexDuplicatesIn>()
    var rolodexCreateResult: suspend (RolodexCreateIn) -> RolodexDetail = { throw ApiError(500, "unknown_error") }
    val rolodexCreates = ArrayList<RolodexCreateIn>()
    var rolodexUpdateResult: suspend (String, kotlinx.serialization.json.JsonObject) -> RolodexDetail = { _, _ -> throw ApiError(500, "unknown_error") }
    val rolodexUpdates = ArrayList<Pair<String, kotlinx.serialization.json.JsonObject>>()
    var rolodexPhotoResult: suspend (String, ByteArray) -> RolodexPhotoOut = { _, _ -> throw ApiError(500, "unknown_error") }
    val rolodexPhotos = ArrayList<Pair<String, ByteArray>>()

    override suspend fun rolodexWorkers(): RolodexList { calls += "rolodexWorkers"; return rolodexWorkersResult() }
    override suspend fun rolodexWorker(personId: String): RolodexDetail { calls += "rolodexWorker:$personId"; return rolodexWorkerResult(personId) }
    override suspend fun rolodexOptions(): RolodexOptions { calls += "rolodexOptions"; return rolodexOptionsResult() }
    override suspend fun rolodexDuplicates(body: RolodexDuplicatesIn): List<RolodexMatch> { calls += "rolodexDuplicates"; rolodexDuplicateBodies += body; return rolodexDuplicatesResult(body) }
    override suspend fun rolodexCreate(body: RolodexCreateIn): RolodexDetail { calls += "rolodexCreate"; rolodexCreates += body; return rolodexCreateResult(body) }
    override suspend fun rolodexUpdate(personId: String, patch: kotlinx.serialization.json.JsonObject): RolodexDetail { calls += "rolodexUpdate:$personId"; rolodexUpdates += personId to patch; return rolodexUpdateResult(personId, patch) }
    override suspend fun rolodexPhoto(personId: String, jpeg: ByteArray): RolodexPhotoOut { calls += "rolodexPhoto:$personId"; rolodexPhotos += personId to jpeg; return rolodexPhotoResult(personId, jpeg) }
}

fun fakeSession(roles: List<String> = listOf("worker"), maxRank: Int = 20, mustChange: Boolean = false, kioskMove: KioskMove? = null, personId: String = "p1") = SessionData(
    access_token = "tok", expires_in = 900, session_expires_at = "2026-09-16T00:00:00Z",
    person = PersonOut(id = personId, first_name = "Tina", last_name = "T", display_name = "Tina T"),
    roles = roles, must_change_password = mustChange, perms = mapOf("kiosk" to mapOf("view" to true)), max_rank = maxRank, kiosk_move = kioskMove,
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
