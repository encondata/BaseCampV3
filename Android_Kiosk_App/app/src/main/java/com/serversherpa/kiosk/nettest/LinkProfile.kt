package com.serversherpa.kiosk.nettest

import kotlinx.serialization.Serializable

/**
 * One direction-pair of network conditions, in the units Apple's Network Link
 * Conditioner uses (with speeds in kbps rather than Mbps).
 *
 * A null speed means no limit. Delays are one-way, in milliseconds. Drop is the
 * percent of packets lost, 0 to 100.
 */
@Serializable
data class LinkProfile(
    val downKbps: Int? = null,
    val upKbps: Int? = null,
    val downDelayMs: Int = 0,
    val upDelayMs: Int = 0,
    val downDropPct: Double = 0.0,
    val upDropPct: Double = 0.0,
    val dnsDelayMs: Int = 0,
) {
    /**
     * This profile forced into the range the conditioner can honor, so a bad
     * Custom value never crashes anything. A blank, zero or negative speed means
     * no limit, and a speed is capped at 1,000,000 kbps. Delays (and the DNS
     * delay) are held to 0..60,000 ms, and drops to 0..100 percent.
     */
    fun clamped(): LinkProfile = LinkProfile(
        downKbps = downKbps.clampSpeed(),
        upKbps = upKbps.clampSpeed(),
        downDelayMs = downDelayMs.coerceIn(0, MAX_DELAY_MS),
        upDelayMs = upDelayMs.coerceIn(0, MAX_DELAY_MS),
        downDropPct = downDropPct.clampDrop(),
        upDropPct = upDropPct.clampDrop(),
        dnsDelayMs = dnsDelayMs.coerceIn(0, MAX_DELAY_MS),
    )

    private fun Int?.clampSpeed(): Int? = if (this == null || this <= 0) null else minOf(this, MAX_KBPS)

    private fun Double.clampDrop(): Double = if (isNaN()) 0.0 else coerceIn(0.0, 100.0)

    private companion object {
        const val MAX_KBPS = 1_000_000
        const val MAX_DELAY_MS = 60_000
    }
}

/** What a Custom dial starts out as, before anyone edits it. */
val DEFAULT_CUSTOM = LinkProfile(256, 128, 300, 300, 5.0, 5.0)
