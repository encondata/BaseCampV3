package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsTabsTest {
    private fun ids(isAdmin: Boolean, isDeveloper: Boolean, signedIn: Boolean) =
        visibleTabs(isAdmin, isDeveloper, signedIn).map { it.id }

    @Test fun signedOutSeesOnlyThisKiosk() {
        assertEquals(listOf(SettingsTabId.THIS_KIOSK), ids(isAdmin = true, isDeveloper = true, signedIn = false))
    }

    @Test fun workerSeesTheFourOpenTabs() {
        assertEquals(
            listOf(SettingsTabId.APPEARANCE, SettingsTabId.SOUND, SettingsTabId.DEVICES, SettingsTabId.THIS_KIOSK),
            ids(isAdmin = false, isDeveloper = false, signedIn = true),
        )
    }

    @Test fun adminGetsAdminDeveloperGetsDeveloper() {
        assertEquals(true, SettingsTabId.ADMIN in ids(isAdmin = true, isDeveloper = false, signedIn = true))
        assertEquals(false, SettingsTabId.DEVELOPER in ids(isAdmin = true, isDeveloper = false, signedIn = true))
        assertEquals(true, SettingsTabId.DEVELOPER in ids(isAdmin = false, isDeveloper = true, signedIn = true))
    }

    @Test fun wireRoundTrip() {
        assertEquals(SettingsTabId.THIS_KIOSK, SettingsTabId.fromWire("this-kiosk"))
        assertEquals(null, SettingsTabId.fromWire("nope"))
    }
}
