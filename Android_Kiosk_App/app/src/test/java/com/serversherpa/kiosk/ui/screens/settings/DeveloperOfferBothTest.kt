package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** H6 (Jimmy, 2026-11-17): the Developer tab's switch that offers Both in Sled triggers to
 *  everyone writes its own device setting. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class DeveloperOfferBothTest {
    @get:Rule val compose = createComposeRule()

    private fun offered(c: AppContainer) = runBlocking { c.prefs.offerSledBothToEveryone.first() }

    /** The switch follows the saved setting, which reaches the panel a frame or so after the write. */
    private fun awaitSwitch(on: Boolean) = compose.waitUntilIdlingMain {
        runCatching { compose.onNodeWithTag("offer-sled-both").apply { if (on) assertIsOn() else assertIsOff() } }.isSuccess
    }

    @Test fun theSwitchWritesTheSetting() {
        val c = testContainer()
        runBlocking { c.prefs.setDevMode(true) }
        // On a scrolling page, as KioskShell hosts it.
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState())) { DeveloperPanel() } }
            }
        }

        compose.onNodeWithTag("offer-sled-both").performScrollTo()
        compose.onNodeWithText("Offer Both in Sled triggers to everyone").assertExists()
        compose.onNodeWithText("Off: only developers see Both. A sled already set to Both keeps it.").assertExists()
        val switch = compose.onNodeWithTag("offer-sled-both")
        switch.assertIsOff()
        assertEquals(false, offered(c))

        switch.performClick()
        compose.waitUntilIdlingMain { offered(c) }
        assertEquals(true, offered(c))
        awaitSwitch(on = true)

        compose.onNodeWithTag("offer-sled-both").performClick()
        compose.waitUntilIdlingMain { !offered(c) }
        assertEquals(false, offered(c))
        awaitSwitch(on = false)
    }

    @Test fun theRowIsForDevelopersOnly() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { DeveloperPanel() } } }
        compose.waitForIdle()
        compose.onNodeWithText("Offer Both in Sled triggers to everyone").assertDoesNotExist()
    }
}
