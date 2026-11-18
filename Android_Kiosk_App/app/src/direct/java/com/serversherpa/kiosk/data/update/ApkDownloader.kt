package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.core.update.UpdateOffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException

/** A refusal with the notice to show; the update state machine shows its message as is. */
class UpdateError(message: String) : Exception(message)

/**
 * Fetches the offered APK into [dir]. The link's one-time token is the credential: no
 * Authorization header and no cookies go with it, and it must point at the Devices site itself.
 */
class ApkDownloader(client: OkHttpClient, private val dir: File) {
    private val http = client.newBuilder().cookieJar(CookieJar.NO_COOKIES).build()

    /** Streams offer.installUrl to dir/<build>.apk (via a .part file). Refuses a URL whose scheme/host/port differ from devicesBase. */
    suspend fun download(offer: UpdateOffer, devicesBase: String, onProgress: (Float?) -> Unit): File {
        val base = devicesBase.toHttpUrlOrNull()
        val url = offer.installUrl.toHttpUrlOrNull()
        val host = base?.host ?: devicesBase
        if (base == null || url == null || url.scheme != base.scheme || url.host != base.host || url.port != base.port) {
            throw UpdateError("The download link isn't on $host.")
        }
        val call = http.newCall(Request.Builder().url(url).get().build())
        return coroutineScope {
            // A blocking read can't see coroutine cancellation: cancel the call so the read throws.
            val watcher = launch { try { awaitCancellation() } finally { call.cancel() } }
            try {
                withContext(Dispatchers.IO) { fetch(call, offer, onProgress) }
            } finally {
                watcher.cancel()
            }
        }
    }

    private suspend fun fetch(call: Call, offer: UpdateOffer, onProgress: (Float?) -> Unit): File {
        dir.mkdirs()
        val target = File(dir, "${offer.build}.apk")
        val part = File(dir, "${offer.build}.apk.part")
        var done = false
        try {
            call.execute().use { resp ->
                if (!resp.isSuccessful) throw UpdateError("The download failed (HTTP ${resp.code}).")
                val body = resp.body ?: throw UpdateError("The download was cut short. Try again.")
                val total = offer.size ?: body.contentLength().takeIf { it > 0 }
                if (total == null) onProgress(null) else onProgress(0f)
                var written = 0L
                var lastPercent = 0
                try {
                    body.byteStream().use { input ->
                        part.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                written += n
                                if (total != null) {
                                    val percent = (written * 100 / total).toInt()
                                    if (percent != lastPercent) {
                                        lastPercent = percent
                                        onProgress((written.toFloat() / total).coerceAtMost(1f))
                                    }
                                }
                            }
                        }
                    }
                } catch (e: IOException) {
                    currentCoroutineContext().ensureActive()
                    throw UpdateError("The download was cut short. Try again.")
                }
                if (offer.size != null && written != offer.size) throw UpdateError("The download was cut short. Try again.")
                if (total != null && lastPercent != 100) onProgress(1f)
            }
            if (!part.renameTo(target)) {
                target.delete()
                if (!part.renameTo(target)) throw IOException("Couldn't move ${part.name} into place")
            }
            done = true
            return target
        } finally {
            if (!done) {
                part.delete()
                target.delete()
            }
        }
    }

    /** Deletes everything in dir. */
    fun clear() {
        dir.listFiles()?.forEach { it.deleteRecursively() }
    }
}
