package com.serversherpa.kiosk.data.environment

import com.serversherpa.kiosk.core.environment.Env
import com.serversherpa.kiosk.core.environment.Environments
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.core.environment.portalUrl
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.prefs.EnvironmentPrefs
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The environment this kiosk saved, the last good download of the environment list, and whether
 * any server has ever registered this kiosk (all in [KioskPrefs]). A saved environment is checked
 * again whenever it is read: a Named one by the list's entry rules, a Custom one by the typed-URL
 * rule. One that fails counts as nothing saved, as on the laptop edge.
 */
class EnvironmentStore(private val prefs: KioskPrefs) {
    private val json = Json { ignoreUnknownKeys = true }

    /** The saved environment, or null when nothing (or nothing valid) is saved. */
    val saved: Flow<SavedEnvironment?> = prefs.environment.map { decode(it.environment) }

    /**
     * What the kiosk connects to: the saved environment, else [default]. Until [migrateIfNeeded]
     * has run, URLs typed before the picker resolve the way it will save them, so nothing reaches
     * [default] meanwhile.
     */
    fun current(default: SavedEnvironment): Flow<SavedEnvironment> = prefs.environment.map { resolve(it, default) }

    suspend fun save(env: SavedEnvironment) { prefs.setEnvironment(encode(env)) }

    val everRegistered: Flow<Boolean> = prefs.everRegistered
    suspend fun markRegistered() { prefs.setEverRegistered() }

    /** The last good download, checked again by the list's rules; null when none is usable. */
    suspend fun cachedList(): List<Env>? = prefs.environmentList.first()?.let(Environments::parseList)

    /** Saved in the published file's own shape, so [cachedList] reads it with the same checks. */
    suspend fun cacheList(list: List<Env>) {
        prefs.setEnvironmentList(json.encodeToString(ListFile.serializer(), ListFile(version = 1, environments = list)))
    }

    /** The URLs typed before the picker become the saved environment (a built-in one when the
     *  API URL is its address, else Custom with [defaultPortal] when no portal URL was saved),
     *  once; the old keys are removed. A saved environment is never replaced. */
    suspend fun migrateIfNeeded(defaultPortal: String) {
        prefs.migrateLegacyUrls { api, portal -> Environments.migrate(api, portal, defaultPortal)?.let(::encode) }
    }

    private fun resolve(p: EnvironmentPrefs, default: SavedEnvironment): SavedEnvironment =
        if (p.environment != null) decode(p.environment) ?: default
        else Environments.migrate(p.legacyApiUrl, p.legacyPortalUrl, default.portalUrl) ?: default

    private fun encode(env: SavedEnvironment): String = json.encodeToString(SavedEnvironment.serializer(), env)

    private fun decode(raw: String?): SavedEnvironment? {
        val env = raw?.let { try { json.decodeFromString(SavedEnvironment.serializer(), it) } catch (e: Exception) { null } }
        return when (env) {
            is SavedEnvironment.Named -> env.takeIf { Environments.isValid(Env(it.id, it.name, it.domain)) }
            is SavedEnvironment.Custom -> {
                val api = KioskConfig.normalizeUrl(env.customApiUrl)
                val portal = KioskConfig.normalizeUrl(env.customPortalUrl)
                if (api != null && portal != null) SavedEnvironment.Custom(api, portal) else null
            }
            null -> null
        }
    }

    @Serializable
    private data class ListFile(val version: Int, val environments: List<Env>)
}
