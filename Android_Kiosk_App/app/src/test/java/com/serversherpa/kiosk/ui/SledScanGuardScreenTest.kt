package com.serversherpa.kiosk.ui

import android.os.SystemClock
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.scan.SledScanGuard
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.components.LocalSledScanGuard
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.enroll.EnrollScreen
import com.serversherpa.kiosk.ui.screens.enroll.EnrollViewModel
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.screens.scan.ScanScreen
import com.serversherpa.kiosk.ui.screens.timeclock.TimeclockFlowScreen
import com.serversherpa.kiosk.ui.screens.timeclock.flow.FakeTcBackend
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcMode
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcStep
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TimeclockFlowViewModel
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Spec test 25 on screen (T1, T2): a sled that types a barcode and also sends it through its
 * scanner delivers it once on Scanning, on RFID Enroll and on Time Clock's Welcome, in either
 * order; the same route twice delivers twice. The screens get the container's guard the way
 * MainActivity provides it, and the sled's copy comes through the container's own collector.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class SledScanGuardScreenTest {
    /** Collectors on a shared flow a fake or the bus exposes read-only (it is a MutableSharedFlow underneath). */
    private fun kotlinx.coroutines.flow.SharedFlow<*>.collectors(): Int =
        (this as kotlinx.coroutines.flow.MutableSharedFlow<*>).subscriptionCount.value

    @get:Rule val compose = createComposeRule()

    private val selection = KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage")

    /** Set up for a move with one asset (asset ID A-1, serial SN1; with a tag unless [tagged] is
     *  false), started and in front, so the container's sled-barcode collector runs. */
    private fun rig(tagged: Boolean = true): AppContainer {
        val c = testContainer(FakeRfidReader())
        runBlocking {
            val tag = if (tagged) "000000000000000000100348" else null
            c.db.assets().insertAll(listOf(KioskAssetRow("a1", "A-1", "Rack", rfid = tag, serial_number = "SN1").toEntity()))
            c.prefs.setSetupSelection(selection)
            c.prefs.setSetupState(SetupState.COMPLETE)
        }
        c.start()
        c.foreground.value = true
        return c
    }

    private fun AppContainer.reader() = rfidReader as FakeRfidReader

    private fun queued(c: AppContainer) = runBlocking { c.db.outbox().all().size }

    private val box get() = compose.onNodeWithTag("scan-input")

    /** What the box holds (its placeholder aside). */
    private fun boxText(): String = box.fetchSemanticsNode().config[SemanticsProperties.EditableText].text

    private fun typeAndSubmit(value: String) {
        box.performTextInput(value)
        box.performImeAction()
        compose.waitForIdle()
    }

    /** The sled's scanner copy, through the container (hold, guard, bus). */
    private fun sledSends(c: AppContainer, value: String) {
        compose.waitUntilIdlingMain { c.reader().barcodes.collectors() > 0 }
        c.reader().emitBarcode(SledBarcode(value, null))
    }

    /** Long enough for the container's hold (at most [SledScanGuard.MAX_HOLD_MS]) to end. */
    private fun waitOutTheHold() {
        Thread.sleep(SledScanGuard.MAX_HOLD_MS + 300)
        compose.waitForIdle()
    }

    private fun showScanning(c: AppContainer) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c, LocalSledScanGuard provides c.sledScanGuard) {
                KioskTheme { ScanScreen(rememberNavController()) }
            }
        }
        compose.waitUntilIdlingMain { compose.onAllNodesWithTag("scan-input").fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntilIdlingMain { c.scanBus.events.collectors() > 0 }
    }

    @Test fun typedThenBusOnScanningDeliversOnce() {
        val c = rig()
        showScanning(c)
        typeAndSubmit("A-1")
        compose.waitUntilIdlingMain { queued(c) == 1 }
        sledSends(c, "A-1")
        waitOutTheHold()
        assertEquals(1, queued(c))
    }

    @Test fun busThenTypedOnScanningDeliversOnce() {
        val c = rig()
        showScanning(c)
        sledSends(c, "A-1")
        compose.waitUntilIdlingMain { queued(c) == 1 }
        typeAndSubmit("A-1")
        // Refused: the box is cleared and nothing more is queued.
        assertEquals("", boxText())
        waitOutTheHold()
        assertEquals(1, queued(c))
    }

    @Test fun theSameRouteTwiceDeliversTwice() {
        val c = rig()
        showScanning(c)
        typeAndSubmit("A-1")
        typeAndSubmit("A-1")
        compose.waitUntilIdlingMain { queued(c) == 2 }
        sledSends(c, "SN1")
        compose.waitUntilIdlingMain { queued(c) == 3 }
        sledSends(c, "SN1")
        compose.waitUntilIdlingMain { queued(c) == 4 }
        waitOutTheHold()
        assertEquals(4, queued(c))
    }

    // ── RFID Enroll: the first copy picks the asset; a second would hit the update gate ──

    private fun showEnroll(c: AppContainer): () -> EnrollViewModel {
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        compose.setContent {
            CompositionLocalProvider(
                LocalAppContainer provides c, LocalSledScanGuard provides c.sledScanGuard, LocalViewModelStoreOwner provides owner,
            ) { KioskTheme { EnrollScreen(rememberNavController()) } }
        }
        compose.waitUntilIdlingMain { compose.onAllNodesWithTag("scan-input").fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntilIdlingMain { c.scanBus.events.collectors() > 0 }
        return { ViewModelProvider(owner)[EnrollViewModel::class.java] }
    }

    private fun AppContainer.awaitReady(vm: () -> EnrollViewModel) =
        compose.waitUntilIdlingMain { vm().state.value.loadStatus == LoadStatus.READY }

    @Test fun typedThenBusOnEnrollDeliversOnce() {
        val c = rig(tagged = false)
        val vm = showEnroll(c)
        c.awaitReady(vm)
        typeAndSubmit("A-1")
        compose.waitUntilIdlingMain { vm().state.value.asset != null }
        // On the tag step now: a second copy of the asset ID would be refused as a tag value.
        sledSends(c, "A-1")
        waitOutTheHold()
        assertEquals("A-1", vm().state.value.asset?.assetId)
        assertNull(vm().state.value.error)
        assertFalse(vm().state.value.saving)
    }

    @Test fun busThenTypedOnEnrollDeliversOnce() {
        val c = rig(tagged = false)
        val vm = showEnroll(c)
        c.awaitReady(vm)
        sledSends(c, "A-1")
        compose.waitUntilIdlingMain { vm().state.value.asset != null }
        // The typed copy lands in the tag box: refused, cleared, never submitted as a tag.
        typeAndSubmit("A-1")
        assertEquals("", boxText())
        waitOutTheHold()
        assertEquals("A-1", vm().state.value.asset?.assetId)
        assertNull(vm().state.value.error)
        assertFalse(vm().state.value.saving)
    }

    // ── Time Clock Welcome: raw keys, no text field ──

    @Test fun timeClockWelcomeRawKeysGoThroughTheGuard() {
        val c = testContainer()
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        lateinit var vm: TimeclockFlowViewModel
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c, LocalViewModelStoreOwner provides owner, LocalSledScanGuard provides c.sledScanGuard) {
                vm = kioskViewModel { TimeclockFlowViewModel(TcMode.STATION, FakeTcBackend(), c.flash, null, flowOf(DEFAULT_APPEARANCE)) }
                TimeclockFlowScreen(vm)
            }
        }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(100)
        assertEquals(TcStep.WELCOME, vm.state.value.step)
        val flow = compose.onNodeWithTag("tc-flow")
        fun typeRaw(text: String) = flow.performKeyInput {
            for (ch in text) pressKey(
                when (ch) { '9' -> Key.Nine; '8' -> Key.Eight; else -> error("no key for $ch") },
            )
        }

        // The scanner's copy came first; then the sled types the same code and Enter.
        assertTrue(c.sledScanGuard.acceptSession("9989", SystemClock.elapsedRealtime()))
        typeRaw("9989")
        compose.waitForIdle()
        // Each key was noted as typing: a session copy arriving now would be held past the settle.
        val now = SystemClock.elapsedRealtime()
        assertTrue(c.sledScanGuard.sessionHoldMs(now, now) > SledScanGuard.SETTLE_MS)
        flow.performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()
        assertEquals("refused: the query is cleared", "", vm.state.value.query)
        assertNull("and nothing was searched", vm.state.value.shownMessage)

        // A code only typed is searched as before.
        typeRaw("9988")
        flow.performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()
        assertNotNull(vm.state.value.shownMessage)
    }
}
