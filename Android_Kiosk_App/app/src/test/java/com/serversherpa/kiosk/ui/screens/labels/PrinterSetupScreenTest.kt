package com.serversherpa.kiosk.ui.screens.labels

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothPermissions
import com.serversherpa.kiosk.data.printer.FakeBluetoothLe
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Printer Setup's permission wiring (D11): the Bluetooth permissions are asked for the first time
 * Bluetooth is picked, never when the screen opens, exactly the set the link needs; the prompt's
 * answer goes to the scan; and coming back to the front reads Bluetooth again.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w320dp-h533dp-hdpi")
class PrinterSetupScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val app: Application = ApplicationProvider.getApplicationContext()
    private val fake = FakeBluetoothLe(BluetoothAvailability.POWERED_OFF)
    private val container: AppContainer = testContainer(bluetooth = fake)

    @After fun tearDown() {
        container.scope.cancel()
        container.db.close()
    }

    /** The screen inside the shell's 16 dp gutters, once [ready] shows. */
    private fun show(ready: String = "No printer set up yet.") {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) { PrinterSetupScreen(rememberNavController()) } }
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText(ready)).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
    }

    private fun layoutOf(text: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    /** [text] shows in full on its lines (nothing ellipsized or cut off below), inside the screen. */
    private fun assertWhole(text: String) {
        compose.onNodeWithText(text, useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        val layout = layoutOf(text)
        val last = layout.lineCount - 1
        assertTrue("$text is ellipsized", !layout.isLineEllipsized(last))
        assertTrue("$text is cut off below", !layout.didOverflowHeight)
        assertEquals("$text lost characters", text.length, layout.getLineEnd(last, visibleEnd = true))
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("$text runs off the screen: $node in $root", node.left >= root.left && node.right <= root.right)
    }

    /** Opening the screen with a saved Bluetooth printer and Bluetooth off (no way of finding a
     *  printer picked yet): the link's refusal shows whole on a 320 dp handheld, with its button
     *  inside the screen. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theOpenRefusalWithNoFindModeFitsA320dpHandheld() {
        Shadows.shadowOf(app).grantPermissions(*BluetoothPermissions.REQUIRED.toTypedArray())
        val saved = SavedPrinter(PrinterConnection.Bluetooth("D8J224508535", "AC:3F:A4:00:00:01"), "ZD421", "D8J224508535", 203)
        runBlocking { container.labelSettings.setPrinter(saved) }
        show(ready = BLUETOOTH_OFF_TEXT)
        assertWhole(BLUETOOTH_OFF_TEXT)
        assertWhole("Turn on Bluetooth")
        compose.onNode(hasClickAction() and hasText("Turn on Bluetooth")).assertIsDisplayed()
        assertEquals("nothing scanned", 0, fake.scanStarts)
    }

    @Test fun theBluetoothPermissionsAreAskedOnTheFirstPickNeverAtLaunch() {
        Shadows.shadowOf(app).denyPermissions(*BluetoothPermissions.REQUIRED.toTypedArray())
        show()
        // Opened: no prompt, no scan, nothing read from Bluetooth that needs the permissions.
        assertNull(Shadows.shadowOf(compose.activity).lastRequestedPermission)
        assertEquals(0, fake.scanStarts)

        compose.onNode(hasClickAction() and hasText("Bluetooth")).performScrollTo().performClick()
        compose.waitForIdle()
        val requested = Shadows.shadowOf(compose.activity).lastRequestedPermission?.requestedPermissions
        assertEquals(BluetoothPermissions.REQUIRED.toSet(), requested?.toSet())
        assertEquals(0, fake.scanStarts)

        // Allowed, with Bluetooth off: the next pick scans, and the link's refusal shows with its button.
        Shadows.shadowOf(app).grantPermissions(*BluetoothPermissions.REQUIRED.toTypedArray())
        compose.onNode(hasClickAction() and hasText("Bluetooth")).performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText(BLUETOOTH_OFF_TEXT)).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(BLUETOOTH_OFF_TEXT).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Turn on Bluetooth").performScrollTo().assertIsDisplayed()
        assertEquals("Bluetooth off: no scan was started", 0, fake.scanStarts)

        // Back to the front (from Settings, say): Bluetooth is read again, since Android says
        // nothing when a permission is granted there.
        val reads = fake.availabilityReads
        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(5_000) { fake.availabilityReads > reads }
        assertTrue(fake.availabilityReads > reads)
    }
}
