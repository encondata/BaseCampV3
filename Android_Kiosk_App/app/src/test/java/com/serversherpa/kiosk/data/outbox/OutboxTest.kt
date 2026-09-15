package com.serversherpa.kiosk.data.outbox

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskScanBatchOut
import com.serversherpa.kiosk.core.model.KioskScanRejected
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class OutboxTest {
    @get:Rule val tmp = TemporaryFolder()
    private val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN", "Dell")
    private fun input(value: String = "A-1", matched: Boolean = true) = EnqueueInput(value, "barcode", if (matched) asset else null, "s1", "i1", "pre_stage")

    /** Background-scope work (the sender loop, the retry channel, the DataStore actor
     *  behind Identity) is not driven by advanceUntilIdle(); repeatedly draining the
     *  ready queue lets a chain of immediate hops (mutex -> channel -> actor) settle. */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    private fun TestScope.outbox(api: FakeKioskApi, store: MemoryOutboxStore = MemoryOutboxStore()): Outbox {
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
}
