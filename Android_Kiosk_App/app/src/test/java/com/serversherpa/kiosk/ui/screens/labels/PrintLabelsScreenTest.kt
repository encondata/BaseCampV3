package com.serversherpa.kiosk.ui.screens.labels

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.data.printer.FakeBluetoothLe
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Print Labels' link warm-up (D4): on open, and again when the app comes back to the front. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrintLabelsScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val fake = FakeBluetoothLe()
    private val container: AppContainer = testContainer(bluetooth = fake)

    @After fun tearDown() {
        container.scope.cancel()
        container.db.close()
    }

    /** The saved Bluetooth printer's link comes up in the background when the screen opens, and
     *  again when the app comes back from the background (which closed it), with nothing on screen
     *  waiting or saying anything. */
    @Test fun printLabelsWarmsTheLinkOnOpenAndAgainOnResume() {
        val address = "AC:3F:A4:00:00:01"
        fake.printer(address)
        runBlocking {
            container.labelSettings.setPrinter(SavedPrinter(PrinterConnection.Bluetooth(FakeBluetoothLe.SERIAL, address), "ZD421", FakeBluetoothLe.SERIAL, 300))
        }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides container) { KioskTheme { PrintLabelsScreen(rememberNavController()) } }
        }
        compose.waitUntil(5_000) { fake.connects.size == 1 && container.zebraBluetooth.link.value.connected }
        assertEquals(listOf(address), fake.connects)

        // Backgrounded: the container closed the link. Back in front: it comes up again.
        container.zebraBluetooth.close()
        compose.waitUntil(5_000) { !container.zebraBluetooth.link.value.connected }
        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(5_000) { fake.connects.size == 2 && container.zebraBluetooth.link.value.connected }
        assertTrue(fake.links.first().closed)
        assertEquals(listOf(address, address), fake.connects)
    }
}
