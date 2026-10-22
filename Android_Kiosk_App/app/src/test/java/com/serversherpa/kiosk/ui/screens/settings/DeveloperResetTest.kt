package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class DeveloperResetTest {
    @get:Rule val compose = createComposeRule()

    @Test fun resetAppAsksFirstThenResetsAndGoesHome() {
        val c = testContainer()
        runBlocking {
            c.prefs.setDevMode(true)
            c.prefs.setSetupSelection(KioskSetupSelection("i1", "Move A", "s1", "Dallas", "source", "packed", "Packed"))
            c.prefs.setSetupState(SetupState.COMPLETE)
        }
        var home = 0
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { DeveloperPanel(goHome = { home++ }) } } }

        compose.onNodeWithText("Reset app").performClick()
        compose.onNodeWithText("Reset app?").assertExists()
        compose.onNodeWithText(
            "Clears the kiosk setup, the saved printer and label settings, and this kiosk's move data. Unsent scans, your sign-in and the server stay.",
        ).assertExists()
        // Nothing is cleared until the reset is confirmed.
        assertEquals(SetupState.COMPLETE, runBlocking { c.prefs.setupState.first() })

        compose.onNode(hasText("Reset app") and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(5_000) { home == 1 }
        compose.onNodeWithText("Reset app?").assertDoesNotExist()
        assertNull(runBlocking { c.prefs.setupSelection.first() })
        assertEquals(SetupState.INCOMPLETE, runBlocking { c.prefs.setupState.first() })
    }

    @Test fun cancelKeepsEverything() {
        val c = testContainer()
        runBlocking { c.prefs.setDevMode(true); c.prefs.setSetupState(SetupState.COMPLETE) }
        var home = 0
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { DeveloperPanel(goHome = { home++ }) } } }

        compose.onNodeWithText("Reset app").performClick()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Reset app?").assertDoesNotExist()
        assertEquals(SetupState.COMPLETE, runBlocking { c.prefs.setupState.first() })
        assertEquals(0, home)
    }
}
