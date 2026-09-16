package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class CheckpointsTest {
    @Test fun defaultsMatchTheWebKiosk() {
        assertEquals("pre_stage", CheckpointId.ENROLL.fallback)
        assertEquals("in_container", CheckpointId.CONTAINER_PACK.fallback)
        assertEquals("un_pack", CheckpointId.CONTAINER_UNPACK.fallback)
        assertEquals("on_truck", CheckpointId.TRUCK_LOAD.fallback)
        assertEquals("received", CheckpointId.TRUCK_UNLOAD.fallback)
        assertEquals("ss.kiosk.enrollStatus", CheckpointId.ENROLL.storageKey)
    }

    @Test fun effectiveFallsBackOnlyWhenOfferedAndMissing() {
        assertEquals("custom", effectiveCheckpoint(CheckpointId.ENROLL, "custom", emptyList()))
        assertEquals("custom", effectiveCheckpoint(CheckpointId.ENROLL, "custom", listOf("custom", "pre_stage")))
        assertEquals("pre_stage", effectiveCheckpoint(CheckpointId.ENROLL, "retired", listOf("pre_stage")))
    }
}
