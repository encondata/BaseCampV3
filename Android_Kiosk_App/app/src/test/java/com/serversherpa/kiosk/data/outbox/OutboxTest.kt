package com.serversherpa.kiosk.data.outbox

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskScanBatchOut
import com.serversherpa.kiosk.core.model.KioskScanRejected
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** A store that fails the next N upserts/deletes, then behaves. */
private class FlakyOutboxStore(private val inner: MemoryOutboxStore = MemoryOutboxStore()) : OutboxStore {
    var failUpserts = 0
    var failDeletes = 0
    override suspend fun all() = inner.all()
    override suspend fun upsert(rows: List<OutboxRow>) { if (failUpserts > 0) { failUpserts--; throw IllegalStateException("disk") }; inner.upsert(rows) }
    override suspend fun delete(ids: List<String>) { if (failDeletes > 0) { failDeletes--; throw IllegalStateException("disk") }; inner.delete(ids) }
}

/** A store that just counts `upsert()` calls, for proving `enqueueAll`
 *  persists a whole batch in one call instead of one per row. */
private class CountingOutboxStore(private val inner: OutboxStore = MemoryOutboxStore()) : OutboxStore {
    var upsertCalls = 0
    override suspend fun all() = inner.all()
    override suspend fun upsert(rows: List<OutboxRow>) { upsertCalls++; inner.upsert(rows) }
    override suspend fun delete(ids: List<String>) = inner.delete(ids)
}

/** A store whose `upsert()` announces it has started (via [entered]), then
 *  suspends on [gate] until the test releases it — lets a test land a
 *  cancellation of the *calling* coroutine while the write is genuinely
 *  in flight, the same timing trick `stopMidPostThenStartResendsTheBatch`
 *  uses for the sender's POST. */
private class GatedUpsertOutboxStore(private val inner: MemoryOutboxStore = MemoryOutboxStore()) : OutboxStore {
    val entered = CompletableDeferred<Unit>()
    val gate = CompletableDeferred<Unit>()
    override suspend fun all() = inner.all()
    override suspend fun upsert(rows: List<OutboxRow>) {
        entered.complete(Unit)
        gate.await()
        inner.upsert(rows)
    }
    override suspend fun delete(ids: List<String>) = inner.delete(ids)
}

@OptIn(ExperimentalCoroutinesApi::class)
class OutboxTest {
    @get:Rule val tmp = TemporaryFolder()
    private val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN", "Dell")
    private fun input(value: String = "A-1", matched: Boolean = true) = EnqueueInput(value, "barcode", if (matched) asset else null, "s1", "i1", "pre_stage")

    /** Background-scope work (the sender loop, the retry channel, the DataStore actor
     *  behind Identity) is not driven by advanceUntilIdle(); repeatedly draining the
     *  ready queue lets a chain of immediate hops (mutex -> channel -> actor) settle. */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    private fun TestScope.outbox(api: FakeKioskApi, store: OutboxStore = MemoryOutboxStore()): Outbox {
        var n = 0
        return Outbox(store, api, testIdentity(tmp.root, backgroundScope), backgroundScope, clock = { testScheduler.currentTime }, idGen = { "c${++n}" })
    }

    @Test fun matchedScansBatchAfter500msAndAreAccepted() = runTest {
        val api = FakeKioskApi()
        val ob = outbox(api); ob.start(); settle()
        ob.enqueue(input()); advanceTimeBy(100); ob.enqueue(input("A-1"))
        assertEquals(0, api.scanBatches.size)
        advanceTimeBy(500); settle()
        assertEquals(1, api.scanBatches.size)
        assertEquals(listOf("c1", "c2"), api.scanBatches[0].scans.map { it.client_scan_id })
        assertEquals("a1", api.scanBatches[0].scans[0].asset_id)
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
        assertEquals(2, ob.snapshot.value.counts.accepted)
        assertEquals(2L, ob.snapshot.value.rows[0].seq)   // newest first
    }

    @Test fun enqueueAllPersistsEveryRowInOneStoreCallAndOneRebuild() = runTest {
        val api = FakeKioskApi()
        val store = CountingOutboxStore()
        val ob = outbox(api, store); ob.start(); settle()
        val inputs = (1..5).map { input("A-$it") }
        val rows = ob.enqueueAll(inputs); settle()
        // One upsert for the whole batch, not one per row.
        assertEquals(1, store.upsertCalls)
        assertEquals(5, rows.size)
        assertEquals(5, ob.snapshot.value.rows.size)
        val seqs = ob.snapshot.value.rows.map { it.seq }
        assertEquals(seqs.toSet().size, seqs.size)           // every seq distinct
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), rows.map { it.seq })   // increasing, in input order
    }

    /** The real regression proof for I2: a caller-scoped coroutine (like a
     *  screen-scoped ViewModel's `scope.launch`) can be cancelled the instant
     *  after it calls `enqueueAll`. The write must still land — that is what
     *  `enqueueAll`'s `NonCancellable` section is for. */
    @Test fun enqueueAllSurvivesCancellationOfTheCallingCoroutine() = runTest {
        val api = FakeKioskApi()
        val store = GatedUpsertOutboxStore()
        val ob = outbox(api, store); ob.start(); settle()

        val job = backgroundScope.launch { ob.enqueueAll(listOf(input("A-1"), input("A-2"))) }
        runCurrent()
        // The write is genuinely in flight (blocked inside upsert on the gate)
        // before we cancel the coroutine that called enqueueAll.
        assertTrue(store.entered.isCompleted)
        assertEquals(0, ob.snapshot.value.rows.size)

        job.cancel()
        runCurrent()
        store.gate.complete(Unit)
        settle()

        // The rows landed anyway: cancelling the caller did not lose them.
        assertEquals(2, ob.snapshot.value.rows.size)
        assertEquals(setOf("A-1", "A-2"), ob.snapshot.value.rows.map { it.scannedValue }.toSet())
    }

    @Test fun unmatchedNeverLeavesAndExpiresAfterTtl() = runTest {
        val api = FakeKioskApi()
        val ob = outbox(api); ob.start(); settle()
        ob.enqueue(input("zzz", matched = false))
        advanceTimeBy(5_000); settle()
        assertEquals(0, api.scanBatches.size)
        assertEquals(1, ob.snapshot.value.counts.nomatch)
        advanceTimeBy(OutboxMachine.NOMATCH_TTL_MS + OutboxMachine.NOMATCH_SWEEP_MS + 1); settle()
        assertEquals(0, ob.snapshot.value.counts.total)
    }

    @Test fun failureBacksOffThenSucceeds() = runTest {
        val api = FakeKioskApi()
        var fail = true
        api.postScansResult = { if (fail) throw ApiError(0, "network") else KioskScanBatchOut(accepted = it.scans.map { s -> s.client_scan_id }) }
        val ob = outbox(api); ob.start(); settle()
        ob.enqueue(input()); advanceTimeBy(600); settle()
        assertEquals(1, api.scanBatches.size)
        val row = ob.snapshot.value.rows[0]
        assertEquals(OutboxStatus.RETRYING, row.status); assertEquals(1, row.attempts); assertEquals("network", row.lastError)
        fail = false
        advanceTimeBy(2_001); settle()
        assertEquals(2, api.scanBatches.size)
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
    }

    @Test fun rejectionFailsImmediatelyAndRetryFailedRequeues() = runTest {
        val api = FakeKioskApi()
        api.postScansResult = { KioskScanBatchOut(rejected = it.scans.map { s -> KioskScanRejected(s.client_scan_id, "bad_site") }) }
        val ob = outbox(api); ob.start(); settle()
        ob.enqueue(input()); advanceTimeBy(600); settle()
        assertEquals(OutboxStatus.FAILED, ob.snapshot.value.rows[0].status)
        assertEquals("bad_site", ob.snapshot.value.rows[0].lastError)
        api.postScansResult = { KioskScanBatchOut(accepted = it.scans.map { s -> s.client_scan_id }) }
        ob.retryFailed(); settle()
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
    }

    @Test fun loadRecoversStrandedSendingRowsAndKeepsSeq() = runTest {
        val store = MemoryOutboxStore()
        store.upsert(listOf(OutboxMachine.newRow(input(), "old", 7, 0).copy(status = OutboxStatus.SENDING)))
        val api = FakeKioskApi()
        val ob = outbox(api, store); ob.start(); settle()
        assertEquals(1, api.scanBatches.size)          // resent
        val fresh = ob.enqueue(input()); settle()
        assertEquals(8L, fresh.seq)
    }

    /** The app is backgrounded mid-POST: stop() cancels the sender before the batch's
     *  outcome is known. The next start() must un-strand the row and resend it. */
    @Test fun stopMidPostThenStartResendsTheBatch() = runTest {
        val api = FakeKioskApi()
        val gate = CompletableDeferred<Unit>()
        var firstPost = true
        api.postScansResult = { body ->
            if (firstPost) { firstPost = false; gate.await() }   // never completes: this POST is cancelled
            KioskScanBatchOut(accepted = body.scans.map { s -> s.client_scan_id })
        }
        val ob = outbox(api); ob.start(); settle()
        ob.enqueue(input())
        advanceTimeBy(600); settle()
        assertEquals(1, api.scanBatches.size)
        assertEquals(listOf(OutboxStatus.SENDING), ob.snapshot.value.rows.map { it.status })

        ob.stop(); runCurrent()
        ob.start(); settle()
        assertTrue(ob.snapshot.value.rows.none { it.status == OutboxStatus.SENDING })
        assertEquals(2, api.scanBatches.size)                                  // resent
        assertEquals(listOf("c1"), api.scanBatches[1].scans.map { it.client_scan_id })
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
    }

    @Test fun clearSentAndDiscardFailed() = runTest {
        val api = FakeKioskApi()
        api.postScansResult = { KioskScanBatchOut(accepted = it.scans.filter { s -> s.scanned_value == "A-1" }.map { s -> s.client_scan_id },
            rejected = it.scans.filter { s -> s.scanned_value == "B-2" }.map { s -> KioskScanRejected(s.client_scan_id, "bad_status") }) }
        val ob = outbox(api); ob.start(); settle()
        ob.enqueue(input("A-1")); ob.enqueue(input("B-2")); ob.enqueue(input("nomatch", matched = false))
        advanceTimeBy(600); settle()
        assertEquals(3, ob.snapshot.value.counts.total)
        ob.clearSent()
        assertEquals(listOf(OutboxStatus.FAILED), ob.snapshot.value.rows.map { it.status })
        ob.discardFailed()
        assertTrue(ob.snapshot.value.rows.isEmpty())
    }

    @Test fun storageFailureWhileMarkingSendingDoesNotKillTheSender() = runTest {
        val api = FakeKioskApi()
        val store = FlakyOutboxStore()
        val ob = outbox(api, store); ob.start(); settle()
        ob.enqueue(input())                       // failUpserts == 0 here: the enqueue itself persists
        store.failUpserts = 1                      // fail the mark-sending save the 500ms flush is about to trigger
        advanceTimeBy(600); settle()
        // The sender loop's `while (isActive)` never sees the exception: the failed mark-sending save
        // reverts the row instead of stranding it `sending`, and the loop retries on its own (the row
        // is due again immediately) rather than dying. Exactly one batch — the original row, now
        // accepted — ever reaches the API; nothing was posted from the failed attempt.
        assertEquals(1, api.scanBatches.size)
        assertEquals(listOf("c1"), api.scanBatches[0].scans.map { it.client_scan_id })
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)

        // Prove the sender is still alive afterward too, not just for the one retry above.
        ob.enqueue(input("A-1")); advanceTimeBy(600); settle()
        assertEquals(2, api.scanBatches.size)
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
    }

    @Test fun storageFailureInSweepDoesNotKillTheSweeper() = runTest {
        val api = FakeKioskApi()
        val store = FlakyOutboxStore()
        val ob = outbox(api, store); ob.start(); settle()
        ob.enqueue(input("zzz", matched = false))
        store.failDeletes = 1
        advanceTimeBy(OutboxMachine.NOMATCH_TTL_MS + OutboxMachine.NOMATCH_SWEEP_MS); settle()
        assertEquals(1, ob.snapshot.value.counts.nomatch)   // delete threw; the sweeper kept the row rather than crash
        advanceTimeBy(OutboxMachine.NOMATCH_SWEEP_MS); settle()   // the sweep loop is still alive and retries next tick
        assertEquals(0, ob.snapshot.value.counts.total)
    }
}
