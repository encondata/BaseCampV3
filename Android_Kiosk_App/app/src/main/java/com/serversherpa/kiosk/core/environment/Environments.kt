package com.serversherpa.kiosk.core.environment

import java.net.URI
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

const val ROOT_DOMAIN = "serversherpa.com"
const val CUSTOM_LABEL = "Custom"

/** One named environment of the published list: its addresses follow from [domain]. */
@Serializable
data class Env(val id: String, val name: String, val domain: String) {
    val apiUrl: String get() = "https://api.$domain"
    val portalUrl: String get() = "https://portal.$domain"
}

/** What the kiosk saved: a named environment (always connected to by its saved domain, whatever
 *  a later list says) or a typed Custom pair. Saved as `{"kind":"named","id","name","domain"}`
 *  or `{"kind":"custom","api_url","portal_url"}`. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface SavedEnvironment {
    @Serializable @SerialName("named")
    data class Named(val id: String, val name: String, val domain: String) : SavedEnvironment

    @Serializable @SerialName("custom")
    data class Custom(
        @SerialName("api_url") val customApiUrl: String,
        @SerialName("portal_url") val customPortalUrl: String,
    ) : SavedEnvironment
}

val SavedEnvironment.apiUrl: String get() = when (this) {
    is SavedEnvironment.Named -> "https://api.$domain"
    is SavedEnvironment.Custom -> customApiUrl
}

val SavedEnvironment.portalUrl: String get() = when (this) {
    is SavedEnvironment.Named -> "https://portal.$domain"
    is SavedEnvironment.Custom -> customPortalUrl
}

val SavedEnvironment.isProd: Boolean get() = this is SavedEnvironment.Named && domain == ROOT_DOMAIN

val SavedEnvironment.label: String get() = when (this) {
    is SavedEnvironment.Named -> name
    is SavedEnvironment.Custom -> CUSTOM_LABEL
}

/** The environments a kiosk can pick: the built-in list, the rules for the published list at
 *  status.serversherpa.com, and the migration of URLs typed before the picker existed. Mirrors
 *  the laptop edge's `environments.py`. */
object Environments {
    const val STATUS_LIST_URL = "https://status.serversherpa.com/environments.json"
    const val PASSWORD = "cumulus"
    const val MAX_BODY = 64 * 1024

    private val ID = Regex("^[a-z][a-z0-9-]{1,31}$")
    private val DOMAIN = Regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*serversherpa\\.com$")

    val BUILT_IN: List<Env> = listOf(
        Env("prod", "Prod", ROOT_DOMAIN),
        Env("rc1", "RC1", "rc1.$ROOT_DOMAIN"),
        Env("uat", "UAT", "uat.$ROOT_DOMAIN"),
        Env("beta", "Beta", "beta.$ROOT_DOMAIN"),
        Env("alpha", "Alpha", "alpha.$ROOT_DOMAIN"),
        Env("dev", "Dev", "dev.$ROOT_DOMAIN"),
    )

    fun byId(id: String): Env? = BUILT_IN.firstOrNull { it.id == id }

    /** The valid entries of a downloaded list in file order, or null when the file is unusable
     *  (too big, not JSON, wrong version, no valid entry). */
    fun parseList(body: String): List<Env>? {
        if (body.toByteArray(Charsets.UTF_8).size > MAX_BODY) return null
        val doc = try { Json.parseToJsonElement(body) } catch (e: Exception) { return null }
        if (doc !is JsonObject) return null
        val version = doc["version"] as? JsonPrimitive
        if (version == null || version.isString || version.content != "1") return null
        val entries = doc["environments"] as? JsonArray ?: return null
        val seen = HashSet<String>()
        val out = ArrayList<Env>()
        for (item in entries) {
            val env = toEnv(item) ?: continue
            if (!seen.add(env.id)) continue
            out += env
        }
        return out.ifEmpty { null }
    }

    private fun toEnv(item: Any?): Env? {
        val obj = item as? JsonObject ?: return null
        fun str(key: String): String? = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val id = str("id") ?: return null
        val name = str("name") ?: return null
        val domain = str("domain") ?: return null
        if (!ID.matches(id) || id.endsWith("-")) return null
        if (name.isBlank() || !DOMAIN.matches(domain)) return null
        return Env(id, name.trim(), domain)
    }

    /** The kiosk's saved typed URLs as an environment: a built-in one when the API URL is exactly
     *  its `https://api.<domain>` (scheme and host in any case, default port and a trailing slash
     *  ignored), else Custom. [defaultPortal] stands in when no portal URL was saved. Null when
     *  nothing usable was saved, so nothing is migrated. */
    fun migrate(savedApi: String?, savedPortal: String?, defaultPortal: String): SavedEnvironment? {
        val api = cleanUrl(savedApi) ?: return null
        val portal = cleanUrl(savedPortal) ?: defaultPortal
        val origin = originOf(api)
        if (origin != null && api.substringAfter("://").none { it == '/' }) {
            for (env in BUILT_IN) {
                if (origin == originOf(env.apiUrl)) return SavedEnvironment.Named(env.id, env.name, env.domain)
            }
        }
        return SavedEnvironment.Custom(api, portal)
    }

    /** Trimmed, trailing `/` removed, http(s) with a host; null otherwise. */
    private fun cleanUrl(raw: String?): String? {
        val v = raw?.trim()?.trimEnd('/') ?: return null
        if (v.isEmpty()) return null
        val uri = try { URI(v) } catch (e: Exception) { return null }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrEmpty()) return null
        return v
    }

    private fun originOf(url: String): String? {
        val uri = try { URI(url) } catch (e: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val port = when {
            uri.port != -1 -> uri.port
            scheme == "https" -> 443
            scheme == "http" -> 80
            else -> return null
        }
        return "$scheme://$host:$port"
    }
}
