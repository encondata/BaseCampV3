package com.serversherpa.kiosk.data.prefs

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
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
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Clear Setup memory — same JSON shape and key as the web kiosk's setupClear.ts. */
@Serializable
data class SetupClearRecord(val id: String, val acked: Boolean = false, val notice: Boolean = false)

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
        val devMode = booleanPreferencesKey("ss.kiosk.devMode")
        val apiUrl = stringPreferencesKey("ss.kiosk.apiUrl")
        val portalUrl = stringPreferencesKey("ss.kiosk.portalUrl")
        val serial = stringPreferencesKey("ss.kiosk.serial")
        val name = stringPreferencesKey("ss.kiosk.name")
        val setupClear = stringPreferencesKey("ss.kiosk.setupClear")
    }

    val setupState: Flow<SetupState> = store.data.map { SetupState.fromWire(it[Keys.setupState]) }
    suspend fun setSetupState(state: SetupState) { store.edit { it[Keys.setupState] = state.wire } }

    /** Drops the saved setup and marks setup incomplete in one write, so a crash between can't leave a half-cleared setup. */
    suspend fun clearSetup() { store.edit { it.remove(Keys.setupSelection); it[Keys.setupState] = SetupState.INCOMPLETE.wire } }

    private fun decodeSetupClear(raw: String?): SetupClearRecord? =
        raw?.let { try { json.decodeFromString<SetupClearRecord>(it) } catch (e: Exception) { null } }

    private fun encodeSetupClear(r: SetupClearRecord): String = json.encodeToString(SetupClearRecord.serializer(), r)

    val setupClear: Flow<SetupClearRecord?> = store.data.map { decodeSetupClear(it[Keys.setupClear]) }

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
    suspend fun setRfid(s: RfidSettings) { store.edit { it[Keys.rfid] = s.toJson() } }

    fun checkpoint(id: CheckpointId): Flow<String> = store.data.map { it[stringPreferencesKey(id.storageKey)]?.takeIf { v -> v.isNotBlank() } ?: id.fallback }
    suspend fun setCheckpoint(id: CheckpointId, key: String) { store.edit { it[stringPreferencesKey(id.storageKey)] = key } }

    val devMode: Flow<Boolean> = store.data.map { it[Keys.devMode] ?: false }
    suspend fun setDevMode(on: Boolean) { store.edit { it[Keys.devMode] = on } }

    val apiUrl: Flow<String?> = store.data.map { it[Keys.apiUrl] }
    suspend fun setApiUrl(url: String?) { store.edit { if (url == null) it.remove(Keys.apiUrl) else it[Keys.apiUrl] = url } }

    val portalUrl: Flow<String?> = store.data.map { it[Keys.portalUrl] }
    suspend fun setPortalUrl(url: String?) { store.edit { if (url == null) it.remove(Keys.portalUrl) else it[Keys.portalUrl] = url } }

    val serial: Flow<String?> = store.data.map { it[Keys.serial] }
    suspend fun setSerial(serial: String) { store.edit { it[Keys.serial] = serial } }

    val name: Flow<String?> = store.data.map { it[Keys.name] }
    suspend fun setName(name: String?) { store.edit { if (name == null) it.remove(Keys.name) else it[Keys.name] = name } }

    suspend fun snapshot(): Preferences = store.data.first()
}
