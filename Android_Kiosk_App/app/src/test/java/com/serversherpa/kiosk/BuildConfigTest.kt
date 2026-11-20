package com.serversherpa.kiosk

import com.serversherpa.kiosk.core.environment.Environments
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildConfigTest {
    /** Debug builds start on Dev (release builds on Prod): an id of the built-in list. */
    @Test fun debugBuildsDefaultToTheDevEnvironment() {
        assertEquals("dev", BuildConfig.DEFAULT_ENVIRONMENT_ID)
        val env = Environments.byId(BuildConfig.DEFAULT_ENVIRONMENT_ID)!!
        assertEquals("https://api.dev.serversherpa.com", env.apiUrl)
        assertEquals("https://portal.dev.serversherpa.com", env.portalUrl)
        assertTrue(BuildConfig.KIOSK_VERSION.isNotBlank())
    }
}
