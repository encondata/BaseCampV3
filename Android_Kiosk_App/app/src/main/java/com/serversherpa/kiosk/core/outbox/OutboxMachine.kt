package com.serversherpa.kiosk.core.outbox

import java.time.Instant

enum class OutboxStatus(val wire: String) {
    QUEUED("queued"), SENDING("sending"), ACCEPTED("accepted"), RETRYING("retrying"), FAILED("failed"), NOMATCH("nomatch");
    companion object { fun fromWire(s: String) = entries.first { it.wire == s } }
}

/** The matched asset, denormalized onto the row so the receipt list keeps
 *  showing it after the roster is re-synced or cleared. */
data class OutboxAsset(
    val id: String, val assetId: String, val name: String?, val rfid: String?, val serialNumber: String?, val makeModel: String,
)

data class OutboxRow(
    val clientScanId: String,
    /** Monotonic per kiosk; the list is ordered by this, not by scannedAt. */
    val seq: Long,
    val scannedValue: String,
    val scanType: String,
    val scannedAt: String,
    val asset: OutboxAsset?,
    val matched: Boolean,
    val status: OutboxStatus,
    val attempts: Int,
    val nextAttemptAt: Long?,
    val lastError: String?,
    val siteId: String,
    val initiativeId: String,
    val scanStatus: String,
)

data class EnqueueInput(
    val scannedValue: String, val scanType: String, val asset: OutboxAsset?,
    val siteId: String, val initiativeId: String, val scanStatus: String,
)

/** queued = queued + sending + retrying ("still on its way"). */
data class OutboxCounts(val queued: Int, val accepted: Int, val failed: Int, val nomatch: Int, val total: Int)

object OutboxMachine {
    /** Waits between retries, indexed by the row's pre-increment attempts. */
    val BACKOFF: List<Long> = listOf(2_000, 4_000, 15_000, 60_000)
    const val MAX_BATCH = 100
    const val BATCH_DELAY_MS = 500L
    const val LIST_CAP = 200
    const val NOMATCH_TTL_MS = 120_000L
    const val NOMATCH_SWEEP_MS = 10_000L

    fun newRow(input: EnqueueInput, clientScanId: String, seq: Long, nowMs: Long): OutboxRow {
        val matched = input.asset != null
        return OutboxRow(
            clientScanId = clientScanId, seq = seq, scannedValue = input.scannedValue, scanType = input.scanType,
            scannedAt = Instant.ofEpochMilli(nowMs).toString(), asset = input.asset, matched = matched,
            status = if (matched) OutboxStatus.QUEUED else OutboxStatus.NOMATCH, attempts = 0,
            nextAttemptAt = null, lastError = null, siteId = input.siteId, initiativeId = input.initiativeId, scanStatus = input.scanStatus,
        )
    }

    /** Rows left `sending` by a process that died mid-POST go back to queued. */
    fun recoverStranded(all: List<OutboxRow>): List<OutboxRow> =
        all.filter { it.status == OutboxStatus.SENDING }.map { it.copy(status = OutboxStatus.QUEUED) }

    fun dueRows(all: List<OutboxRow>, nowMs: Long): List<OutboxRow> = all
        .filter { it.status == OutboxStatus.QUEUED || (it.status == OutboxStatus.RETRYING && (it.nextAttemptAt ?: 0) <= nowMs) }
        .sortedBy { it.seq }
        .take(MAX_BATCH)

    fun markSending(batch: List<OutboxRow>): List<OutboxRow> = batch.map { it.copy(status = OutboxStatus.SENDING) }

    /** A named rejection is permanent; an id in neither list is `no_ack`. */
    fun applyResponse(batch: List<OutboxRow>, accepted: Set<String>, rejected: Map<String, String>): List<OutboxRow> = batch.map { row ->
        if (row.clientScanId in accepted) row.copy(status = OutboxStatus.ACCEPTED, nextAttemptAt = null, lastError = null)
        else row.copy(status = OutboxStatus.FAILED, lastError = rejected[row.clientScanId] ?: "no_ack")
    }

    fun applyFailure(batch: List<OutboxRow>, code: String, nowMs: Long): List<OutboxRow> = batch.map { row ->
        val wait = BACKOFF.getOrNull(row.attempts)
        if (wait == null) row.copy(status = OutboxStatus.FAILED, attempts = row.attempts + 1, lastError = code, nextAttemptAt = null)
        else row.copy(status = OutboxStatus.RETRYING, attempts = row.attempts + 1, lastError = code, nextAttemptAt = nowMs + wait)
    }

    fun staleNoMatch(all: List<OutboxRow>, nowMs: Long): List<OutboxRow> {
        val cutoff = nowMs - NOMATCH_TTL_MS
        return all.filter { it.status == OutboxStatus.NOMATCH && parseMs(it.scannedAt) < cutoff }
    }

    fun counts(all: List<OutboxRow>): OutboxCounts {
        var queued = 0; var accepted = 0; var failed = 0; var nomatch = 0
        for (r in all) when (r.status) {
            OutboxStatus.ACCEPTED -> accepted++
            OutboxStatus.FAILED -> failed++
            OutboxStatus.NOMATCH -> nomatch++
            else -> queued++
        }
        return OutboxCounts(queued, accepted, failed, nomatch, all.size)
    }

    /** Milliseconds until the earliest retry is due (0 when overdue), or null when none is retrying. */
    fun nextRetryDelayMs(all: List<OutboxRow>, nowMs: Long): Long? = all
        .filter { it.status == OutboxStatus.RETRYING && it.nextAttemptAt != null }
        .minOfOrNull { maxOf(0L, it.nextAttemptAt!! - nowMs) }

    fun retryFailed(all: List<OutboxRow>): List<OutboxRow> = all
        .filter { it.status == OutboxStatus.FAILED }
        .map { it.copy(status = OutboxStatus.QUEUED, attempts = 0, nextAttemptAt = null, lastError = null) }

    private fun parseMs(iso: String): Long = try { Instant.parse(iso).toEpochMilli() } catch (e: Exception) { 0L }
}
