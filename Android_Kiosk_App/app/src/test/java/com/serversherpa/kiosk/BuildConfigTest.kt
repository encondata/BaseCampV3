package com.serversherpa.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildConfigTest {
    @Test fun debugDefaultsPointAtTheDevStack() {
        assertEquals("https://api.dev.serversherpa.com", BuildConfig.DEFAULT_API_URL)
        assertEquals("https://portal.dev.serversherpa.com", BuildConfig.DEFAULT_PORTAL_URL)
        assertTrue(BuildConfig.KIOSK_VERSION.isNotBlank())
    }
}
