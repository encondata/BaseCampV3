package com.serversherpa.kiosk.core.access

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessTest {
    @Test fun computeCanReadsTheNestedMap() {
        val perms = mapOf("kiosk" to mapOf("view" to true, "add" to false))
        assertTrue(computeCan(perms, "kiosk", "view"))
        assertFalse(computeCan(perms, "kiosk", "add"))
        assertFalse(computeCan(perms, "labels", "view"))
        assertFalse(computeCan(null, "kiosk", "view"))
    }
}
