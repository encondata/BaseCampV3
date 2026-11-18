package com.serversherpa.kiosk.core.update

import com.serversherpa.kiosk.core.ApiError
import kotlinx.serialization.Serializable
import java.net.URI

/** The Devices site's `GET /api/updates` answer, field for field (`build` is a string there). */
@Serializable
data class UpdateAnswerWire(
    val status: String,
    val version_name: String? = null,
    val build: String? = null,
    val notes: String? = null,
    val size: Long? = null,
    val install_url: String? = null,
    val message: String? = null,
)

sealed interface UpdateAnswer {
    data object UpToDate : UpdateAnswer
    data class Available(val offer: UpdateOffer) : UpdateAnswer
    /** Nothing to install; [message] is what Settings says why. */
    data class Blocked(val message: String) : UpdateAnswer
}

const val NO_DEVICES_HOST = "This kiosk's API address has no Devices site next to it, so it can't check for updates."
const val BAD_ANSWER = "The Devices site sent an update this app can't read."
const val RECHECK_INTERVAL_MS = 3_600_000L

fun UpdateAnswerWire.toAnswer(): UpdateAnswer = when (status) {
    "up_to_date" -> UpdateAnswer.UpToDate
    "available" -> {
        val buildNumber = build?.toLongOrNull()
        val url = install_url?.takeIf { it.isNotBlank() }
        if (buildNumber == null || url == null) {
            UpdateAnswer.Blocked(BAD_ANSWER)
        } else {
            UpdateAnswer.Available(
                UpdateOffer(version_name?.takeIf { it.isNotBlank() } ?: build!!, buildNumber, notes, size, url),
            )
        }
    }
    else -> UpdateAnswer.Blocked(message?.takeIf { it.isNotBlank() } ?: BAD_ANSWER)
}

/** The Devices origin beside an API URL: same scheme and port, host `api.` -> `devices.`; null otherwise. */
fun devicesUrlFor(apiUrl: String): String? {
    val uri = try { URI(apiUrl.trim()) } catch (_: Exception) { return null }
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    val host = uri.host?.lowercase() ?: return null
    if (!host.startsWith("api.") || host.length == "api.".length) return null
    val port = if (uri.port >= 0) ":${uri.port}" else ""
    return "$scheme://devices.${host.removePrefix("api.")}$port"
}

fun shouldRecheck(lastCheckMillis: Long?, nowMillis: Long, intervalMillis: Long = RECHECK_INTERVAL_MS): Boolean =
    lastCheckMillis == null || nowMillis - lastCheckMillis >= intervalMillis

/** The Settings line for a failed check. */
fun checkFailureMessage(e: ApiError, devicesHost: String): String =
    if (e.isNetwork) "Couldn't reach $devicesHost. Try again later."
    else "The Devices site answered ${e.status}. Try again later."
