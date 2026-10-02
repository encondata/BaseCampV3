package com.serversherpa.kiosk.ui

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.flow.MutableSharedFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The app-level Clear Setup redirect: it sits beside the NavHost, outside every route. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SetupClearedRedirectTest {
    @get:Rule val compose = createComposeRule()

    /** Same shape as Heartbeat.setupCleared: no replay. */
    private val cleared = MutableSharedFlow<String>(extraBufferCapacity = 1)
    private lateinit var nav: NavHostController

    private fun host() {
        compose.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = Routes.HOME) {
                composable(Routes.HOME) { Text("home page") }
                composable(Routes.SETUP) { Text("setup page") }
                composable(Routes.SCAN) { Text("scan page") }
            }
            SetupClearedRedirect(nav, cleared)
        }
    }

    @Test fun anAppliedClearSendsThePersonToSetup() {
        host()
        compose.runOnIdle { nav.navigate(Routes.SCAN) }
        compose.onNodeWithText("scan page").assertIsDisplayed()
        compose.runOnIdle { cleared.tryEmit("x1") }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("setup page").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        assertEquals(Routes.SETUP, nav.currentDestination?.route)
    }

    @Test fun aClearAnnouncedBeforeTheRedirectExistedIsNotReplayed() {
        cleared.tryEmit("x0")   // nobody listening: dropped, never queued for a later collector
        host()
        compose.waitForIdle()
        compose.onNodeWithText("home page").assertIsDisplayed()
        assertEquals(Routes.HOME, nav.currentDestination?.route)
    }

    @Test fun aClearWhileAlreadyOnSetupStaysPut() {
        host()
        compose.runOnIdle { nav.navigate(Routes.SETUP) }
        compose.runOnIdle { cleared.tryEmit("x2") }
        compose.waitForIdle()
        assertEquals(Routes.SETUP, nav.currentDestination?.route)
        assertEquals(Routes.HOME, nav.previousBackStackEntry?.destination?.route)   // not stacked twice
    }
}
