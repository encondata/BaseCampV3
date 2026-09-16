package com.serversherpa.kiosk.core.outbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxMachineTest {
    private val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN", "Dell")
    private val input = EnqueueInput("A-1", "barcode", asset, "site", "init", "pre_stage")

    private fun row(seq: Long, status: OutboxStatus = OutboxStatus.QUEUED, attempts: Int = 0, next: Long? = null, scannedAtMs: Long = 0) =
        OutboxMachine.newRow(input, "id$seq", seq, scannedAtMs).copy(status = status, attempts = attempts, nextAttemptAt = next)

    @Test fun newRowIsQueuedWhenMatchedNomatchOtherwise() {
        assertEquals(OutboxStatus.QUEUED, OutboxMachine.newRow(input, "x", 1, 0).status)
        val miss = OutboxMachine.newRow(input.copy(asset = null), "y", 2, 0)
        assertEquals(OutboxStatus.NOMATCH, miss.status)
        assertEquals(false, miss.matched)
        assertEquals("1970-01-01T00:00:00Z", miss.scannedAt)
    }

    @Test fun dueRowsTakesQueuedAndDueRetriesOldestFirstCapped() {
        val rows = (1..120L).map { row(it) } + row(200, OutboxStatus.RETRYING, next = 50) + row(201, OutboxStatus.RETRYING, next = 500) +
            row(300, OutboxStatus.FAILED) + row(301, OutboxStatus.ACCEPTED) + row(302, OutboxStatus.NOMATCH)
        val due = OutboxMachine.dueRows(rows.shuffled(), nowMs = 100)
        assertEquals(OutboxMachine.MAX_BATCH, due.size)
        assertEquals(1L, due.first().seq)
        assertTrue(due.none { it.seq == 201L || it.seq >= 300 })
    }

    @Test fun fromWireFallsBackToQueuedForAnUnknownStatus() {
        assertEquals(OutboxStatus.ACCEPTED, OutboxStatus.fromWire("accepted"))
        assertEquals(OutboxStatus.QUEUED, OutboxStatus.fromWire("something_new"))
    }

    @Test fun recoverStrandedResetsSendingToQueued() {
        val out = OutboxMachine.recoverStranded(listOf(row(1, OutboxStatus.SENDING), row(2, OutboxStatus.ACCEPTED)))
        assertEquals(listOf(OutboxStatus.QUEUED), out.map { it.status })
        assertEquals(1L, out.single().seq)
    }

    @Test fun responseAcceptsRejectsAndFailsUnmentioned() {
        val batch = listOf(row(1, OutboxStatus.SENDING), row(2, OutboxStatus.SENDING), row(3, OutboxStatus.SENDING))
        val out = OutboxMachine.applyResponse(batch, accepted = setOf("id1"), rejected = mapOf("id2" to "bad_site"))
        assertEquals(OutboxStatus.ACCEPTED, out[0].status)
        assertEquals(OutboxStatus.FAILED, out[1].status); assertEquals("bad_site", out[1].lastError)
        assertEquals(OutboxStatus.FAILED, out[2].status); assertEquals("no_ack", out[2].lastError)
    }

    @Test fun failureWalksTheLadderThenFails() {
        var rows = listOf(row(1, OutboxStatus.SENDING))
        val waits = mutableListOf<Long>()
        repeat(4) { i ->
            rows = OutboxMachine.applyFailure(rows, "network", nowMs = 1000)
            assertEquals(OutboxStatus.RETRYING, rows[0].status)
            assertEquals(i + 1, rows[0].attempts)
            waits += rows[0].nextAttemptAt!! - 1000
        }
        assertEquals(listOf(2000L, 4000L, 15000L, 60000L), waits)
        rows = OutboxMachine.applyFailure(rows, "network", nowMs = 1000)
        assertEquals(OutboxStatus.FAILED, rows[0].status)
        assertNull(rows[0].nextAttemptAt)
        assertEquals("network", rows[0].lastError)
    }

    @Test fun staleNoMatchAndCounts() {
        val rows = listOf(
            row(1, OutboxStatus.NOMATCH, scannedAtMs = 0), row(2, OutboxStatus.NOMATCH, scannedAtMs = 100_000),
            row(3, OutboxStatus.QUEUED, scannedAtMs = 0), row(4, OutboxStatus.ACCEPTED), row(5, OutboxStatus.FAILED), row(6, OutboxStatus.RETRYING),
        )
        assertEquals(listOf(1L), OutboxMachine.staleNoMatch(rows, nowMs = 130_000).map { it.seq })
        val c = OutboxMachine.counts(rows)
        assertEquals(OutboxCounts(queued = 2, accepted = 1, failed = 1, nomatch = 2, total = 6), c)
    }

    @Test fun nextRetryDelayAndRetryFailed() {
        assertNull(OutboxMachine.nextRetryDelayMs(listOf(row(1)), nowMs = 0))
        assertEquals(40L, OutboxMachine.nextRetryDelayMs(listOf(row(1, OutboxStatus.RETRYING, next = 140), row(2, OutboxStatus.RETRYING, next = 900)), nowMs = 100))
        assertEquals(0L, OutboxMachine.nextRetryDelayMs(listOf(row(1, OutboxStatus.RETRYING, next = 10)), nowMs = 100))
        val retried = OutboxMachine.retryFailed(listOf(row(1, OutboxStatus.FAILED, attempts = 5), row(2, OutboxStatus.ACCEPTED)))
        assertEquals(1, retried.size)
        assertEquals(OutboxStatus.QUEUED, retried[0].status); assertEquals(0, retried[0].attempts); assertNull(retried[0].lastError)
    }
}
