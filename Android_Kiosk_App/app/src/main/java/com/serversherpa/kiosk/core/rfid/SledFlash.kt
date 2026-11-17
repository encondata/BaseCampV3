package com.serversherpa.kiosk.core.rfid

/**
 * The two full-screen sled messages (task H7, Jimmy 2026-11-17): red [DROPPED]
 * ("Sled disconnected") and green [READY] ("Ready to scan").
 */
enum class SledFlash { DROPPED, READY }

/** How long a sled flash holds before it fades. */
const val SLED_FLASH_HOLD_MS = 1_500

/** How long a sled flash takes to fade out after its hold. */
const val SLED_FLASH_FADE_MS = 300

/**
 * Whether the sled is usable now: `Connected`, and the layout in force either
 * needs no scanner ([usesScanner] false) or the sled's scanner is `Ready`, so
 * it never says ready while scans cannot arrive. `NeedsRegion` reads nothing.
 */
fun sledReady(connection: RfidConnection, usesScanner: Boolean, scanner: SledScannerState): Boolean =
    connection is RfidConnection.Connected && (!usesScanner || scanner == SledScannerState.Ready)

/**
 * Decides the sled flashes from snapshots of the connection, the info
 * generation (null while `info` is null) and [sledReady]:
 *
 * - [SledFlash.DROPPED] when the link goes from `Connected` or `NeedsRegion`
 *   to a retryable `Failed` with `info` still set: the link dropped by itself.
 *   Everything the operator chose (Disconnect, Stop, the reader switch, the
 *   app going to the background) ends `Disconnected`, and a connect that
 *   never came up was never up, so neither flashes.
 * - [SledFlash.READY] the first time ready holds for a generation: once per
 *   connection, so a layout change or a battery update on the same link does
 *   not flash again, and a scanner that comes up on Try again does.
 *
 * While [next]'s `enabled` is false nothing is returned, but the state still
 * moves, so a ready already passed is never shown late. Not thread-safe: one
 * collector feeds it.
 */
class SledFlashDecider {
    private var wasUp = false
    private var readyGeneration: Int? = null

    fun next(connection: RfidConnection, generation: Int?, ready: Boolean, enabled: Boolean): SledFlash? {
        val dropped = wasUp && generation != null && connection is RfidConnection.Failed && connection.retryable
        wasUp = connection is RfidConnection.Connected || connection is RfidConnection.NeedsRegion
        val firstReady = ready && generation != null && generation != readyGeneration
        if (firstReady) readyGeneration = generation
        return when {
            !enabled -> null
            dropped -> SledFlash.DROPPED
            firstReady -> SledFlash.READY
            else -> null
        }
    }
}
