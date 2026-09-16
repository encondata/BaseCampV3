package com.serversherpa.kiosk.core.rfid

/**
 * What a finished burst puts in the outbox: each tag once, in the order it was
 * first seen, as the EPC the reader reported. The repeat policy has already
 * been applied while the tags arrived, so there is nothing left to filter.
 */
fun burstToScans(session: RfidReadSession): List<String> = session.tags.map { it.epc }

/** The queued-key set to carry into the next burst on this screen. */
fun queuedAfter(alreadyQueued: Set<String>, session: RfidReadSession): Set<String> =
    alreadyQueued + session.tags.map { it.key }
