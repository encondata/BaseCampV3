package com.serversherpa.kiosk.core.labels

import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.PrinterNeedsRestart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

const val NO_PRINTER_TEXT = "No printer set up. Open Printer Setup."
const val NO_MATCH_TEXT = "No asset matches that scan."
const val DEVICE_UNSUPPORTED_TEXT = "This device can't make labels (its system WebView is too old)."
const val SYNC_NEEDED_TEXT = "Sync this kiosk to make labels."
/** The template is a newer design than this app's generator prints (the laptop's NEEDS_UPDATE_TEXT). */
const val NEEDS_UPDATE_TEXT = "This device needs an app update to print this template."
const val LABEL_READ_FAILED_TEXT = "Couldn't read this asset's label on the kiosk."
const val PREPARE_FAILED_TEXT = "Couldn't get this label ready for the printer. Try again."
const val RECORD_FAILED_TEXT = "Printed, but the scan wasn't recorded: this kiosk couldn't save it."

/** While a sync runs, stored labels may be for the data it replaces. */
const val SYNCING_TEXT = "This kiosk is syncing. Labels will be ready shortly."
/** The build's plan step, before it has counted the labels to make. */
const val PREPARING_TEXT = "Labels are being prepared."

fun stillBeingMadeText(done: Int, total: Int) =
    if (total == 0) PREPARING_TEXT else "Labels are still being made ($done of $total)."
/** "Can't reach the printer at 10.0.0.5." / "Can't reach the printer D8J224508535 over Bluetooth." */
fun printerUnreachableText(p: SavedPrinter): String = when (val c = p.connection) {
    is PrinterConnection.Network -> "Can't reach the printer at ${c.host}."
    is PrinterConnection.Bluetooth -> "Can't reach the printer ${c.serial} over Bluetooth."
}
/** The printer took the connection but not the whole job in time: the label may be out. */
const val PRINTER_TIMEOUT_TEXT = "The printer didn't finish answering. It may have printed the label — check before you retry."

/** [PrintQueueDeps.send] throws this when the printer took the connection but not the whole job in time. */
class LabelSendTimeout(cause: Throwable? = null) : Exception("the printer didn't take the whole label in time", cause)

/** [PrintQueueDeps.send] throws this when the label didn't go out for a reason the crew fixes on the
 *  device, not at the printer (Bluetooth off or not allowed, a printer that forgot this device):
 *  its [message] says what to do. */
class LabelSendRefused(override val message: String, cause: Throwable? = null) : Exception(message, cause)

/** What a scan says for each outcome a label can store (kiosk/src/lib/printQueue.ts LABEL_REASONS). */
private val LABEL_REASONS = mapOf(
    NO_TEMPLATE_AT_DPI to "No label for this asset: this move has no active label template at this printer's DPI. " +
        "Someone with label access needs to activate one on Labels › Templates.",
    TEMPLATE_FAILED to "No label for this asset: the label template couldn't be built",
    TEMPLATE_UNSUPPORTED to NEEDS_UPDATE_TEXT,
)

fun noLabelText(outcome: String?): String = LABEL_REASONS[outcome] ?: "No label for this asset: none was generated for it"

/** An asset's stored label (`generated_labels`). */
data class StoredLabel(val zpl: String?, val outcome: String, val templateId: String?)

/** One step of a print job: the ZPL so far, or why the job stops here. */
sealed interface PrintStep {
    data class Ready(val zpl: String) : PrintStep
    data class Refused(val message: String) : PrintStep
}

/**
 * What a scan prints, from the asset's stored label and the label build. While a build runs no
 * label prints, as on the laptop (its edge answers `labels_regenerating`): any stored label may
 * be the one being replaced. Nor while the kiosk [syncing]: the build that follows the sync
 * hasn't started yet, so a stored label may be for the data the sync replaces.
 */
fun labelFor(stored: StoredLabel?, status: LabelBuildStatus, syncing: Boolean = false): PrintStep {
    if (status.phase == LabelBuildPhase.UNSUPPORTED_DEVICE) return PrintStep.Refused(DEVICE_UNSUPPORTED_TEXT)
    if (syncing) return PrintStep.Refused(SYNCING_TEXT)
    if (status.phase == LabelBuildPhase.RUNNING) return PrintStep.Refused(stillBeingMadeText(status.done, status.total))
    if (stored == null) {
        return PrintStep.Refused(if (status.needs == LabelBuildNeed.SYNC) SYNC_NEEDED_TEXT else noLabelText(null))
    }
    if (stored.outcome == OUTCOME_OK && stored.zpl != null) return PrintStep.Ready(stored.zpl)
    return PrintStep.Refused(noLabelText(stored.outcome.takeIf { it != OUTCOME_OK }))
}

enum class PrintState { QUEUED, SENDING, PRINTED, FAILED }

/**
 * One scan (or a Reprint of one) on the Print Labels list. [asset] is null when the scan matched
 * nothing. [recorded] is true once its Labeled scan is in the outbox; [recordWarning] says why
 * a printed label's scan couldn't be.
 */
data class PrintEntry<A>(
    val id: String,
    val asset: A?,
    val scannedValue: String,
    val scannedAt: String,
    val reprint: Boolean,
    val state: PrintState,
    val message: String? = null,
    val recordWarning: String? = null,
    val recorded: Boolean = false,
)

/** What the queue needs from the device: settings, labels, the send-time helpers, the printer, the outbox. */
interface PrintQueueDeps<A> {
    suspend fun settings(): LabelSettings
    /** The asset's stored label, or why it has none (see [labelFor]). */
    suspend fun label(asset: A): PrintStep
    /** The label with the saved offsets and peel or tear mode applied. */
    suspend fun prepare(zpl: String, settings: LabelSettings): PrintStep
    /** Sends [zpl] to the saved [printer], the way its connection reaches it; throws when it can't
     *  ([LabelSendTimeout] when the job may have gone out, [PrinterNeedsRestart] while a cut font
     *  install keeps sends from the printer, [LabelSendRefused] when the crew must fix something on
     *  the device first). Anything else, a failed clear before the label included, means the label
     *  never went out: unreachable. */
    suspend fun send(printer: SavedPrinter, zpl: String)
    /** Queues the Labeled scan; throws when it can't be saved. */
    suspend fun record(asset: A, scannedValue: String)
}

/**
 * The Print Labels queue, as the laptop's Printing Station runs it (kiosk/src/lib/printQueue.ts):
 * jobs run one at a time in arrival order. One job: the asset's stored label → the saved offsets
 * and print mode applied → sent straight to the printer (no status checks before or after) → one
 * Labeled scan, once per scan, on its first label that goes out (its first attempt or a Retry).
 * A Reprint never records. Retry resends the very bytes the failed attempt built, or builds them
 * when it never got that far. A failed record doesn't undo the print: the entry stays printed
 * with a warning.
 */
class PrintQueue<A>(
    private val deps: PrintQueueDeps<A>,
    private val now: () -> String,
    private val limit: Int = LIST_LIMIT,
    /** Why a step failed, for the device log (the entry shows the person's message). */
    private val log: (String, Throwable) -> Unit = { _, _ -> },
) {
    private val _entries = MutableStateFlow<List<PrintEntry<A>>>(emptyList())
    /** Newest first. */
    val entries: StateFlow<List<PrintEntry<A>>> = _entries

    /** Per entry: the finished ZPL its last attempt built, whether its scan was tried (it never is
     *  twice), and whether that worked. */
    private class Work<A>(var entry: PrintEntry<A>, var sent: String? = null, var recordTried: Boolean = false, var recorded: Boolean = false)

    private val work = LinkedHashMap<String, Work<A>>()
    private val lock = Any()
    // Fair: jobs run in the order they asked.
    private val turn = Mutex()
    private var nextId = 0

    /** A scan: its entry shows at once; the result once it has printed or failed. */
    suspend fun scan(asset: A?, scannedValue: String): PrintEntry<A> {
        if (asset == null) return add(null, scannedValue, false, PrintState.FAILED, NO_MATCH_TEXT).entry
        val w = add(asset, scannedValue, false, PrintState.QUEUED, null)
        return turn.withLock { execute(w) }
    }

    /** Prints the entry's asset again as a new entry that never records; null when there's nothing to print. */
    suspend fun reprint(entryId: String): PrintEntry<A>? {
        val source = synchronized(lock) { work[entryId]?.entry } ?: return null
        val asset = source.asset ?: return null
        val w = add(asset, source.scannedValue, true, PrintState.QUEUED, null)
        return turn.withLock { execute(w) }
    }

    /** Runs a failed entry again; null unless it failed and has an asset. */
    suspend fun retry(entryId: String): PrintEntry<A>? {
        val w = synchronized(lock) {
            val w = work[entryId] ?: return null
            if (w.entry.state != PrintState.FAILED || w.entry.asset == null) return null
            update(w, PrintState.QUEUED, null)
            w
        }
        return turn.withLock { execute(w) }
    }

    private fun add(asset: A?, scannedValue: String, reprint: Boolean, state: PrintState, message: String?): Work<A> =
        synchronized(lock) {
            nextId += 1
            val w = Work(PrintEntry("p-$nextId", asset, scannedValue, now(), reprint, state, message))
            work[w.entry.id] = w
            // Oldest out first (the map keeps insertion order).
            while (work.size > limit) work.remove(work.keys.first())
            publish()
            w
        }

    private fun publish() {
        _entries.value = work.values.map { it.entry }.asReversed().toList()
    }

    private fun update(w: Work<A>, state: PrintState, message: String?, recordWarning: String? = w.entry.recordWarning): PrintEntry<A> =
        synchronized(lock) {
            w.entry = w.entry.copy(state = state, message = message, recordWarning = recordWarning, recorded = w.recorded)
            if (work[w.entry.id] === w) publish()
            w.entry
        }

    private fun fail(w: Work<A>, message: String) = update(w, PrintState.FAILED, message)

    private suspend fun execute(w: Work<A>): PrintEntry<A> {
        val asset = w.entry.asset ?: return fail(w, NO_MATCH_TEXT)
        update(w, PrintState.SENDING, null)
        val printer: SavedPrinter
        val bytes: String
        try {
            val settings = deps.settings()
            printer = settings.printer ?: return fail(w, NO_PRINTER_TEXT)
            bytes = w.sent ?: run {
                val zpl = when (val s = deps.label(asset)) {
                    is PrintStep.Ready -> s.zpl
                    is PrintStep.Refused -> return fail(w, s.message)
                }
                when (val p = deps.prepare(zpl, settings)) {
                    is PrintStep.Ready -> p.zpl
                    is PrintStep.Refused -> return fail(w, p.message)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("couldn't read the label or the settings", e)
            return fail(w, LABEL_READ_FAILED_TEXT)
        }
        w.sent = bytes
        // Once the label starts going out, the send, its record and the entry's outcome finish even
        // if the screen closes: a cancelled send would close the socket mid-label, and a label that
        // did print must get its scan. This includes the wait for the printer lock, bounded only by
        // the lock holder's own time limit, then the send's own deadline.
        return withContext(NonCancellable) {
            try {
                deps.send(printer, bytes)
            } catch (e: Exception) {
                val to = when (val c = printer.connection) {
                    is PrinterConnection.Network -> "the printer at ${c.host}"
                    is PrinterConnection.Bluetooth -> "the Bluetooth printer ${c.serial}"
                }
                log("couldn't send the label to $to", e)
                val message = when (e) {
                    is LabelSendTimeout -> PRINTER_TIMEOUT_TEXT
                    is LabelSendRefused -> e.message
                    is PrinterNeedsRestart -> FONT_INSTALL_CUT_TEXT
                    else -> printerUnreachableText(printer)
                }
                return@withContext fail(w, message)
            }
            // A scan records once, on its first label that goes out; a Reprint never does.
            var warning: String? = null
            if (!w.entry.reprint && !w.recordTried) {
                w.recordTried = true
                try {
                    deps.record(asset, w.entry.scannedValue)
                    w.recorded = true
                } catch (e: Exception) {
                    log("couldn't record the Labeled scan", e)
                    warning = RECORD_FAILED_TEXT
                }
            }
            update(w, PrintState.PRINTED, null, recordWarning = warning ?: w.entry.recordWarning)
        }
    }

    companion object {
        /** Entries the list keeps (newest); older ones drop off. */
        const val LIST_LIMIT = 200
    }
}
