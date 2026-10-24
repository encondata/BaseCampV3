package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.model.BiometricChallengeOut
import com.serversherpa.kiosk.core.model.BiometricEnrollOut
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
import com.serversherpa.kiosk.core.model.RolodexCreateIn
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexDuplicatesIn
import com.serversherpa.kiosk.core.model.RolodexList
import com.serversherpa.kiosk.core.model.RolodexMatch
import com.serversherpa.kiosk.core.model.RolodexOptions
import com.serversherpa.kiosk.core.model.RolodexPhotoOut
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.model.SystemStatus
import kotlinx.serialization.json.JsonObject

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

    // ── biometric sign-in (errors as {"detail":{"code":…}}) ─────────

    /** POST /kiosk/biometric/enroll-challenge under the session: the enroll nonce. 403
     *  enroll_window_closed (not a fresh password session here) / not_personal_device, 423. */
    suspend fun biometricEnrollChallenge(serial: String): String
    /** POST /kiosk/biometric/enroll under the session. [chain]: leaf first, standard base64 DER.
     *  403 enroll_window_closed / not_personal_device, 401 bad_challenge, 422 attestation_failed
     *  (detail.reason) / attestation_status_unavailable, 423 read_only_mode. */
    suspend fun biometricEnroll(serial: String, nonce: String, chain: List<String>): BiometricEnrollOut
    /** POST /kiosk/biometric/challenge, no session: whose card this phone shows, and the challenge
     *  to sign. 404 no_biometric, 429 biometric_rate_limited. */
    suspend fun biometricChallenge(serial: String): BiometricChallengeOut
    /** POST /kiosk/biometric/sign-in, no session; stores the session like [login] (the server sets
     *  the refresh cookie and binds the session to the serial). 429 biometric_rate_limited, 401
     *  bad_challenge / bad_signature / account_disabled, 404 no_biometric, 403 not_personal_device /
     *  kiosk_not_allowed / password_change_required / biometric_expired. */
    suspend fun biometricSignIn(keyId: String, challenge: String, signature: String): SessionData
    /** DELETE /kiosk/biometric?serial= under the session: revokes the person's own key here (204 always). */
    suspend fun biometricForget(serial: String)

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

    // ── rolodex (admins, rank 60+; errors as {"detail":{"code":…}}) ──

    /** GET /kiosk/rolodex/workers. Rows carry no email or phone. 403 forbidden / move_locked. */
    suspend fun rolodexWorkers(): RolodexList
    /** GET /kiosk/rolodex/workers/{person_id}. 404 person_not_found. */
    suspend fun rolodexWorker(personId: String): RolodexDetail
    /** GET /kiosk/rolodex/options: levels, statuses and partners for the pickers and filter chips. */
    suspend fun rolodexOptions(): RolodexOptions
    /** POST /kiosk/rolodex/duplicates: the people a new worker may duplicate (the `matches` list). */
    suspend fun rolodexDuplicates(body: RolodexDuplicatesIn): List<RolodexMatch>
    /** POST /kiosk/rolodex/workers → 201. 409 possible_duplicate (unless allow_duplicate) / email_in_use,
     *  422 unknown_level / partner_not_found / partner_archived, 423 read_only_mode. */
    suspend fun rolodexCreate(body: RolodexCreateIn): RolodexDetail
    /** PATCH /kiosk/rolodex/workers/{person_id} with only the changed fields; an explicit `null` clears one
     *  (build it with core.people.buildPatch). 403 rank_too_low / cannot_target_self, 409 email_in_use,
     *  422 blacklist_requires_note / unknown_level / partner_not_found / partner_archived / unknown_status, 423. */
    suspend fun rolodexUpdate(personId: String, patch: JsonObject): RolodexDetail
    /** PUT /kiosk/rolodex/workers/{person_id}/photo with the raw JPEG as the body (`Content-Type: image/jpeg`).
     *  413 file_too_large, 422 empty_file / invalid_file_type / unreadable_image / image_too_large, 403 rank_too_low. */
    suspend fun rolodexPhoto(personId: String, jpeg: ByteArray): RolodexPhotoOut
}
