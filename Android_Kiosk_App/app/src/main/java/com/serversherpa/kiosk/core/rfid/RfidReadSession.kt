package com.serversherpa.kiosk.core.rfid

import com.serversherpa.kiosk.core.scan.rfidKey

/** One tag as the burst saw it: the EPC to queue, and the key to compare by. */
data class TagSighting(val epc: String, val key: String)

/**
 * One pull of the trigger. `totalReads` counts every report the reader made,
 * including the same tag answering repeatedly, so an operator can tell a thin
 * read from a chatty one. `tags` holds each tag once, in the order it first
 * appeared. `skippedRepeats` counts tags dropped because this screen already
 * queued them.
 */
data class RfidReadSession(
    val startedAtMs: Long,
    val totalReads: Int = 0,
    val tags: List<TagSighting> = emptyList(),
    val skippedRepeats: Int = 0,
) {
    val uniqueCount: Int get() = tags.size
}

fun startSession(nowMs: Long): RfidReadSession = RfidReadSession(startedAtMs = nowMs)

/**
 * Fold one tag report into the session.
 *
 * `alreadyQueued` is the set of keys this visit to the screen has already put
 * in the outbox. Under ALWAYS_QUEUE it is ignored: a second sweep of a rack is
 * a second scan, the same as pulling a barcode trigger twice.
 */
fun onTagRead(
    session: RfidReadSession,
    rawEpc: String,
    alreadyQueued: Set<String>,
    policy: RepeatSweepPolicy,
): RfidReadSession {
    val key = rfidKey(rawEpc) ?: return session
    val counted = session.copy(totalReads = session.totalReads + 1)
    // The same tag answering again inside this burst is normal, not a repeat sweep.
    if (counted.tags.any { it.key == key }) return counted
    if (policy != RepeatSweepPolicy.ALWAYS_QUEUE && key in alreadyQueued) {
        return counted.copy(skippedRepeats = counted.skippedRepeats + 1)
    }
    return counted.copy(tags = counted.tags + TagSighting(rawEpc.trim(), key))
}
