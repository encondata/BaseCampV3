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
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Ruling 35: the Developer tab's "Zebra SDK logging" switch shows the reader's vendor logging
 *  and sets it; nothing is saved. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class DeveloperSledLoggingTest {
    @get:Rule val compose = createComposeRule()

    @Test fun theSwitchShowsAndSetsVendorLogging() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setDevMode(true) }
        // On a scrolling page, as KioskShell hosts it: the row sits below the fake reader's own.
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState())) { DeveloperPanel() } }
            }
        }

        compose.onNodeWithTag("vendor-logging").performScrollTo()
        compose.onNodeWithText(SledWords.VENDOR_LOGGING_HINT).assertExists()
        val switch = compose.onNodeWithTag("vendor-logging")
        switch.assertIsOff()
        assertFalse(reader.vendorLogging.value)

        switch.performClick()
        compose.waitForIdle()
        assertTrue(reader.vendorLogging.value)
        switch.assertIsOn()

        // It follows the reader, not a saved setting: still on after the panel recomposes.
        runBlocking { c.prefs.setDevMode(false) }
        compose.waitForIdle()
        runBlocking { c.prefs.setDevMode(true) }
        compose.waitForIdle()
        compose.onNodeWithTag("vendor-logging").performScrollTo().assertIsOn()
        assertTrue(reader.vendorLogging.value)

        // Set by the reader (the app restarted, say): the switch shows it.
        reader.setVendorLogging(false)
        compose.waitForIdle()
        compose.onNodeWithTag("vendor-logging").assertIsOff()
    }

    @Test fun theRowIsForDevelopersOnly() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { DeveloperPanel() } } }
        compose.waitForIdle()
        compose.onNodeWithText("Zebra SDK logging").assertDoesNotExist()
    }
}
