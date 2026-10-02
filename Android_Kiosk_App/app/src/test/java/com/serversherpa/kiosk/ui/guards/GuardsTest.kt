package com.serversherpa.kiosk.ui.guards

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.foundation.layout.Column
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.serversherpa.kiosk.ui.Routes
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

    /** A Clear Setup moves the person to Setup while the gated screen is still composed:
     *  its gate must not bounce them Home off Kiosk Setup. */
    @Test fun setupGateLeavesAKioskThatIsAlreadyOnSetupThere() {
        val c = testContainer()
        c.auth.completePair(fakeSession())
        runBlocking { c.prefs.setSetupState(SetupState.INCOMPLETE) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    val nav = rememberNavController()
                    NavHost(nav, startDestination = Routes.SETUP) {
                        composable(Routes.HOME) { Text("home page") }
                        composable(Routes.SETUP) { Column { Text("setup page"); SetupGate(feature(FeatureId.SCAN), nav) { Text("scanning") } } }
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithText("setup page").assertIsDisplayed()
        compose.onNodeWithText("home page").assertDoesNotExist()
    }

    @Test fun setupGateSendsAnUnsetKioskHome() {
        val c = testContainer()
        c.auth.completePair(fakeSession())
        runBlocking { c.prefs.setSetupState(SetupState.INCOMPLETE) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    val nav = rememberNavController()
                    NavHost(nav, startDestination = Routes.SCAN) {
                        composable(Routes.HOME) { Text("home page") }
                        composable(Routes.SCAN) { SetupGate(feature(FeatureId.SCAN), nav) { Text("scanning") } }
                    }
                }
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("home page").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("scanning").assertDoesNotExist()
    }
}
