package com.serversherpa.kiosk.ui.shell

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
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
        compose.onNodeWithText("KIOSK · ANDROID").assertIsDisplayed()
        compose.onNodeWithText("Android", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Move A", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Data Sync").assertIsDisplayed()
    }
}
