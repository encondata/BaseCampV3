package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.HeartbeatResult
import com.serversherpa.kiosk.core.model.KioskAssetsSync
import com.serversherpa.kiosk.core.model.KioskContainersSync
import com.serversherpa.kiosk.core.model.KioskLabelFonts
import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskRfidEnroll
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanBatchOut
import com.serversherpa.kiosk.core.model.KioskSetupIn
import com.serversherpa.kiosk.core.model.KioskSetupResult
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.model.KioskTrucksSync
import com.serversherpa.kiosk.core.model.PairCreated
import com.serversherpa.kiosk.core.model.PairPoll
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.model.SystemStatus

/** Every endpoint the kiosk calls — kiosk/src/lib/api.ts, function for function.
 *  Implementations throw ApiError on any non-2xx or transport failure
 *  unless a member says otherwise. */
interface KioskApi {
    suspend fun login(email: String, password: String): SessionData
    /** Sign in with a move's kiosk password (no person account involved); stores the session like [login]. */
    suspend fun moveLogin(password: String): SessionData
    suspend fun logout()
    suspend fun systemStatus(): SystemStatus
    suspend fun createPairRequest(serial: String, name: String): PairCreated
    /** 404 reads as EXPIRED; an approved answer stores the session. */
    suspend fun pollPair(code: String, pollToken: String): PairPoll
    suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult
    /** Never throws — the kiosk is dropping its own token either way. */
    suspend fun signOut(serial: String)

    // ── setup & sync ────────────────────────────────────────────────

    suspend fun setupOptions(): SetupOptions
    suspend fun submitSetup(body: KioskSetupIn): KioskSetupResult
    suspend fun syncAssets(initiativeId: String): KioskAssetsSync
    suspend fun syncPeople(): KioskPeopleSync
    suspend fun syncContainers(initiativeId: String): KioskContainersSync
    suspend fun syncTrucks(initiativeId: String): KioskTrucksSync

    // ── labels ──────────────────────────────────────────────────────

    /** GET /kiosk/sync/assets, the body exactly as received: the label generator needs every
     *  payload key and number literal (`12.0` stays `12.0`). [syncAssets] decodes the same body. */
    suspend fun assetsSyncRaw(initiativeId: String): String
    /** GET /kiosk/sync/label-templates, the body exactly as received. */
    suspend fun labelTemplatesRaw(initiativeId: String): String
    suspend fun labelFonts(initiativeId: String): KioskLabelFonts
    /** The font file's bytes. 404 font_not_found; 403 font_not_servable for the resident font. */
    suspend fun labelFontContent(id: String, initiativeId: String): ByteArray

    // ── scans, RFID, timeclock ──────────────────────────────────────

    /** Idempotent on client_scan_id; throws on anything but 200 (the outbox's back-off signal). */
    suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut
    /** 409 rfid_in_use (detail asset_name), 422 bad_rfid/rfid_too_long, 404, 423, network. */
    suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn): KioskRfidEnroll
    /** `tz`: the device's IANA zone, so "today" has a zone when the kiosk's site has none. */
    suspend fun timeclockStatus(personId: String, tz: String? = null): KioskTimeclockStatus
    suspend fun clockIn(body: ClockInIn): KioskTimeclockStatus
    suspend fun clockOut(body: ClockOutIn): KioskTimeclockStatus

    // ── station key ─────────────────────────────────────────────────

    /** POST /kiosk/station-key under the signed-in session: issues (or replaces) this Time Clock,
     *  RFID or Label station's key and returns it — the only time it is ever shown. Store it in
     *  [com.serversherpa.kiosk.data.station.StationKeyStore]; never log it. 409 not_rfid_station /
     *  kiosk_not_registered / setup_clear_pending, 403 not_signed_in_here, 404 device_not_found. */
    suspend fun issueStationKey(serial: String): String
}
