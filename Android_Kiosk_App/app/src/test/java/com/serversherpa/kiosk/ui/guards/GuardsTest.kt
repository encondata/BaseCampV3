package com.serversherpa.kiosk.ui.guards

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.FeatureId
import com.serversherpa.kiosk.core.features.feature
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.fakeSession
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
class GuardsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun mustChangePasswordShowsTheNotice() {
        val c = testContainer()
        c.auth.completePair(fakeSession(mustChange = true))
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { KioskGuard(rememberNavController()) { Text("secret") } } }
        }
        compose.onNodeWithText("Your password needs to be changed before you can use a kiosk.", substring = true).assertIsDisplayed()
    }

    @Test fun setupGateShowsContentWhenCompleteOrDevMode() {
        val c = testContainer()
        c.auth.completePair(fakeSession())
        runBlocking { c.prefs.setSetupState(SetupState.COMPLETE) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { SetupGate(feature(FeatureId.SCAN), rememberNavController()) { Text("scanning") } } }
        }
        compose.onNodeWithText("scanning").assertIsDisplayed()
    }
}
