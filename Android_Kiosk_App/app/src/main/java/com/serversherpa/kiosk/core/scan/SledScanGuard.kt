package com.serversherpa.kiosk.core.scan

/**
 * Delivers each sled scan once (ruling 3). A sled can type a barcode into the focused box and
 * also send it through its scanner session; whichever route accepts a value first wins, and the
 * other route's copy of the same value within [WINDOW_MS] is refused. The same route twice is
 * never refused (a real double scan), and one accepted copy cancels at most one copy from the
 * other route, so two scans of the same code, each sent both ways, still deliver twice. Values
 * are compared trimmed: a typed copy ending in Enter is the session copy's value.
 *
 * Session copies wait before they are offered ([sessionHoldMs]): [SETTLE_MS] from arrival, then
 * while typing was noted in the last [QUIET_MS], never past [MAX_HOLD_MS] from arrival, so a
 * typed copy still arriving key by key gets there first and the box is not left half full.
 *
 * Time is passed in on every call (callers pass `SystemClock.elapsedRealtime()`). Each refusal is
 * logged with the route that delivered first, the gap and the value's length, never the value; a
 * typed acceptance made while [scannerReady] that ages past [WINDOW_MS] with no session copy is
 * logged as typed only at the next call. Nothing is said on screen. [onTyping] runs on every
 * [noteTyping] (the container counts it as sled activity). Thread-safe.
 *
 * `enabled = false` accepts every value and holds nothing ([ACCEPT_ALL], what a screen gets when
 * nothing provides the container's guard).
 */
class SledScanGuard(
    private val enabled: Boolean = true,
    private val log: (String) -> Unit = {},
    private val onTyping: () -> Unit = {},
) {
    private enum class Route(val word: String) { TYPED("typed"), SESSION("session") }

    private class Accepted(val value: String, val atMs: Long, val whileReady: Boolean)

    private val typed = ArrayDeque<Accepted>()
    private val session = ArrayDeque<Accepted>()
    private var lastTypingMs: Long? = null

    /** The sled's scanner session is up (`SledScannerState.Ready`): a typed scan should have a
     *  session copy too. */
    @Volatile var scannerReady: Boolean = false

    /** A key was typed into a scan box (or Time Clock Welcome's raw-key handler). */
    fun noteTyping(nowMs: Long) {
        synchronized(this) {
            expire(nowMs)
            lastTypingMs = nowMs
        }
        onTyping()
    }

    /** A typed scan is being submitted: false when the session already delivered it. */
    @Synchronized
    fun acceptTyped(value: String, nowMs: Long): Boolean = accept(Route.TYPED, value, nowMs)

    /** A scanner-session barcode, after its hold: false when typing already delivered it. */
    @Synchronized
    fun acceptSession(value: String, nowMs: Long): Boolean = accept(Route.SESSION, value, nowMs)

    /** How much longer a session copy that arrived at [arrivedMs] waits; 0 = offer it now. */
    @Synchronized
    fun sessionHoldMs(arrivedMs: Long, nowMs: Long): Long {
        if (!enabled) return 0
        expire(nowMs)
        val elapsed = nowMs - arrivedMs
        val left = MAX_HOLD_MS - elapsed
        if (left <= 0) return 0
        val settle = SETTLE_MS - elapsed
        val quiet = lastTypingMs?.let { QUIET_MS - (nowMs - it) } ?: 0
        val hold = maxOf(settle, quiet, 0)
        return minOf(hold, left)
    }

    private fun accept(route: Route, raw: String, nowMs: Long): Boolean {
        if (!enabled) return true
        expire(nowMs)
        val value = raw.trim()
        val other = if (route == Route.TYPED) session else typed
        val match = other.firstOrNull { it.value == value && nowMs - it.atMs < WINDOW_MS }
        if (match != null) {
            other.remove(match)
            val first = if (route == Route.TYPED) Route.SESSION else Route.TYPED
            log("Refused the ${route.word} copy of a sled scan: ${first.word} first, ${nowMs - match.atMs} ms apart, ${value.length} characters.")
            return false
        }
        val mine = if (route == Route.TYPED) typed else session
        mine.addLast(Accepted(value, nowMs, whileReady = route == Route.TYPED && scannerReady))
        return true
    }

    /** Drops acceptances older than the window, logging a typed one that never got its session copy. */
    private fun expire(nowMs: Long) {
        while (true) {
            val head = typed.firstOrNull() ?: break
            if (nowMs - head.atMs < WINDOW_MS) break
            typed.removeFirst()
            if (head.whileReady) log("A sled scan arrived typed only (${head.value.length} characters): no scanner copy within $WINDOW_MS ms.")
        }
        while (true) {
            val head = session.firstOrNull() ?: break
            if (nowMs - head.atMs < WINDOW_MS) break
            session.removeFirst()
        }
    }

    companion object {
        const val WINDOW_MS = 2_000L
        const val SETTLE_MS = 120L
        const val QUIET_MS = 150L
        const val MAX_HOLD_MS = 1_500L

        /** Accepts everything, holds nothing. */
        val ACCEPT_ALL: SledScanGuard = SledScanGuard(enabled = false)
    }
}
