package com.serversherpa.kiosk.nettest

import java.util.Random
import okhttp3.OkHttpClient

/**
 * Where the app's traffic goes while Internet Test is on or off (design 4.5).
 * The controller installs the active profile for each link; null means that
 * link isn't conditioned, and its callers get exactly what they got before.
 */
object InternetTestRoutes {
    /** The Internet link's conditions, or null for the original client. */
    @Volatile internal var internet: LinkProfile? = null

    /** The local network link's conditions, or null for the original sockets. */
    @Volatile internal var local: LinkProfile? = null

    /** How conditioned calls wait. Tests may swap in their own. */
    @Volatile internal var sleeper: Sleeper = ThreadSleeper

    /** Where conditioned calls draw their drops from. Tests may swap in a scripted one. */
    @Volatile internal var random: Random = Random()

    private val lock = Any()

    /** The one cached conditioned client and the original it was built from. Guarded by [lock]. */
    private var portalBase: OkHttpClient? = null
    private var conditioned: ConditionedPortal? = null

    /**
     * The client a portal call should use: [client] itself while the Internet
     * link isn't conditioned, otherwise a conditioned copy of it. The copy is
     * built once per original (by identity) and reused.
     */
    fun portal(client: OkHttpClient): OkHttpClient {
        if (internet == null) return client
        synchronized(lock) {
            val cached = conditioned
            if (cached != null && portalBase === client) return cached.client
            cached?.evict()
            val fresh = ConditionedPortal(
                base = client,
                profile = { internet },
                random = { random },
                sleeper = { ms -> sleeper.sleep(ms) },
            )
            portalBase = client
            conditioned = fresh
            return fresh.client
        }
    }

    /** Closes the conditioned client's idle connections, so none outlive the switch. */
    internal fun evictPortal() {
        synchronized(lock) { conditioned }?.evict()
    }

    internal fun resetForTests() {
        internet = null
        local = null
        sleeper = ThreadSleeper
        random = Random()
        synchronized(lock) {
            conditioned?.evict()
            conditioned = null
            portalBase = null
        }
    }
}
