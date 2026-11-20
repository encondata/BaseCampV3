package com.serversherpa.kiosk.data.prefs

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.serversherpa.kiosk.core.labels.LabelOptions
import com.serversherpa.kiosk.core.labels.PrinterIdentity
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.parseRfidSettings
import com.serversherpa.kiosk.core.rfid.toJson
import com.serversherpa.kiosk.core.settings.Appearance
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.SoundSettings
import com.serversherpa.kiosk.core.settings.parseAppearance
import com.serversherpa.kiosk.core.settings.parseSoundSettings
import com.serversherpa.kiosk.core.settings.toJson
import com.serversherpa.kiosk.core.setup.SetupState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** Clear Setup memory — same JSON shape and key as the web kiosk's setupClear.ts. */
@Serializable
data class SetupClearRecord(val id: String, val acked: Boolean = false, val notice: Boolean = false)

/** [KioskPrefs.environment]: the saved environment's JSON, and the pre-picker URLs not yet migrated. */
data class EnvironmentPrefs(val environment: String?, val legacyApiUrl: String?, val legacyPortalUrl: String?)

/** This phone's biometric sign-in, saved at enrollment: the server's key id, and whose key it is.
 *  [email] is the address typed at that password sign-in (the server never sends one), so the
 *  expired card can pre-fill it. The private key itself lives in Android Keystore. */
@Serializable
data class BiometricEnrollment(val keyId: String, val personId: String, val email: String? = null)

/**
 * Every kiosk-local value the web kiosk kept in localStorage, in one
 * DataStore file. Keys keep the web's `ss.kiosk.*` names so the two apps
 * read the same way in a bug report.
 */
class KioskPrefs(private val store: DataStore<Preferences>) {
    private val json = Json { ignoreUnknownKeys = true }

    private object Keys {
        val setupState = stringPreferencesKey("ss.kiosk.setupState")
        val setupSelection = stringPreferencesKey("ss.kiosk.setup")
        val appearance = stringPreferencesKey("ss.kiosk.appearance")
        val sound = stringPreferencesKey("ss.kiosk.sound")
        val rfid = stringPreferencesKey("ss.kiosk.rfid")
        val labels = stringPreferencesKey("ss.kiosk.labels")
        val devMode = booleanPreferencesKey("ss.kiosk.devMode")
        val offerSledBothToEveryone = booleanPreferencesKey("ss.kiosk.offerSledBothToEveryone")
        val sledFlash = booleanPreferencesKey("ss.kiosk.sledFlash")
        val notificationPermissionAsked = booleanPreferencesKey("ss.kiosk.notificationPermissionAsked")
        /** The URLs typed before the environment picker; read only until [migrateLegacyUrls] removes them. */
        val legacyApiUrl = stringPreferencesKey("ss.kiosk.apiUrl")
        val legacyPortalUrl = stringPreferencesKey("ss.kiosk.portalUrl")
        val environment = stringPreferencesKey("ss.kiosk.environment")
        val environmentList = stringPreferencesKey("ss.kiosk.environmentList")
        val everRegistered = booleanPreferencesKey("ss.kiosk.everRegistered")
        val serial = stringPreferencesKey("ss.kiosk.serial")
        val name = stringPreferencesKey("ss.kiosk.name")
        val setupClear = stringPreferencesKey("ss.kiosk.setupClear")
        val signInMethod = stringPreferencesKey("ss.kiosk.signInMethod")
        val biometric = stringPreferencesKey("ss.kiosk.biometric")
    }

    val setupState: Flow<SetupState> = store.data.map { SetupState.fromWire(it[Keys.setupState]) }
    suspend fun setSetupState(state: SetupState) { store.edit { it[Keys.setupState] = state.wire } }

    /** Drops the saved setup and marks setup incomplete in one write, so a crash between can't leave a half-cleared setup. */
    suspend fun clearSetup() { store.edit { it.remove(Keys.setupSelection); it[Keys.setupState] = SetupState.INCOMPLETE.wire } }

    /** Writes all three fields, defaults included, so the stored shape matches the web's; reads tolerantly. */
    private val clearJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private fun decodeSetupClear(raw: String?): SetupClearRecord? =
        raw?.let { try { clearJson.decodeFromString<SetupClearRecord>(it) } catch (e: Exception) { null } }

    private fun encodeSetupClear(r: SetupClearRecord): String = clearJson.encodeToString(SetupClearRecord.serializer(), r)

    val setupClear: Flow<SetupClearRecord?> = store.data.map { decodeSetupClear(it[Keys.setupClear]) }

    /** The setup state and whether the Clear Setup notice is up, from one snapshot, so a
     *  reader never sees the INCOMPLETE a clear wrote without the notice it wrote with it. */
    val setupStateWithClearNotice: Flow<Pair<SetupState, Boolean>> = store.data.map { p ->
        SetupState.fromWire(p[Keys.setupState]) to (decodeSetupClear(p[Keys.setupClear])?.notice == true)
    }

    /**
     * Applies a Clear Setup id not applied before: drops the saved setup, marks setup
     * incomplete and raises the notice, all in one write. True only the first time for
     * an id. A failed write throws to the caller (it is never swallowed here).
     */
    suspend fun applySetupClear(id: String): Boolean {
        var applied = false
        store.edit { p ->
            if (decodeSetupClear(p[Keys.setupClear])?.id != id) {
                p.remove(Keys.setupSelection)
                p[Keys.setupState] = SetupState.INCOMPLETE.wire
                p[Keys.setupClear] = encodeSetupClear(SetupClearRecord(id, acked = false, notice = true))
                applied = true
            }
        }
        return applied
    }

    /** The applied id the next beat should acknowledge, or null. */
    suspend fun pendingSetupClearAck(): String? = setupClear.first()?.takeIf { !it.acked }?.id

    /** The ack has landed only when THIS beat carried it and the reply stopped asking for it. */
    suspend fun settleSetupClearAck(sentAck: String?, replyId: String?) {
        store.edit { p ->
            val cur = decodeSetupClear(p[Keys.setupClear]) ?: return@edit
            if (!cur.acked && sentAck == cur.id && replyId != cur.id) p[Keys.setupClear] = encodeSetupClear(cur.copy(acked = true))
        }
    }

    /** Kiosk Setup completed: the "an administrator cleared…" banner goes away. */
    suspend fun dismissSetupClearNotice() {
        store.edit { p ->
            val cur = decodeSetupClear(p[Keys.setupClear]) ?: return@edit
            if (cur.notice) p[Keys.setupClear] = encodeSetupClear(cur.copy(notice = false))
        }
    }

    val setupSelection: Flow<KioskSetupSelection?> = store.data.map { p ->
        p[Keys.setupSelection]?.let { raw -> try { json.decodeFromString<KioskSetupSelection>(raw) } catch (e: Exception) { null } }
    }
    suspend fun setSetupSelection(selection: KioskSetupSelection?) {
        store.edit { if (selection == null) it.remove(Keys.setupSelection) else it[Keys.setupSelection] = json.encodeToString(KioskSetupSelection.serializer(), selection) }
    }

    val appearance: Flow<Appearance> = store.data.map { parseAppearance(it[Keys.appearance]) }
    suspend fun setAppearance(a: Appearance) { store.edit { it[Keys.appearance] = a.toJson() } }

    val sound: Flow<SoundSettings> = store.data.map { parseSoundSettings(it[Keys.sound]) }
    suspend fun setSound(s: SoundSettings) { store.edit { it[Keys.sound] = s.toJson() } }

    val rfid: Flow<RfidSettings> = store.data.map { parseRfidSettings(it[Keys.rfid]) }

    /** Writes a whole snapshot. A snapshot built from a stale read can undo a change made
     *  meanwhile, so settings changes go through [updateRfid]; this stays for tests. */
    suspend fun setRfid(s: RfidSettings) { store.edit { it[Keys.rfid] = s.toJson() } }

    /** Reads and writes in one edit (ruling 31), so two changes landing together never
     *  overwrite each other's field. */
    suspend fun updateRfid(transform: (RfidSettings) -> RfidSettings) {
        store.edit { it[Keys.rfid] = transform(parseRfidSettings(it[Keys.rfid])).toJson() }
    }

    private fun decodeLabels(raw: String?): LabelOptions =
        raw?.let { try { json.decodeFromString<LabelOptions>(it) } catch (e: Exception) { null } } ?: LabelOptions()

    /** The saved printer, offsets and peel/tear choice; defaults when nothing (or nothing readable) is saved. */
    val labels: Flow<LabelOptions> = store.data.map { decodeLabels(it[Keys.labels]) }

    /** Reads and writes in one edit, so two setters never overwrite each other's field. */
    suspend fun updateLabels(change: (LabelOptions) -> LabelOptions) {
        store.edit { it[Keys.labels] = json.encodeToString(LabelOptions.serializer(), change(decodeLabels(it[Keys.labels]))) }
    }

    /** Where `PrinterGuard` keeps the printers stopped after a cut font install (D8). */
    val printerStops: PrinterStopsStore get() = PrinterStopsStore(store)

    fun checkpoint(id: CheckpointId): Flow<String> = store.data.map { it[stringPreferencesKey(id.storageKey)]?.takeIf { v -> v.isNotBlank() } ?: id.fallback }
    suspend fun setCheckpoint(id: CheckpointId, key: String) { store.edit { it[stringPreferencesKey(id.storageKey)] = key } }

    val devMode: Flow<Boolean> = store.data.map { it[Keys.devMode] ?: false }
    suspend fun setDevMode(on: Boolean) { store.edit { it[Keys.devMode] = on } }

    /** The Developer tab's "Offer Both in Sled triggers to everyone" (H6): off, only developers see
     *  the Both option (a sled already set to Both keeps it). Its own key, never part of [rfid], so
     *  it is never part of a sled push. */
    val offerSledBothToEveryone: Flow<Boolean> = store.data.map { it[Keys.offerSledBothToEveryone] ?: false }
    suspend fun setOfferSledBothToEveryone(on: Boolean) { store.edit { it[Keys.offerSledBothToEveryone] = on } }

    /** The RFID tab's "Flash when the sled connects or drops" (H7): on, a full-screen red "Sled
     *  disconnected" or green "Ready to scan". Its own key, never part of [rfid], so it is never
     *  part of a sled push. */
    val sledFlash: Flow<Boolean> = store.data.map { it[Keys.sledFlash] ?: true }
    suspend fun setSledFlash(on: Boolean) { store.edit { it[Keys.sledFlash] = on } }

    /** Whether Settings › This Kiosk has asked for POST_NOTIFICATIONS on this phone: a phone made
     *  personal in the portal is asked once, the first time Settings finds it registered for push
     *  without the permission (the switch's turn-on always asks). */
    val notificationPermissionAsked: Flow<Boolean> = store.data.map { it[Keys.notificationPermissionAsked] ?: false }
    suspend fun setNotificationPermissionAsked() { store.edit { it[Keys.notificationPermissionAsked] = true } }

    /** How the person signed in here last ("password" | "link" | "biometric"), as the last sign-in heartbeat
     *  told the portal; a restored session is that same sign-in. */
    val signInMethod: Flow<String?> = store.data.map { it[Keys.signInMethod] }
    suspend fun setSignInMethod(wire: String) { store.edit { it[Keys.signInMethod] = wire } }

    /** This phone's biometric sign-in, or null (none, or nothing readable). One key, one write. */
    val biometric: Flow<BiometricEnrollment?> = store.data.map { p ->
        p[Keys.biometric]?.let { raw -> try { json.decodeFromString<BiometricEnrollment>(raw) } catch (e: Exception) { null } }
    }
    suspend fun setBiometric(enrollment: BiometricEnrollment?) {
        store.edit { if (enrollment == null) it.remove(Keys.biometric) else it[Keys.biometric] = json.encodeToString(BiometricEnrollment.serializer(), enrollment) }
    }

    /** The saved environment as stored (JSON, checked by EnvironmentStore), with the URLs typed
     *  before the picker while they are still there, from one snapshot. */
    val environment: Flow<EnvironmentPrefs> = store.data.map { p ->
        EnvironmentPrefs(p[Keys.environment], p[Keys.legacyApiUrl], p[Keys.legacyPortalUrl])
    }
    suspend fun setEnvironment(json: String) { store.edit { it[Keys.environment] = json } }

    /**
     * The URLs typed before the picker, in one write: with no environment saved, [convert]'s
     * answer (when not null) is saved as the environment; the old keys are removed either way.
     * Nothing happens when neither old key is there, so it runs once.
     */
    suspend fun migrateLegacyUrls(convert: (api: String?, portal: String?) -> String?) {
        store.edit { p ->
            val api = p[Keys.legacyApiUrl]
            val portal = p[Keys.legacyPortalUrl]
            if (api == null && portal == null) return@edit
            if (p[Keys.environment] == null) convert(api, portal)?.let { p[Keys.environment] = it }
            p.remove(Keys.legacyApiUrl)
            p.remove(Keys.legacyPortalUrl)
        }
    }

    /** The last good environment list download, as stored (checked again when read). */
    val environmentList: Flow<String?> = store.data.map { it[Keys.environmentList] }
    suspend fun setEnvironmentList(json: String) { store.edit { it[Keys.environmentList] = json } }

    /** Whether any server has ever registered this kiosk. Nothing clears it: only a fresh
     *  install or clearing the app's data does. */
    val everRegistered: Flow<Boolean> = store.data.map { it[Keys.everRegistered] ?: false }
    suspend fun setEverRegistered() { store.edit { if (it[Keys.everRegistered] != true) it[Keys.everRegistered] = true } }

    val serial: Flow<String?> = store.data.map { it[Keys.serial] }
    suspend fun setSerial(serial: String) { store.edit { it[Keys.serial] = serial } }

    val name: Flow<String?> = store.data.map { it[Keys.name] }
    suspend fun setName(name: String?) { store.edit { if (name == null) it.remove(Keys.name) else it[Keys.name] = name } }

    suspend fun snapshot(): Preferences = store.data.first()
}

/**
 * The printers `PrinterGuard` stopped after a cut font install (D8), under `ss.kiosk.printerStops`
 * (iOS's key and JSON shape): such a printer is still waiting for the rest of the font after the
 * app is relaunched, so the stop must outlive the launch. A pending `~JX` clear isn't kept (D16
 * keeps it in memory). The guard writes it in the order its marks change.
 */
class PrinterStopsStore(private val store: DataStore<Preferences>) {
    private val json = Json { ignoreUnknownKeys = true }

    /** The stopped printers; none when nothing (or nothing readable) is saved. A Bluetooth serial
     *  reads back upper-cased, whatever was written. */
    suspend fun load(): Set<PrinterIdentity> {
        val raw = try {
            store.data.first()[KEY]
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return emptySet()
        val stops = try {
            json.decodeFromString(ListSerializer(PrinterIdentity.serializer()), raw)
        } catch (e: Exception) {
            return emptySet()
        }
        return stops.map { if (it is PrinterIdentity.Bluetooth) PrinterIdentity.Bluetooth(it.serial.uppercase()) else it }.toSet()
    }

    /** Saves [stops] (none removes the key). */
    suspend fun save(stops: Set<PrinterIdentity>) {
        store.edit {
            if (stops.isEmpty()) {
                it.remove(KEY)
            } else {
                it[KEY] = json.encodeToString(ListSerializer(PrinterIdentity.serializer()), stops.sortedBy { s -> s.sortKey })
            }
        }
    }

    companion object {
        val KEY = stringPreferencesKey("ss.kiosk.printerStops")
    }
}
