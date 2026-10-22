package com.serversherpa.kiosk.core.labels

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LabelBuildStatusTest {
    @Test fun idleByDefault() {
        val s = LabelBuildStatus()
        assertEquals(LabelBuildPhase.IDLE, s.phase)
        assertEquals(0, s.done); assertEquals(0, s.total); assertEquals(0, s.ready)
        assertEquals(emptyMap<String, Int>(), s.problems)
        assertEquals(emptyList<String>(), s.notes)
        assertNull(s.needs)
    }

    @Test fun tallyCountsReadyAndProblemsByOutcome() {
        val t = tallyOutcomes(listOf("ok", NO_TEMPLATE_AT_DPI, "ok", TEMPLATE_FAILED, NO_TEMPLATE_AT_DPI, "ok"))
        assertEquals(3, t.ready)
        assertEquals(mapOf(NO_TEMPLATE_AT_DPI to 2, TEMPLATE_FAILED to 1), t.problems)
        assertEquals(LabelTally(0, emptyMap()), tallyOutcomes(emptyList()))
    }

    @Test fun progressIsDoneOverTotal() {
        assertEquals(0f, LabelBuildStatus(LabelBuildPhase.RUNNING, done = 0, total = 4).progress, 0f)
        assertEquals(0.5f, LabelBuildStatus(LabelBuildPhase.RUNNING, done = 2, total = 4).progress, 0f)
        assertEquals(1f, LabelBuildStatus(LabelBuildPhase.RUNNING, done = 4, total = 4).progress, 0f)
        // Nothing to render: a finished build is complete, a starting one is not.
        assertEquals(1f, LabelBuildStatus(LabelBuildPhase.DONE).progress, 0f)
        assertEquals(0f, LabelBuildStatus(LabelBuildPhase.RUNNING).progress, 0f)
    }

    @Test fun kindWireValues() {
        assertEquals("top", LabelKind.TOP.wire)
        assertEquals("front", LabelKind.FRONT.wire)
        assertEquals(LabelKind.FRONT, LabelKind.fromWire("front"))
        // Anything unknown (a selection saved before kinds existed) reads as Top.
        assertEquals(LabelKind.TOP, LabelKind.fromWire(null))
        assertEquals(LabelKind.TOP, LabelKind.fromWire("side"))
        assertEquals(LabelKind.TOP, LabelSettings().kind)
    }
}
