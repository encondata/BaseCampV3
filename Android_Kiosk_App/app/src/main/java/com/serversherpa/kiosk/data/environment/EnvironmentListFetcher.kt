package com.serversherpa.kiosk.data.environment

import com.serversherpa.kiosk.core.environment.Env
import com.serversherpa.kiosk.core.environment.Environments
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** Where the chooser's list came from. */
enum class ListSource { FRESH, SAVED, BUILT_IN }

/**
 * The environment list for the chooser: a fresh download of the published file, else the last
 * good download, else the built-in list. The download sends no cookies or credentials, follows
 * no redirect (a 3xx is a failure), gives up after 5 s and reads at most [Environments.MAX_BODY]
 * bytes. Only the chooser reads the list; it never changes where the kiosk connects.
 */
class EnvironmentListFetcher(
    client: OkHttpClient,
    private val store: EnvironmentStore,
    private val url: String = Environments.STATUS_LIST_URL,
) {
    private val client = client.newBuilder()
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false)
        .followSslRedirects(false)
        .callTimeout(5, TimeUnit.SECONDS)
        .build()

    suspend fun current(): Pair<List<Env>, ListSource> {
        val fresh = download()?.let(Environments::parseList)
        if (fresh != null) {
            // The saved copy is a convenience: a failed write must not cost the chooser its list.
            try { store.cacheList(fresh) } catch (e: CancellationException) { throw e } catch (_: Exception) { }
            return fresh to ListSource.FRESH
        }
        val saved = try { store.cachedList() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
        if (saved != null) return saved to ListSource.SAVED
        return Environments.BUILT_IN to ListSource.BUILT_IN
    }

    /** The body of a 200 answer of at most MAX_BODY bytes, or null. Cancelling the caller
     *  cancels the call. */
    private suspend fun download(): String? = suspendCancellableCoroutine { cont ->
        val call = client.newCall(Request.Builder().url(url).header("Accept", "application/json").build())
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { cont.resume(null) }

            override fun onResponse(call: Call, response: Response) {
                val body = try { response.use(::boundedBody) } catch (e: Throwable) { null }
                cont.resume(body)
            }
        })
    }

    private fun boundedBody(response: Response): String? {
        if (response.code != 200) return null
        val body = response.body ?: return null
        if (body.contentLength() > Environments.MAX_BODY) return null
        val source = body.source()
        if (source.request(Environments.MAX_BODY + 1L)) return null   // more than the limit arrived
        return source.buffer.readUtf8()
    }
}
