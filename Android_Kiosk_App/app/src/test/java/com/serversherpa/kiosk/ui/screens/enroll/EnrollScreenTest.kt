package com.serversherpa.kiosk.ui.screens.enroll

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowBuild

/**
 * Spec test 36 for RFID Enroll, both of whose steps are among the five screens with the sled's
 * controls (spec, Screens): on a phone, Sled triggers shows on the asset step and on the tag
 * step while the sled is connected; on a Zebra host (the MC2200, API 30) neither step shows a
 * sled control.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class EnrollScreenTest {
    @get:Rule val compose = createComposeRule()

    private val selection = KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage")

    /** Set up for a move with one untagged asset (asset ID A-1), the sled connected. */
    private fun rig(): AppContainer {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        val c = testContainer(reader)
        runBlocking {
            c.db.assets().insertAll(listOf(KioskAssetRow("a1", "A-1", "Rack", rfid = null, serial_number = "SN1").toEntity()))
            c.prefs.setSetupSelection(selection)
            c.prefs.setSetupState(SetupState.COMPLETE)
        }
        return c
    }

    /** The screen on a scrolling page, as KioskShell hosts it; the view model it built. */
    private fun show(c: AppContainer): () -> EnrollViewModel {
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c, LocalViewModelStoreOwner provides owner) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState())) { EnrollScreen(rememberNavController()) } }
            }
        }
        val vm = { ViewModelProvider(owner)[EnrollViewModel::class.java] }
        compose.waitUntilIdlingMain { vm().state.value.loadStatus == LoadStatus.READY }
        compose.waitUntilIdlingMain { compose.onAllNodesWithTag("scan-input").fetchSemanticsNodes().isNotEmpty() }
        return vm
    }

    /** Submits the asset's ID in the scan box: the screen moves on to the tag step. */
    private fun pickTheAsset(vm: () -> EnrollViewModel) {
        compose.onNodeWithTag("scan-input").performTextInput("A-1")
        compose.onNodeWithTag("scan-input").performImeAction()
        compose.waitUntilIdlingMain { vm().state.value.asset != null }
        compose.waitForIdle()
    }

    private fun count(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    @Test fun bothStepsShowTheSledTriggersWhileTheSledIsConnected() {
        val c = rig()
        val vm = show(c)
        compose.onNodeWithText(SledWords.SLED_TRIGGERS).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Both").performScrollTo().assertIsDisplayed()

        pickTheAsset(vm)
        assertEquals("A-1", vm().state.value.asset?.assetId)
        compose.onNodeWithText(SledWords.SLED_TRIGGERS).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Both").performScrollTo().assertIsDisplayed()
    }

    /** The MC2200: its own scanner reads barcodes, so neither step shows a sled control. */
    @Test @Config(sdk = [30]) fun aZebraHostShowsNoSledControlOnEitherStep() {
        ShadowBuild.setManufacturer("Zebra Technologies")
        val c = rig()
        assertTrue(c.isZebraHost)
        val vm = show(c)
        assertEquals(0, count(SledWords.SLED_TRIGGERS))
        assertEquals(0, count("Both"))
        assertEquals(0, compose.onAllNodesWithTag("sled-scan").fetchSemanticsNodes().size)

        pickTheAsset(vm)
        assertEquals(0, count(SledWords.SLED_TRIGGERS))
        assertEquals(0, count("Both"))
        assertEquals(0, compose.onAllNodesWithTag("sled-scan").fetchSemanticsNodes().size)
    }
}
