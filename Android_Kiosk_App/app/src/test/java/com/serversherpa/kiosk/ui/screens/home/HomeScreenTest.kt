package com.serversherpa.kiosk.ui.screens.home

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HomeScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun incompleteSetupLocksFeatureTiles() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { HomeScreen(rememberNavController()) } } }
        compose.onNodeWithText("What would you like to do?").assertIsDisplayed()
        compose.onNodeWithText("Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.").assertIsDisplayed()
        assertEquals(6, compose.onAllNodesWithText("Finish Kiosk Setup first.").fetchSemanticsNodes().size)
    }

    @Test fun devModeUnlocksWithBanner() {
        val c = testContainer()
        runBlocking { c.prefs.setDevMode(true); c.prefs.setSetupState(SetupState.FAILED) }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { HomeScreen(rememberNavController()) } } }
        compose.onNodeWithText("Developer mode: all features are available while kiosk setup is failed.").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("Finish Kiosk Setup first.").fetchSemanticsNodes().size)
    }
}
