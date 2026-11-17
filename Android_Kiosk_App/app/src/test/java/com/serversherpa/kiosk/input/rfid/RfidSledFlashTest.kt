package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledFlash
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledWords
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The controller's `sledFlashes` (task H7) against the fake reader: a drop gives
 * [SledFlash.DROPPED]; a connect gives [SledFlash.READY], in Barcode only once the
 * sled's scanner is `Ready`; the setting off gives nothing.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidSledFlashTest {
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    private class Rig(t: TestScope, initial: RfidSettings, flashesOn: Boolean = true) {
        val fake = FakeRfidReader()
        val settings = MutableStateFlow(initial)
        val on = MutableStateFlow(flashesOn)
        val controller = RfidController(fake, settings, t.backgroundScope, sledFlashesOn = on) { t.testScheduler.currentTime }
        val seen = mutableListOf<SledFlash>()

        init {
            t.backgroundScope.launch { controller.sledFlashes.collect { seen += it } }
            controller.start()
        }
    }

    @Test fun anRfidConnectFlashesReadyAndADropFlashesDropped() = runTest {
        val rig = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = SledTriggerLayout.RFID))
        settle()
        rig.controller.connectNow()
        settle()
        assertEquals(listOf(SledFlash.READY), rig.seen)
        rig.fake.dropLink(SledWords.couldNotReach("Fake RFD40"))
        settle()
        assertEquals(listOf(SledFlash.READY, SledFlash.DROPPED), rig.seen)
    }

    @Test fun aBarcodeConnectFlashesReadyOnlyOnceTheScannerIsReady() = runTest {
        val rig = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = SledTriggerLayout.BARCODE))
        settle()
        rig.controller.connectNow()
        settle()
        rig.fake.setScanner(SledScannerState.Opening)
        settle()
        assertEquals("not while the scanner starts", emptyList<SledFlash>(), rig.seen)
        rig.fake.setScanner(SledScannerState.Ready)
        settle()
        assertEquals(listOf(SledFlash.READY), rig.seen)
    }

    @Test fun aManualDisconnectFlashesNothing() = runTest {
        val rig = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = SledTriggerLayout.RFID))
        settle()
        rig.controller.connectNow()
        settle()
        rig.controller.disconnectNow()
        settle()
        assertEquals(listOf(SledFlash.READY), rig.seen)
    }

    @Test fun withTheSettingOffNothingFlashes() = runTest {
        val rig = Rig(this, DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerLayout = SledTriggerLayout.RFID), flashesOn = false)
        settle()
        rig.controller.connectNow()
        settle()
        rig.fake.dropLink(SledWords.couldNotReach("Fake RFD40"))
        settle()
        assertEquals(emptyList<SledFlash>(), rig.seen)
    }
}
