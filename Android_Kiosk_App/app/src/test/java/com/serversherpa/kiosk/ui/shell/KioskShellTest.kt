package com.serversherpa.kiosk.ui.shell

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h640dp")
class KioskShellTest {
    @get:Rule val compose = createComposeRule()

    @Test fun barAndFooterShowContextSignedOut() {
        val c = testContainer()
        runBlocking { c.prefs.setSetupSelection(KioskSetupSelection("i", "Move A", "s", "Dock 4", "source", "pre_stage", "Pre-stage")) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { KioskShell(rememberNavController()) { Text("page body") } }
            }
        }
        compose.onNodeWithText("page body").assertIsDisplayed()
        // The brand is one string, not a logo plus two nudged Texts: a nudged pair
        // overlapped on a real device and read "ServeSherpa".
        compose.onNodeWithText("ServerSherpa").assertIsDisplayed()
        compose.onNodeWithText("Move A", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Dock 4", substring = true).assertIsDisplayed()
        // The footer carries the move context and nothing else: mode, version and the
        // sync light were noise an operator never acted on.
        for (gone in listOf("MODE", "VERSION", "Data Sync")) {
            assertEquals(gone, 0, compose.onAllNodesWithText(gone, substring = true).fetchSemanticsNodes().size)
        }
    }

    /** A stray tap must not end the shift: Sign out asks, and Cancel leaves the session alone. */
    @Test fun signOutAsksBeforeEndingTheSession() {
        val c = testContainer()
        c.auth.completePair(fakeSession())
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { KioskShell(rememberNavController()) { Text("page body") } }
            }
        }
        compose.onNodeWithContentDescription("Sign out").performClick()
        compose.onNodeWithText("Sign out of this kiosk?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Sign out of this kiosk?").assertDoesNotExist()
        assertTrue(c.auth.state.value is AuthState.Authed)
    }

    /** A long name must not push "Sign out" or the registration chip off a 360 dp screen. */
    @Test fun signOutStaysVisibleBesideALongDisplayName() {
        val c = testContainer()
        val session = fakeSession()
        c.auth.completePair(session.copy(person = session.person.copy(display_name = "Bartholomew Featherstonehaugh-Smythe")))
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { KioskShell(rememberNavController()) { Text("page body") } }
            }
        }
        compose.onNodeWithText("Sign out").assertIsDisplayed()
    }
}
