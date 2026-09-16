package com.serversherpa.kiosk.ui.screens.scan

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.MemoryOutboxStore
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.OutboxStore
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidController
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
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
        val flash = FlashController(backgroundScope)
        val rfid = RfidController(FakeRfidReader(), MutableStateFlow(DEFAULT_RFID_SETTINGS), backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, rfid, prefs, flash, sound = null, scopeOverride = backgroundScope)
        settle()
        assertEquals(LoadStatus.READY, vm.state.value.loadStatus); assertEquals(1, vm.state.value.rosterSize)
        vm.onScan("100348"); settle()
        val row = outbox.snapshot.value.rows[0]
        assertEquals(OutboxStatus.QUEUED, row.status); assertEquals("rfid", row.scanType); assertEquals("a1", row.asset?.id); assertEquals("s1", row.siteId)
        assertNotNull(flash.state.value)
        vm.onScan("zzz"); settle()
        assertEquals(OutboxStatus.NOMATCH, outbox.snapshot.value.rows[0].status)
        assertEquals(2, outbox.snapshot.value.counts.total)
        db.close()
    }

    /** kiosk/src/pages/Scan.tsx statusLabel(), verbatim. */
    @Test fun statusLabelsMatchTheWebKiosk() {
        val base = OutboxMachine.newRow(EnqueueInput("A-1", "barcode", null, "s1", "i1", "pre_stage"), "c1", 1, 0)
        assertEquals("Queued", statusLabel(base.copy(status = OutboxStatus.QUEUED)))
        assertEquals("Sending", statusLabel(base.copy(status = OutboxStatus.SENDING)))
        assertEquals("Sent", statusLabel(base.copy(status = OutboxStatus.ACCEPTED)))
        assertEquals("Retrying (2/4)", statusLabel(base.copy(status = OutboxStatus.RETRYING, attempts = 2)))
        assertEquals("Failed: bad_site", statusLabel(base.copy(status = OutboxStatus.FAILED, lastError = "bad_site")))
        assertEquals("Failed: timeout", statusLabel(base.copy(status = OutboxStatus.FAILED, lastError = null)))
        assertEquals("No match", statusLabel(base.copy(status = OutboxStatus.NOMATCH)))
    }

    /** A store whose upsert always throws — like FlakyOutboxStore in OutboxTest.kt, copied
     *  here rather than importing that test-only private class. */
    private class ThrowingOutboxStore : OutboxStore {
        override suspend fun all(): List<OutboxRow> = emptyList()
        override suspend fun upsert(rows: List<OutboxRow>) { throw IllegalStateException("disk") }
        override suspend fun delete(ids: List<String>) { throw IllegalStateException("disk") }
    }

    @Test fun outboxWriteFailureSurfacesStorageError() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(KioskAssetRow("a1", "A-1", "Rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity()))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "sc2.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val outbox = Outbox(ThrowingOutboxStore(), api, Identity(prefs), backgroundScope, clock = { testScheduler.currentTime })
        val flash = FlashController(backgroundScope)
        val rfid = RfidController(FakeRfidReader(), MutableStateFlow(DEFAULT_RFID_SETTINGS), backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, rfid, prefs, flash, sound = null, scopeOverride = backgroundScope)
        settle()
        vm.onScan("A-1"); settle()
        assertEquals("Couldn't save this scan on the kiosk. Check its storage.", vm.state.value.storageError)
        db.close()
    }
}
