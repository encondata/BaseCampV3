package com.serversherpa.kiosk.ui.screens.scan

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.OutboxStore
import com.serversherpa.kiosk.data.outbox.RoomOutboxStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A store that fails only its Nth upsert, then behaves — proves a single
 *  failing tag mid-burst does not stop the tags around it from queuing. */
private class FailNthUpsertOutboxStore(private val inner: OutboxStore, private val failOnCall: Int) : OutboxStore {
    private var calls = 0
    override suspend fun all() = inner.all()
    override suspend fun upsert(rows: List<OutboxRow>) {
        calls++
        if (calls == failOnCall) throw IllegalStateException("disk")
        inner.upsert(rows)
    }
    override suspend fun delete(ids: List<String>) = inner.delete(ids)
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanViewModelRfidTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Copied from ScanViewModelTest: Room's DAO calls hop onto a real
     *  executor thread, so each round needs a short real sleep. */
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { Thread.sleep(50); runCurrent() } }

    private suspend fun kotlinx.coroutines.test.TestScope.build(): ScanViewModel {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Tagged rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "rfid.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val outbox = Outbox(RoomOutboxStore(db.outbox()), api, Identity(prefs), backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope)
        settle()
        return vm
    }

    @Test fun everyTagInABurstIsQueuedAsAnRfidScan() = runTest {
        val vm = build()
        vm.onBurst(listOf("000000000000000000100348", "100999")); settle()

        val rows = vm.outboxSnapshot.value.rows
        assertEquals(2, rows.size)
        assertEquals(listOf("rfid", "rfid"), rows.map { it.scanType })
        // The known tag matched; the unknown one is a No match, exactly as a
        // typed value would be.
        val byValue = rows.associateBy { it.scannedValue }
        assertEquals("Tagged rack", byValue["000000000000000000100348"]?.asset?.name)
        assertEquals(OutboxStatus.NOMATCH, byValue["100999"]?.status)
    }

    @Test fun anEmptyBurstQueuesNothingAndSaysNothing() = runTest {
        val vm = build()
        vm.onBurst(emptyList()); settle()
        assertEquals(0, vm.outboxSnapshot.value.rows.size)
        assertEquals(null, vm.state.value.error)
    }

    @Test fun aBurstBeforeKioskSetupIsFinishedSaysSoRatherThanDroppingIt() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "empty.preferences_pb") })
        val api = FakeKioskApi()
        val outbox = Outbox(RoomOutboxStore(db.outbox()), api, Identity(prefs), backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope)
        settle()
        vm.onBurst(listOf("100348")); settle()
        assertEquals(NO_MOVE_DATA, vm.state.value.error)
        assertEquals(0, vm.outboxSnapshot.value.rows.size)
    }

    /** Each tag's outbox write is isolated: one failing write in the middle of a
     *  burst reports storageError but does not stop the tags before or after it
     *  from queuing (an aborted forty-tag sweep would cost far more than one
     *  storage hiccup already does). */
    @Test fun aFailingTagMidBurstDoesNotStopTheOthersFromQueuing() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Tagged rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "flaky.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val store = FailNthUpsertOutboxStore(RoomOutboxStore(db.outbox()), failOnCall = 2)
        val outbox = Outbox(store, api, Identity(prefs), backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope)
        settle()

        vm.onBurst(listOf("000000000000000000100348", "tag-2-fails", "tag-3")); settle()

        // Tags 1 and 3 queued; tag 2's write failed and never made it in.
        val values = vm.outboxSnapshot.value.rows.map { it.scannedValue }.toSet()
        assertEquals(setOf("000000000000000000100348", "tag-3"), values)
        assertEquals("Couldn't save this scan on the kiosk. Check its storage.", vm.state.value.storageError)
    }
}
