package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.PrinterIdentity
import com.serversherpa.kiosk.core.labels.identity
import com.serversherpa.kiosk.core.printer.PrinterNeedsRestart
import com.serversherpa.kiosk.data.prefs.PrinterStopsStore
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * What a printer may be left holding after a write went wrong, and what the next call to it does
 * about it. The container owns one, shared like [PrinterLock] by Print Labels ([lockedSender]) and
 * Printer Setup ([LockedZebra]), and every rule runs inside the lock, so nothing reaches the printer
 * between a check and its write. Each mark belongs to the printer it happened on (its
 * [PrinterIdentity]: the network host or the Bluetooth serial, never the address Android gave it,
 * which can change), so a late failure of a printer no longer saved never applies to the one that
 * is, and saving another printer drops none (A→B→A keeps A's marks: Ruling 16).
 *
 * - [State.NEEDS_CLEAR]: a send failed part-way, so the printer may hold the start of a label the
 *   next one would merge into (D16). The next call to it (a send, a font install, or a Printer
 *   Setup query) first sends `~JX` (cancel the partially received format; labels already received
 *   still print, so never `~JA`), then its own bytes. The mark clears once `~JX` is delivered; a
 *   clear that fails is [PrinterClearFailed] (the job itself never went out). Normal calls never
 *   carry it. It lives in memory (D16).
 * - [State.FONT_CUT]: a font install failed after its bytes started going out. `~DY` announces its
 *   byte count, so the printer takes everything after it as font data until that many bytes arrive
 *   (D8): sends and font installs are refused with [PrinterNeedsRestart] until a check finds the
 *   printer answering `~HI` (it was restarted). Queries still go out, with no clear (it would be
 *   font data). The printer keeps waiting through an app relaunch, so these stops are kept in
 *   [PrinterStopsStore] and restored when the guard is made; every rule waits for that restore, so
 *   no send can slip out before it.
 *
 * No check, poll or wait of its own: the only extra bytes it ever sends are that one `~JX`.
 */
class PrinterGuard(
    /** Where the [State.FONT_CUT] stops are kept across launches (null keeps them in memory only). */
    private val stops: PrinterStopsStore? = null,
    /** Where the stops of an earlier launch are read back (the container's scope). */
    scope: CoroutineScope? = null,
) {
    enum class State { CLEAN, NEEDS_CLEAR, FONT_CUT }

    private val marks = HashMap<PrinterIdentity, State>()
    private val saving = Mutex()
    private val restore: Job? = stops?.let { store ->
        (scope ?: CoroutineScope(Dispatchers.Default)).launch {
            val saved = store.load()
            synchronized(marks) { for (identity in saved) marks[identity] = State.FONT_CUT }
        }
    }

    fun state(connection: PrinterConnection): State = synchronized(marks) { marks[connection.identity] ?: State.CLEAN }

    /** The stops of an earlier launch are in place (every rule waits for this by itself). */
    suspend fun awaitRestored() {
        restore?.join()
    }

    /** A send failed part-way: the next call clears first. A cut font stays the stronger state. */
    fun markSendFailed(connection: PrinterConnection) = synchronized(marks) {
        val identity = connection.identity
        if ((marks[identity] ?: State.CLEAN) == State.CLEAN) marks[identity] = State.NEEDS_CLEAR
    }

    /** A font install was cut off: nothing more is sent until the printer answers a check, in this
     *  launch or a later one. */
    suspend fun markFontCut(connection: PrinterConnection) {
        awaitRestored()
        synchronized(marks) { marks[connection.identity] = State.FONT_CUT }
        saveStops()
    }

    /** `~HI` was answered: a printer waiting for the rest of a font couldn't have, so the stop
     *  lifts (for later launches too). A pending clear stays (answering says nothing about a half
     *  label). */
    suspend fun printerAnswered(connection: PrinterConnection) {
        awaitRestored()
        val lifted = synchronized(marks) {
            val identity = connection.identity
            if (marks[identity] == State.FONT_CUT) {
                marks.remove(identity)
                true
            } else {
                false
            }
        }
        if (lifted) saveStops()
    }

    /** Writes the stops as they are now, one write at a time and in order, so the last word is the
     *  latest state. Never cut short by a caller's cancellation. A write that fails is logged, never
     *  thrown: the marks in memory stay right for this launch, and the call that changed them (a
     *  cut install, an answered `~HI`) reports its own outcome. */
    private suspend fun saveStops() {
        val store = stops ?: return
        withContext(NonCancellable) {
            saving.withLock {
                val cut = synchronized(marks) { marks.filterValues { it == State.FONT_CUT }.keys.toSet() }
                try {
                    store.save(cut)
                } catch (e: IOException) {
                    android.util.Log.w(TAG, "couldn't keep the printer stops for the next launch", e)
                }
            }
        }
    }

    /** A query (call it holding the printer lock): [clear] (which sends `~JX`) first when the
     *  printer needs it. Never refused, and a failed query marks nothing. */
    suspend fun <T> asking(connection: PrinterConnection, clear: suspend () -> Unit, ask: suspend () -> T): T {
        clearIfNeeded(connection, refuseWhileCut = false, clear)
        return ask()
    }

    /** A label or test label (call it holding the printer lock): refused while the font is cut,
     *  [clear] first when needed; a send that fails (or is canceled part-way) marks the printer
     *  for a clear. */
    suspend fun sending(connection: PrinterConnection, clear: suspend () -> Unit, send: suspend () -> Unit) {
        clearIfNeeded(connection, refuseWhileCut = true, clear)
        try {
            send()
        } catch (e: Throwable) {
            markSendFailed(connection)
            throw e
        }
    }

    /** A font install (call it holding the printer lock): refused while the font is cut, [clear]
     *  first when needed. [install] gets the progress callback to write through (passing reports on
     *  to [progress]); one that fails after the transport's first report, which comes once its bytes
     *  start going out, cuts the font. One that never started (nothing listening, a refused font
     *  name) leaves the state as it was. */
    suspend fun installing(
        connection: PrinterConnection,
        clear: suspend () -> Unit,
        progress: WriteProgress?,
        install: suspend (progress: WriteProgress) -> Unit,
    ) {
        clearIfNeeded(connection, refuseWhileCut = true, clear)
        val started = AtomicBoolean(false)
        try {
            install { sent, total ->
                started.set(true)
                progress?.invoke(sent, total)
            }
        } catch (e: Throwable) {
            if (started.get()) markFontCut(connection)
            throw e
        }
    }

    /** [clear] when [connection] needs one (its mark lifts once `~JX` is delivered); while its font
     *  is cut, [PrinterNeedsRestart] when [refuseWhileCut], else nothing. */
    private suspend fun clearIfNeeded(connection: PrinterConnection, refuseWhileCut: Boolean, clear: suspend () -> Unit) {
        awaitRestored()
        when (state(connection)) {
            State.CLEAN -> return
            State.FONT_CUT -> if (refuseWhileCut) throw PrinterNeedsRestart()
            State.NEEDS_CLEAR -> {
                try {
                    clear()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    throw PrinterClearFailed((e as? PrinterException)?.host.orEmpty(), e)
                }
                synchronized(marks) {
                    val identity = connection.identity
                    if (marks[identity] == State.NEEDS_CLEAR) marks.remove(identity)
                }
            }
        }
    }
}

private const val TAG = "PrinterGuard"

/** The `~JX` clear before a call failed: the job or query itself never went out, so a label can't
 *  have printed. Its cause is why the clear failed. */
class PrinterClearFailed(host: String, cause: Throwable) :
    PrinterException(host, "Couldn't clear the printer at $host before sending", cause)
