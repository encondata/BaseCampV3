package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Spec test 32: on the Move password view, a scan from the bus (a sled barcode or a DataWedge
 *  intent) is the move password; on the other views it does nothing. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class LoginScanBusTest {
    /** Collectors on a shared flow a fake or the bus exposes read-only (it is a MutableSharedFlow underneath). */
    private fun kotlinx.coroutines.flow.SharedFlow<*>.collectors(): Int =
        (this as kotlinx.coroutines.flow.MutableSharedFlow<*>).subscriptionCount.value

    @get:Rule val compose = createComposeRule()

    private fun show(api: FakeKioskApi) = testContainer(api = api).also { c ->
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { LoginScreen(rememberNavController()) } } }
        compose.waitForIdle()
    }

    @Test fun aBusScanOnTheMovePasswordViewSignsInWithIt() {
        val api = FakeKioskApi()
        val c = show(api)
        compose.onNodeWithText("Move password").performScrollTo().performClick()
        compose.waitUntilIdlingMain { c.scanBus.events.collectors() > 0 }
        c.scanBus.publish(ScanEvent("MOVE-QR", ScanSource.SLED))
        compose.waitUntilIdlingMain { api.moveLoginPasswords.isNotEmpty() }
        assertEquals(listOf("MOVE-QR"), api.moveLoginPasswords)
    }

    @Test fun aBusScanOnOtherViewsDoesNothing() {
        val api = FakeKioskApi()
        val c = show(api)
        c.scanBus.publish(ScanEvent("MOVE-QR", ScanSource.DATAWEDGE))
        compose.waitForIdle()
        assertEquals(0, c.scanBus.events.collectors())
        // Off the Move password view again: the collector goes with it.
        compose.onNodeWithText("Move password").performScrollTo().performClick()
        compose.waitUntilIdlingMain { c.scanBus.events.collectors() > 0 }
        compose.onNodeWithText("Back to email & password").performScrollTo().performClick()
        compose.waitUntilIdlingMain { c.scanBus.events.collectors() == 0 }
        c.scanBus.publish(ScanEvent("MOVE-QR", ScanSource.SLED))
        compose.waitForIdle()
        Thread.sleep(200)
        compose.waitForIdle()
        assertEquals(emptyList<String>(), api.moveLoginPasswords)
        assertEquals(emptyList<String>(), api.calls.filter { it == "moveLogin" })
    }
}
