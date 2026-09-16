package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class SettingsScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun signedOutShowsOnlyThisKioskAndSavesName() {
        val c = testContainer()
        runBlocking { c.identity.get() }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { SettingsScreen(rememberNavController(), null) } } }
        compose.onAllNodesWithText("This Kiosk").assertCountEquals(2)   // the tab and the panel heading
        compose.onNodeWithText("Appearance").assertDoesNotExist()
        compose.onNodeWithTag("kiosk-name").performTextClearance()
        compose.onNodeWithTag("kiosk-name").performTextInput("Dock 4")
        compose.onNodeWithText("Save name").performClick()
        compose.waitForIdle()
        var saved = false
        for (i in 0 until 20) {
            saved = runBlocking { c.prefs.name.first() } == "Dock 4"
            if (saved) break
            Thread.sleep(100)
            compose.waitForIdle()
        }
        assertEquals("Dock 4", runBlocking { c.prefs.name.first() })
    }

    @Test fun adminSeesAdminTabDeveloperSeesDeveloper() {
        val c = testContainer()
        c.auth.completePair(fakeSession(roles = listOf("developer"), maxRank = 100))
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { SettingsScreen(rememberNavController(), "developer") } } }
        compose.onNodeWithText("Admin").assertIsDisplayed()
        compose.onNodeWithText("Developer mode").assertIsDisplayed()
    }
}
