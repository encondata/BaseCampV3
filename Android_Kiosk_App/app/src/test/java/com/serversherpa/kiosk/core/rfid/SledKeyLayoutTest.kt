package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The trigger key layout: the attribute value, the decode table, the write order and its outcome (spec test 20). */
class SledKeyLayoutTest {
    private val refusal = VendorError("RFID_API_PARAM_OUT_OF_RANGE", "Parameter out of range")
    private val outOfStep = VendorError("RFID_API_UNKNOWN_ERROR", "Unknown error")
    private val timeout = VendorError("RFID_API_COMMAND_TIMEOUT", "Command timed out")

    /** Scripted vendor: each write and each read-back answers from its own queue, recording what was asked. */
    private class Script(writes: List<VendorError?>, reads: List<AttributeRead>) {
        private val writeAnswers = ArrayDeque(writes)
        private val readAnswers = ArrayDeque(reads)
        val written = mutableListOf<LayoutWrite>()
        var reads = 0

        fun write(w: LayoutWrite): VendorError? {
            written += w
            return writeAnswers.removeFirst()
        }

        fun readBack(): AttributeRead {
            reads++
            return readAnswers.removeFirst()
        }
    }

    private fun run(layout: SledTriggerLayout, script: Script) =
        runLayoutWrite(layout, script::write, script::readBack)

    @Test fun encodesThePairsTheSpecWrites() {
        assertEquals(4, keyLayoutValue(SledKey.RFID, SledKey.RFID))
        assertEquals(5, keyLayoutValue(SledKey.RFID, SledKey.SLED_SCAN))
        assertEquals(6, keyLayoutValue(SledKey.RFID, SledKey.TERMINAL_SCAN))
        assertEquals(9, keyLayoutValue(SledKey.SLED_SCAN, SledKey.RFID))
        assertEquals(10, keyLayoutValue(SledKey.SLED_SCAN, SledKey.SLED_SCAN))
        assertNull(keyLayoutValue(SledKey.UNKNOWN, SledKey.RFID))
        assertNull(keyLayoutValue(SledKey.RFID, SledKey.UNKNOWN))
    }

    @Test fun decodesEveryKnownValue() {
        assertEquals(readbackOf(SledKey.RFID, SledKey.TERMINAL_SCAN, 0), decodeKeyLayout(0))
        assertEquals(readbackOf(SledKey.TERMINAL_SCAN, SledKey.RFID, 1), decodeKeyLayout(1))
        assertEquals(SledTriggerLayout.SPLIT, decodeKeyLayout(2).layout)
        assertEquals(readbackOf(SledKey.SLED_SCAN, SledKey.RFID, 3), decodeKeyLayout(3))
        assertEquals(SledTriggerLayout.RFID, decodeKeyLayout(4).layout)
        assertEquals(SledTriggerLayout.BARCODE, decodeKeyLayout(10).layout)
        assertEquals(readbackOf(SledKey.NO_ACTION, SledKey.NO_ACTION, 28), decodeKeyLayout(28))
        // Every value the formula covers round-trips through the encoder.
        for (v in 4..28) {
            val rb = decodeKeyLayout(v)
            assertEquals(v, keyLayoutValue(rb.upper, rb.lower))
            assertEquals(v, rb.raw)
        }
    }

    @Test fun decodesJunkAsUnknown() {
        for (v in listOf(29, -1, null)) {
            val rb = decodeKeyLayout(v)
            assertEquals(SledKey.UNKNOWN, rb.upper)
            assertEquals(SledKey.UNKNOWN, rb.lower)
            assertEquals(v, rb.raw)
            assertNull(rb.layout)
        }
    }

    @Test fun writesAndFallbacksAreInTheSpecsOrder() {
        assertEquals(
            listOf(
                LayoutWrite.Keys(SledKey.RFID, SledKey.RFID),
                LayoutWrite.Keys(SledKey.RFID, SledKey.TERMINAL_SCAN),
                LayoutWrite.Raw("0"),
            ),
            layoutWrites(SledTriggerLayout.RFID),
        )
        assertEquals(
            listOf(LayoutWrite.Keys(SledKey.RFID, SledKey.SLED_SCAN), LayoutWrite.Raw("2")),
            layoutWrites(SledTriggerLayout.SPLIT),
        )
        assertEquals(
            listOf(
                LayoutWrite.Keys(SledKey.SLED_SCAN, SledKey.SLED_SCAN),
                LayoutWrite.Keys(SledKey.SLED_SCAN, SledKey.RFID),
                LayoutWrite.Raw("3"),
            ),
            layoutWrites(SledTriggerLayout.BARCODE),
        )
    }

    @Test fun aFailedWriteWhoseReadbackMatchesIsAccepted() {
        val script = Script(writes = listOf(refusal), reads = listOf(AttributeRead.Value(10)))
        assertEquals(LayoutWriteOutcome.Accepted(decodeKeyLayout(10)), run(SledTriggerLayout.BARCODE, script))
        assertEquals(1, script.written.size)
        assertEquals(1, script.reads)
    }

    @Test fun onlyARefusalMovesToTheNextFallback() {
        // First write refused (read-back shows the old value), the fallback is taken.
        val script = Script(
            writes = listOf(refusal, null),
            reads = listOf(AttributeRead.Value(4), AttributeRead.Value(9)),
        )
        assertEquals(LayoutWriteOutcome.Accepted(decodeKeyLayout(9)), run(SledTriggerLayout.BARCODE, script))
        assertEquals(layoutWrites(SledTriggerLayout.BARCODE).take(2), script.written)

        // A refusal on every entry walks the whole list; the first value read back wins.
        val all = Script(
            writes = listOf(refusal, refusal, refusal),
            reads = listOf(AttributeRead.Value(4), AttributeRead.Value(5), AttributeRead.Value(6)),
        )
        assertEquals(LayoutWriteOutcome.Accepted(decodeKeyLayout(4)), run(SledTriggerLayout.BARCODE, all))
        assertEquals(layoutWrites(SledTriggerLayout.BARCODE), all.written)

        // Nothing ever read back: a check failure, not a guess.
        val none = Script(
            writes = listOf(refusal, refusal),
            reads = listOf(AttributeRead.WrongAttribute, AttributeRead.Error(refusal)),
        )
        assertEquals(LayoutWriteOutcome.CheckFailed, run(SledTriggerLayout.SPLIT, none))
        assertEquals(layoutWrites(SledTriggerLayout.SPLIT), none.written)
    }

    @Test fun anOutOfStepWriteIsRetriedOnce() {
        val script = Script(
            writes = listOf(outOfStep, null),
            reads = listOf(AttributeRead.Value(4), AttributeRead.Value(5)),
        )
        assertEquals(LayoutWriteOutcome.Accepted(decodeKeyLayout(5)), run(SledTriggerLayout.SPLIT, script))
        val first = LayoutWrite.Keys(SledKey.RFID, SledKey.SLED_SCAN)
        assertEquals(listOf(first, first), script.written)
    }

    @Test fun aSecondOutOfStepMovesToTheNextFallback() {
        val script = Script(
            writes = listOf(outOfStep, outOfStep, null),
            reads = listOf(AttributeRead.Value(4), AttributeRead.Value(4), AttributeRead.Value(2)),
        )
        assertEquals(LayoutWriteOutcome.Accepted(decodeKeyLayout(2)), run(SledTriggerLayout.SPLIT, script))
        val first = LayoutWrite.Keys(SledKey.RFID, SledKey.SLED_SCAN)
        assertEquals(listOf(first, first, LayoutWrite.Raw("2")), script.written)
    }

    @Test fun linkTroubleStopsTheWrite() {
        val script = Script(
            writes = listOf(timeout),
            reads = listOf(AttributeRead.Error(timeout)),
        )
        assertEquals(LayoutWriteOutcome.LinkTrouble, run(SledTriggerLayout.RFID, script))
        assertEquals(1, script.written.size)

        // A write with link trouble whose read-back still answers (and does not match) also ends it.
        val answering = Script(writes = listOf(timeout), reads = listOf(AttributeRead.Value(10)))
        assertEquals(LayoutWriteOutcome.LinkTrouble, run(SledTriggerLayout.RFID, answering))
        assertEquals(1, answering.written.size)
    }

    @Test fun aWrongAttributeReadbackIsACheckFailure() {
        val script = Script(writes = listOf(null), reads = listOf(AttributeRead.WrongAttribute))
        assertEquals(LayoutWriteOutcome.CheckFailed, run(SledTriggerLayout.RFID, script))
        assertEquals(1, script.written.size)
    }

    @Test fun aSuccessfulWriteThatReadsBackSomethingElseIsAcceptedAsRead() {
        val script = Script(writes = listOf(null), reads = listOf(AttributeRead.Value(9)))
        val outcome = run(SledTriggerLayout.BARCODE, script)
        assertEquals(LayoutWriteOutcome.Accepted(decodeKeyLayout(9)), outcome)
        assertEquals(1, script.written.size)
    }

    @Test fun aLinkTroubleReadbackIsLinkTroubleNotACheckFailure() {
        val script = Script(writes = listOf(null), reads = listOf(AttributeRead.Error(timeout)))
        assertEquals(LayoutWriteOutcome.LinkTrouble, run(SledTriggerLayout.RFID, script))

        // A read-back error that is not link trouble is a check failure.
        val refused = Script(writes = listOf(null), reads = listOf(AttributeRead.Error(refusal)))
        assertEquals(LayoutWriteOutcome.CheckFailed, run(SledTriggerLayout.RFID, refused))
    }

    // ── the no-beam write, while the sled's scanner is not ready yet ──

    private fun runInterim(layout: SledTriggerLayout, script: Script) =
        runInterimWrite(layout, script::write, script::readBack)

    @Test fun theNoBeamWriteIsOneWriteOfTheNoBeamPair() {
        val barcode = Script(writes = listOf(null), reads = listOf(AttributeRead.Value(28)))
        assertEquals(InterimWriteOutcome.Accepted(decodeKeyLayout(28)), runInterim(SledTriggerLayout.BARCODE, barcode))
        assertEquals(listOf(LayoutWrite.Keys(SledKey.NO_ACTION, SledKey.NO_ACTION)), barcode.written)
        assertEquals(1, barcode.reads)

        val split = Script(writes = listOf(null), reads = listOf(AttributeRead.Value(8)))
        assertEquals(InterimWriteOutcome.Accepted(decodeKeyLayout(8)), runInterim(SledTriggerLayout.SPLIT, split))
        assertEquals(listOf(LayoutWrite.Keys(SledKey.RFID, SledKey.NO_ACTION)), split.written)
    }

    @Test fun aNoBeamWriteTheSledRefusesOrDoesNotTakeIsRefusedWithNoFallback() {
        val refused = Script(writes = listOf(refusal), reads = listOf(AttributeRead.Value(4)))
        assertEquals(InterimWriteOutcome.Refused, runInterim(SledTriggerLayout.BARCODE, refused))
        assertEquals("no fallback of its own", 1, refused.written.size)

        val notTaken = Script(writes = listOf(null), reads = listOf(AttributeRead.Value(4)))
        assertEquals("written, but the sled reads back another pair", InterimWriteOutcome.Refused, runInterim(SledTriggerLayout.BARCODE, notTaken))
        assertEquals(1, notTaken.written.size)

        val refusedUnread = Script(writes = listOf(refusal), reads = listOf(AttributeRead.WrongAttribute))
        assertEquals(InterimWriteOutcome.Refused, runInterim(SledTriggerLayout.SPLIT, refusedUnread))
        assertEquals(1, refusedUnread.written.size)
    }

    @Test fun aFailedNoBeamWriteWhoseReadbackMatchesIsAccepted() {
        val script = Script(writes = listOf(refusal), reads = listOf(AttributeRead.Value(28)))
        assertEquals(InterimWriteOutcome.Accepted(decodeKeyLayout(28)), runInterim(SledTriggerLayout.BARCODE, script))
        assertEquals(1, script.written.size)
    }

    @Test fun anOutOfStepNoBeamWriteIsRetriedOnceThenRefused() {
        val once = Script(writes = listOf(outOfStep, null), reads = listOf(AttributeRead.Value(4), AttributeRead.Value(8)))
        assertEquals(InterimWriteOutcome.Accepted(decodeKeyLayout(8)), runInterim(SledTriggerLayout.SPLIT, once))
        val noBeam = LayoutWrite.Keys(SledKey.RFID, SledKey.NO_ACTION)
        assertEquals(listOf(noBeam, noBeam), once.written)

        val twice = Script(writes = listOf(outOfStep, outOfStep), reads = listOf(AttributeRead.Value(4), AttributeRead.Value(4)))
        assertEquals(InterimWriteOutcome.Refused, runInterim(SledTriggerLayout.SPLIT, twice))
        assertEquals(listOf(noBeam, noBeam), twice.written)
    }

    @Test fun aNoBeamWriteWithNoReadbackIsACheckFailureAndLinkTroubleIsLinkTrouble() {
        val unread = Script(writes = listOf(null), reads = listOf(AttributeRead.WrongAttribute))
        assertEquals(InterimWriteOutcome.CheckFailed, runInterim(SledTriggerLayout.BARCODE, unread))
        val readRefused = Script(writes = listOf(null), reads = listOf(AttributeRead.Error(refusal)))
        assertEquals(InterimWriteOutcome.CheckFailed, runInterim(SledTriggerLayout.BARCODE, readRefused))

        val writeTimeout = Script(writes = listOf(timeout), reads = listOf(AttributeRead.Value(4)))
        assertEquals(InterimWriteOutcome.LinkTrouble, runInterim(SledTriggerLayout.BARCODE, writeTimeout))
        val readTimeout = Script(writes = listOf(null), reads = listOf(AttributeRead.Error(timeout)))
        assertEquals(InterimWriteOutcome.LinkTrouble, runInterim(SledTriggerLayout.BARCODE, readTimeout))
        assertEquals(1, readTimeout.written.size)
    }

    @Test fun onlyAScanTypeTriggerIsDropped() {
        assertFalse(triggerTypePasses("HANDHELD_TRIGGER_SCAN"))
        assertTrue(triggerTypePasses("HANDHELD_TRIGGER_RFID"))
        assertTrue(triggerTypePasses("HANDHELD_TRIGGER_DUAL"))
        assertTrue(triggerTypePasses(null))
    }
}
