package com.serversherpa.kiosk.ui.screens.scan

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.MemoryOutboxStore
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Background-scope work (DataStore, Outbox, ScanBus collectors) needs repeated
     *  runCurrent() to settle each hop; advanceUntilIdle() only drives foreground work.
     *  Room's suspend DAO queries hop onto its own real query executor (a genuine
     *  background thread, not the virtual test dispatcher), so each round also
     *  gets a short real sleep to let that thread post its result back. */
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { Thread.sleep(50); runCurrent() } }

    @Test fun matchedScanQueuesAndFlashesUnmatchedIsNoMatch() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(KioskAssetRow("a1", "A-1", "Rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity()))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "sc.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val outbox = Outbox(MemoryOutboxStore(), api, Identity(prefs), backgroundScope, clock = { testScheduler.currentTime })
        val bus = ScanBus(); val flash = FlashController(backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, prefs, bus, flash, sound = null, scopeOverride = backgroundScope)
        settle()
        assertEquals(LoadStatus.READY, vm.state.value.loadStatus); assertEquals(1, vm.state.value.rosterSize)
        vm.onScan("100348"); settle()
        val row = outbox.snapshot.value.rows[0]
        assertEquals(OutboxStatus.QUEUED, row.status); assertEquals("rfid", row.scanType); assertEquals("a1", row.asset?.id); assertEquals("s1", row.siteId)
        assertNotNull(flash.state.value)
        bus.publish(ScanEvent("zzz", ScanSource.DATAWEDGE)); settle()
        assertEquals(OutboxStatus.NOMATCH, outbox.snapshot.value.rows[0].status)
        assertEquals(2, outbox.snapshot.value.counts.total)
        db.close()
    }
}
