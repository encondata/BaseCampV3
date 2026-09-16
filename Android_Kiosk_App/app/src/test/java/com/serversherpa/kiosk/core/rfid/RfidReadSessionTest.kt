package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidReadSessionTest {
    private fun read(s: RfidReadSession, epc: String, queued: Set<String> = emptySet(), policy: RepeatSweepPolicy = RepeatSweepPolicy.ALWAYS_QUEUE) =
        onTagRead(s, epc, queued, policy)

    @Test fun countsEveryReportButKeepsEachTagOnce() {
        var s = startSession(1_000)
        s = read(s, "100348"); s = read(s, "100349"); s = read(s, "100348")
        assertEquals(3, s.totalReads)
        assertEquals(2, s.uniqueCount)
        assertEquals(listOf("100348", "100349"), burstToScans(s))
    }

    /** One reader pads the EPC and another does not. They are the same tag. */
    @Test fun paddingDoesNotMakeASecondTag() {
        var s = startSession(0)
        s = read(s, "000000000000000000100348"); s = read(s, "100348")
        assertEquals(2, s.totalReads)
        assertEquals(1, s.uniqueCount)
        // The value queued is the EPC as it was first seen, not the stripped key.
        assertEquals(listOf("000000000000000000100348"), burstToScans(s))
    }

    @Test fun blankAndUnreadableValuesAreIgnoredEntirely() {
        var s = startSession(0)
        s = read(s, "   "); s = read(s, "")
        assertEquals(0, s.totalReads)
        assertEquals(0, s.uniqueCount)
    }

    @Test fun alwaysQueueKeepsATagThisScreenAlreadySent() {
        var s = startSession(0)
        s = read(s, "100348", queued = setOf("100348"), policy = RepeatSweepPolicy.ALWAYS_QUEUE)
        assertEquals(1, s.uniqueCount)
        assertEquals(0, s.skippedRepeats)
    }

    @Test fun skipPoliciesDropATagThisScreenAlreadySentAndCountIt() {
        for (policy in listOf(RepeatSweepPolicy.SKIP_SILENT, RepeatSweepPolicy.SKIP_AND_COUNT)) {
            var s = startSession(0)
            s = read(s, "100348", queued = setOf("100348"), policy = policy)
            s = read(s, "100349", queued = setOf("100348"), policy = policy)
            assertEquals(policy.name, 2, s.totalReads)
            assertEquals(policy.name, 1, s.uniqueCount)
            assertEquals(policy.name, 1, s.skippedRepeats)
            assertEquals(policy.name, listOf("100349"), burstToScans(s))
        }
    }

    /** A repeat inside one burst is not a "skipped repeat" — it is the same
     *  tag answering twice, which is what a reader does. */
    @Test fun aRepeatWithinTheBurstIsNotCountedAsSkipped() {
        var s = startSession(0)
        s = read(s, "100348", policy = RepeatSweepPolicy.SKIP_AND_COUNT)
        s = read(s, "100348", policy = RepeatSweepPolicy.SKIP_AND_COUNT)
        assertEquals(0, s.skippedRepeats)
        assertEquals(1, s.uniqueCount)
    }

    @Test fun whatIsQueuedCarriesForwardToTheNextBurst() {
        var s = startSession(0)
        s = read(s, "100348"); s = read(s, "0100349")
        assertEquals(setOf("9000", "100348", "100349"), queuedAfter(setOf("9000"), s))
    }
}
