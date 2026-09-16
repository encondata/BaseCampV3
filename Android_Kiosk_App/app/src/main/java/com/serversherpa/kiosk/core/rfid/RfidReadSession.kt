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
 *
 * `resolvedKeys` is bookkeeping, not something callers read: it is every key
 * this burst has already decided about, whether it was kept in `tags` or
 * dropped as an already-queued repeat. A key dropped as a repeat never lands
 * in `tags`, so `tags` alone cannot tell a later report of that same key from
 * a brand-new one; `resolvedKeys` can.
 */
data class RfidReadSession(
    val startedAtMs: Long,
    val totalReads: Int = 0,
    val tags: List<TagSighting> = emptyList(),
    val skippedRepeats: Int = 0,
    val resolvedKeys: Set<String> = emptySet(),
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
    // The same tag answering again inside this burst is normal, not a repeat sweep,
    // whether it was queued or skipped the first time this burst resolved it.
    if (key in counted.resolvedKeys) return counted
    if (policy != RepeatSweepPolicy.ALWAYS_QUEUE && key in alreadyQueued) {
        return counted.copy(
            skippedRepeats = counted.skippedRepeats + 1,
            resolvedKeys = counted.resolvedKeys + key,
        )
    }
    return counted.copy(
        tags = counted.tags + TagSighting(rawEpc.trim(), key),
        resolvedKeys = counted.resolvedKeys + key,
    )
}
