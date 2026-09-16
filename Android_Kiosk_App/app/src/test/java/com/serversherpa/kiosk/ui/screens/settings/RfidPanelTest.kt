package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.settings.SETTINGS_TABS
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.core.settings.visibleTabs
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class RfidPanelTest {
    @get:Rule val compose = createComposeRule()

    // RfidPanel is by far the longest panel in Settings — well past a
    // 360x800 test window's height. In the real app it is always reached
    // through KioskShell, which wraps every screen's content in its own
    // Modifier.verticalScroll (see KioskShell.kt), so this is never an issue
    // on device. Composing RfidPanel bare, the way the other (short) panel
    // tests compose their panels, leaves the bottom rows laid out past the
    // fixed test window with nothing to scroll them into view — Compose
    // still finds those nodes by text, but a click can't land on a node the
    // layout gave zero size. Wrapping in the same verticalScroll here
    // matches how the panel is actually shown, and performScrollTo() before
    // a click on a row that may be below the fold mirrors what a real
    // operator's swipe would do.
    private fun ComposeContentTestRule.setRfidPanelContent(c: AppContainer) {
        setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    Column(Modifier.verticalScroll(rememberScrollState())) { RfidPanel() }
                }
            }
        }
    }

    @Test fun theTabExistsForAnyoneSignedInAndNotWhenSignedOut() {
        assertTrue(SETTINGS_TABS.any { it.id == SettingsTabId.RFID })
        assertTrue(visibleTabs(isAdmin = false, isDeveloper = false, signedIn = true).any { it.id == SettingsTabId.RFID })
        assertTrue(visibleTabs(isAdmin = false, isDeveloper = false, signedIn = false).none { it.id == SettingsTabId.RFID })
    }

    @Test fun theReaderIsOffUntilSomeoneTurnsItOn() {
        val c = testContainer()
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Off. Turn the reader on to use the sled.").assertIsDisplayed()
    }

    @Test fun pickingATriggerModeWritesIt() {
        val c = testContainer()
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Click to start and stop").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(RfidTriggerMode.TOGGLE, runBlocking { c.prefs.rfid.first() }.triggerMode)
    }

    @Test fun restoreDefaultsPutsEverythingBack() {
        val c = testContainer()
        runBlocking { c.prefs.setRfid(com.serversherpa.kiosk.core.rfid.RfidSettings(enabled = true, powerDbm = 9)) }
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Restore defaults").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(27, runBlocking { c.prefs.rfid.first() }.powerDbm)
    }
}
