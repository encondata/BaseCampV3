package com.serversherpa.kiosk.data.outbox

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanIn
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxCounts
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.identity.Identity
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

data class OutboxSnapshot(val rows: List<OutboxRow>, val counts: OutboxCounts)

/**
 * kiosk/src/lib/outbox.ts — durable queue + sender. The decisions live in
 * OutboxMachine; this class owns persistence, the in-memory mirror, the
 * batching window, the retry wake-ups, and the nomatch sweep.
 */
class Outbox(
    private val store: OutboxStore,
    private val api: KioskApi,
    private val identity: Identity,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val idGen: () -> String = { UUID.randomUUID().toString() },
) {
    private val empty = OutboxSnapshot(emptyList(), OutboxCounts(0, 0, 0, 0, 0))
    private val _snapshot = MutableStateFlow(empty)
    val snapshot: StateFlow<OutboxSnapshot> = _snapshot

    private val mutex = Mutex()
    private var all: MutableMap<String, OutboxRow> = LinkedHashMap()
    private var nextSeq = 1L
    private var loaded = false

    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var senderJob: Job? = null
    private var sweepJob: Job? = null
    private var pendingFlush: Job? = null

    private fun rebuild() {
        val rows = all.values.sortedByDescending { it.seq }
        _snapshot.value = OutboxSnapshot(rows.take(OutboxMachine.LIST_CAP), OutboxMachine.counts(rows))
    }

    /** Persists and mirrors `rows`. Caller holds the mutex. */
    private suspend fun save(rows: List<OutboxRow>) {
        store.upsert(rows)
        rows.forEach { all[it.clientScanId] = it }
        rebuild()
    }

    suspend fun load() = mutex.withLock {
        if (loaded) return@withLock
        val rows = try {
            store.all()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Leave `loaded` false so the next start() reads the store again.
            android.util.Log.w("Outbox", "Couldn't read the outbox from storage", e)
            return@withLock
        }
        all = LinkedHashMap(rows.associateBy { it.clientScanId })
        nextSeq = (rows.maxOfOrNull { it.seq } ?: 0L) + 1
        rebuild()
        loaded = true
    }

    /**
     * Rows left `sending` by a sender that died mid-POST (the app was backgrounded)
     * go back to queued. Runs on EVERY start(), not just the first load, because the
     * process survives a stop()/start() cycle with those rows still in memory.
     */
    private suspend fun recoverStranded() = mutex.withLock {
        val stranded = OutboxMachine.recoverStranded(all.values.toList())
        if (stranded.isEmpty()) return@withLock
        try {
            save(stranded)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Storage failed: still mirror them so this pass resends them anyway.
            android.util.Log.w("Outbox", "Couldn't persist recovered rows", e)
            stranded.forEach { all[it.clientScanId] = it }
            rebuild()
        }
    }

    fun start() {
        if (senderJob?.isActive == true) return
        senderJob = scope.launch {
            load()
            recoverStranded()
            sweep()
            while (isActive) {
                try {
                    flushOnce()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Storage hiccup: the next pass retries.
                    android.util.Log.w("Outbox", "Flush pass failed", e)
                }
                val wait = when {
                    OutboxMachine.dueRows(all.values.toList(), clock()).isNotEmpty() -> 0L
                    else -> OutboxMachine.nextRetryDelayMs(all.values.toList(), clock()) ?: Long.MAX_VALUE
                }
                if (wait > 0) withTimeoutOrNull(wait) { wake.receive() }
            }
        }
        sweepJob = scope.launch {
            while (isActive) {
                delay(OutboxMachine.NOMATCH_SWEEP_MS)
                try {
                    sweep()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Storage hiccup: the next tick retries.
                    android.util.Log.w("Outbox", "Sweep tick failed", e)
                }
            }
        }
    }

    fun stop() {
        senderJob?.cancel(); senderJob = null
        sweepJob?.cancel(); sweepJob = null
        pendingFlush?.cancel(); pendingFlush = null
    }

    private fun scheduleFlush(delayMs: Long) {
        if (pendingFlush?.isActive == true) return
        pendingFlush = scope.launch { delay(delayMs); wake.trySend(Unit) }
    }

    suspend fun enqueue(input: EnqueueInput): OutboxRow {
        load()
        val row = mutex.withLock {
            val r = OutboxMachine.newRow(input, idGen(), nextSeq++, clock())
            save(listOf(r)); r
        }
        if (row.matched) scheduleFlush(OutboxMachine.BATCH_DELAY_MS)
        return row
    }

    /**
     * Builds every row for a finished burst and persists them all in ONE
     * `save()` under the mutex, instead of the caller doing its own loop of
     * individual `enqueue()` calls. Two problems that fixes: a caller-scoped
     * loop (e.g. a screen-scoped ViewModel's `scope.launch`) can be cancelled
     * partway through — the operator navigates away right as the count settles
     * — silently losing the tail of the burst; and N separate `save()` calls
     * mean N full outbox rebuilds/sorts/snapshot publishes for one sweep.
     *
     * Wrapped in `NonCancellable` so the persistence itself survives even if
     * the calling coroutine is cancelled the instant after this call starts —
     * the same durability idiom `flushOnce`'s terminal `save(updated)` already
     * uses for exactly this reason (a POST that already went out must not
     * strand its outcome unsaved because the sender was stopped).
     *
     * This makes a burst's persistence all-or-nothing rather than isolating
     * each tag's write — a deliberate change from how `enqueue()` in a loop
     * used to behave; see `ScanViewModel.onBurst`'s doc for the caller-side
     * half of this trade.
     */
    suspend fun enqueueAll(inputs: List<EnqueueInput>): List<OutboxRow> {
        load()
        val rows = withContext(NonCancellable) {
            mutex.withLock {
                val rs = inputs.map { OutboxMachine.newRow(it, idGen(), nextSeq++, clock()) }
                save(rs)
                rs
            }
        }
        if (rows.any { it.matched }) scheduleFlush(OutboxMachine.BATCH_DELAY_MS)
        return rows
    }

    private suspend fun flushOnce() {
        val serial = identity.get().serial
        val batch = mutex.withLock {
            val due = OutboxMachine.dueRows(all.values.toList(), clock())
            if (due.isEmpty()) return
            val sending = OutboxMachine.markSending(due)
            try {
                save(sending)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Storage failed while marking the batch `sending`: nothing went out
                // this pass. Revert any rows the mirror did pick up so they stay
                // eligible for the next pass instead of stranding as `sending`.
                android.util.Log.w("Outbox", "Couldn't mark a batch sending", e)
                sending.forEach { row ->
                    if (all[row.clientScanId]?.status == OutboxStatus.SENDING) {
                        all[row.clientScanId] = row.copy(status = OutboxStatus.QUEUED)
                    }
                }
                rebuild()
                return
            }
            sending
        }
        val scans = batch.map { r ->
            KioskScanIn(r.clientScanId, r.scannedValue, r.scanType, r.scannedAt, r.asset?.id, r.siteId, r.initiativeId, r.scanStatus)
        }
        val updated = try {
            val result = api.postScans(KioskScanBatchIn(serial, scans))
            OutboxMachine.applyResponse(batch, result.accepted.toSet(), result.rejected.associate { it.client_scan_id to it.code })
        } catch (e: CancellationException) {
            // The sender was stopped mid-POST: leave the batch alone. The rows stay
            // `sending` and the next start() recovers them.
            throw e
        } catch (e: Exception) {
            val code = (e as? ApiError)?.code?.takeIf { it.isNotEmpty() } ?: "timeout"
            OutboxMachine.applyFailure(batch, code, clock())
        }
        // The POST already happened: persist its outcome even if the sender is being
        // cancelled right now, or the batch would strand as `sending`.
        withContext(NonCancellable) {
            mutex.withLock {
                try { save(updated) } catch (e: Exception) {
                    // Storage failed: never leave rows `sending`, or they'd be stranded.
                    android.util.Log.w("Outbox", "Couldn't save a batch's outcome", e)
                    updated.filter { all[it.clientScanId]?.status == OutboxStatus.SENDING }
                        .forEach { all[it.clientScanId] = it.copy(status = OutboxStatus.QUEUED) }
                    rebuild()
                }
            }
        }
    }

    private suspend fun sweep() {
        try {
            mutex.withLock {
                val stale = OutboxMachine.staleNoMatch(all.values.toList(), clock())
                if (stale.isEmpty()) return@withLock
                store.delete(stale.map { it.clientScanId })
                stale.forEach { all.remove(it.clientScanId) }
                rebuild()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Storage hiccup: the next tick retries.
            android.util.Log.w("Outbox", "Couldn't sweep expired no-match rows", e)
        }
    }

    suspend fun retryFailed() {
        mutex.withLock {
            val rows = OutboxMachine.retryFailed(all.values.toList())
            if (rows.isNotEmpty()) save(rows)
        }
        wake.trySend(Unit)
    }

    private suspend fun dropRows(pred: (OutboxRow) -> Boolean) = mutex.withLock {
        val drop = all.values.filter(pred)
        if (drop.isEmpty()) return@withLock
        store.delete(drop.map { it.clientScanId })
        drop.forEach { all.remove(it.clientScanId) }
        rebuild()
    }

    /** Drops accepted + nomatch; failed rows stay (the portal never got them). */
    suspend fun clearSent() = dropRows { it.status == OutboxStatus.ACCEPTED || it.status == OutboxStatus.NOMATCH }

    /** The operator confirmed these scans are being abandoned. */
    suspend fun discardFailed() = dropRows { it.status == OutboxStatus.FAILED }
}
