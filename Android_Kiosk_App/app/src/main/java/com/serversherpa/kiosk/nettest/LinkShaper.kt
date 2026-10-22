package com.serversherpa.kiosk.nettest

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** What one packet carries: drops, and the speed cost, apply per chunk of this many bytes. */
const val SEGMENT_BYTES = 1460

/** The first retransmission timeout, and what a second consecutive drop of a chunk costs. */
const val RTO_START_MS = 1_000L

/** A retransmission timeout never grows past this, however many drops in a row. */
const val RTO_MAX_MS = 60_000L

/** The least a first drop costs, however small the round trip (a fast retransmit's floor). */
const val FAST_RETRANSMIT_MIN_MS = 200L

/** A blocking sleep. Split out so tests (and interruptible sockets) can supply their own. */
fun interface Sleeper {
    fun sleep(ms: Long)
}

/** The real thing: parks the calling thread. */
object ThreadSleeper : Sleeper {
    override fun sleep(ms: Long) = Thread.sleep(ms)
}

/**
 * The link conditioner's engine. It turns a [LinkProfile] into blocking waits,
 * so the Internet path and the printer-socket path feel the same condition the
 * same way: a delay per burst, a speed limit per byte, and packet loss that
 * shows up as TCP-like stalls rather than instant errors (design 4.4).
 *
 * Build one per connection (it is cheap and keeps no shared state). A single
 * instance serves one connection at a time. The [random] may be shared between
 * many shapers, because `java.util.Random` is thread-safe. Every drop decision
 * is drawn through `random.nextDouble()` (compared against the drop rate), so
 * a test can script the outcome by overriding just that method.
 *
 * A zero or negative `timeoutMs` leaves no time to wait out a drop: the first
 * drop fails the call at once.
 */
class LinkShaper(
    val profile: LinkProfile,
    private val random: java.util.Random,
    private val sleeper: Sleeper,
) {
    /** One request turn (upload delay plus download delay), in milliseconds. */
    fun roundTripMs(): Long = profile.upDelayMs.toLong() + profile.downDelayMs.toLong()

    /**
     * Opens a connection: one round trip, then the handshake. Each handshake
     * attempt is lost when either direction drops it. A lost attempt is retried
     * after 1 s, 2 s, 4 s and so on, like SYN retries. Returns false, having
     * slept out [timeoutMs] in all, when the handshake can't finish in time.
     */
    fun connect(timeoutMs: Long): Boolean {
        var elapsed = roundTripMs()
        if (elapsed > timeoutMs) {
            nap(timeoutMs)
            return false
        }
        nap(elapsed)

        val lossChance = 1.0 - (1.0 - profile.upDropPct.toProbability()) * (1.0 - profile.downDropPct.toProbability())
        var lost = 0
        while (lossChance > 0.0 && random.nextDouble() < lossChance) {
            lost++
            val wait = retransmitWaitMs(lost)
            if (elapsed + wait > timeoutMs) {
                nap(timeoutMs - elapsed)
                return false
            }
            nap(wait)
            elapsed += wait
        }
        return true
    }

    /** A write burst starts: the upload delay. */
    fun sendBurst() = nap(profile.upDelayMs.toLong())

    /** A read burst starts: the download delay. */
    fun receiveBurst() = nap(profile.downDelayMs.toLong())

    /**
     * Pushes [bytes] up the link at the upload speed, through the upload drops.
     * False when drop stalls on one chunk would pass [timeoutMs] (having slept
     * out to [timeoutMs]); the bytes then never made it.
     */
    fun paceUp(bytes: Int, timeoutMs: Long): Boolean =
        pace(bytes, profile.upKbps, profile.upDropPct, timeoutMs)

    /** The same as [paceUp], for bytes coming down the link. */
    fun paceDown(bytes: Int, timeoutMs: Long): Boolean =
        pace(bytes, profile.downKbps, profile.downDropPct, timeoutMs)

    /**
     * Sends [bytes] one chunk at a time. Each chunk first gets through the drops
     * (stalls are slept as they happen), then pays its speed cost. Costs under
     * [FLUSH_MS] pile up and are slept once they reach it, and what is left over
     * is slept before returning, so the sleeps in one call total the call's cost.
     */
    private fun pace(bytes: Int, kbps: Int?, dropPct: Double, timeoutMs: Long): Boolean {
        val rate = kbps?.takeIf { it > 0 }
        val dropChance = dropPct.toProbability()
        if (rate == null && dropChance <= 0.0) return true

        var pendingMs = 0.0
        var remaining = bytes
        var delivered = true
        while (remaining > 0) {
            val chunk = min(remaining, SEGMENT_BYTES)
            remaining -= chunk
            if (!getThroughDrops(dropChance, timeoutMs)) {
                delivered = false
                break
            }
            if (rate != null) {
                pendingMs += chunk * 8.0 / rate
                if (pendingMs >= FLUSH_MS) {
                    val whole = floor(pendingMs)
                    nap(whole.toLong())
                    pendingMs -= whole
                }
            }
        }
        nap(Math.round(pendingMs))
        return delivered
    }

    /**
     * Tries one chunk until it gets through. The first drop costs a fast
     * retransmit (the round trip, at least [FAST_RETRANSMIT_MIN_MS]); each
     * further drop in a row waits the retransmission timeout, which doubles.
     * False, having slept out to [timeoutMs], when the stalls would pass it.
     */
    private fun getThroughDrops(dropChance: Double, timeoutMs: Long): Boolean {
        var stalled = 0L
        var drops = 0
        while (dropChance > 0.0 && random.nextDouble() < dropChance) {
            drops++
            val stall = if (drops == 1) max(FAST_RETRANSMIT_MIN_MS, roundTripMs()) else retransmitWaitMs(drops - 1)
            if (stalled + stall > timeoutMs) {
                nap(timeoutMs - stalled)
                return false
            }
            nap(stall)
            stalled += stall
        }
        return true
    }

    /** The [n]th retransmission timeout in a row (1 for the first): 1 s, 2 s, 4 s, up to [RTO_MAX_MS]. */
    private fun retransmitWaitMs(n: Int): Long = min(RTO_MAX_MS, RTO_START_MS shl min(n - 1, MAX_DOUBLINGS))

    /** Sleeps, never for a non-positive time (which would throw, or do nothing). */
    private fun nap(ms: Long) {
        if (ms > 0) sleeper.sleep(ms)
    }

    /** A percent (0 to 100) as a chance (0.0 to 1.0); anything unreadable counts as no loss. */
    private fun Double.toProbability(): Double = if (isNaN()) 0.0 else (this / 100.0).coerceIn(0.0, 1.0)

    private companion object {
        /** Speed costs smaller than this are held back and slept together. */
        const val FLUSH_MS = 10.0

        /** Past this many doublings the timeout is long since capped (and a shift can't overflow). */
        const val MAX_DOUBLINGS = 16
    }
}
