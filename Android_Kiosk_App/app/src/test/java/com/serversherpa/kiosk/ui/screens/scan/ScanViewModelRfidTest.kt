package com.serversherpa.kiosk.ui.screens.scan

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.OutboxStore
import com.serversherpa.kiosk.data.outbox.RoomOutboxStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidController
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.runner.RunWith

/** A throwaway, unstarted controller for tests that need a valid
 *  `RfidController` to satisfy the constructor but never exercise it. */
private fun throwawayRfidController(scope: kotlinx.coroutines.CoroutineScope) =
    RfidController(FakeRfidReader(), MutableStateFlow(DEFAULT_RFID_SETTINGS), scope)

/** A store whose `upsert()` fails exactly once, on the batch after
 *  [failNext] is set, then behaves again. Now that a burst persists in one
 *  `enqueueAll` call rather than a per-tag loop, there is only ever one
 *  `upsert()` per burst — so this proves a whole burst either lands together
 *  or not at all, rather than proving one tag's failure spares the rest. */
private class FailOnDemandOutboxStore(private val inner: OutboxStore) : OutboxStore {
    var failNext = false
    override suspend fun all() = inner.all()
    override suspend fun upsert(rows: List<OutboxRow>) {
        if (failNext) { failNext = false; throw IllegalStateException("disk") }
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
        val vm = ScanViewModel(
            db, Sync(api, db, backgroundScope), outbox, throwawayRfidController(backgroundScope),
            prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope,
        )
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
        val vm = ScanViewModel(
            db, Sync(api, db, backgroundScope), outbox, throwawayRfidController(backgroundScope),
            prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope,
        )
        settle()
        vm.onBurst(listOf("100348")); settle()
        assertEquals(NO_MOVE_DATA, vm.state.value.error)
        assertEquals(0, vm.outboxSnapshot.value.rows.size)
    }

    /**
     * `enqueueAll` makes a burst's persistence all-or-nothing (I2/I3): this
     * test used to be `aFailingTagMidBurstDoesNotStopTheOthersFromQueuing`
     * and asserted the OLD per-tag-isolation behavior — that one failing
     * write in the middle of a burst still let the tags around it queue.
     * That is no longer true on purpose: a burst is now one Room transaction,
     * so a storage failure loses the whole sweep rather than just the one
     * tag it hit. This is the direct, deliberate reversal of that earlier
     * test, proving the new contract instead: nothing from a failed burst
     * queues, and the operator sees the same storageError as before.
     */
    @Test fun aFailingBurstWriteQueuesNoneOfItsTagsAndSurfacesStorageError() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Tagged rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "flaky.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val store = FailOnDemandOutboxStore(RoomOutboxStore(db.outbox())).apply { failNext = true }
        val outbox = Outbox(store, api, Identity(prefs), backgroundScope)
        val vm = ScanViewModel(
            db, Sync(api, db, backgroundScope), outbox, throwawayRfidController(backgroundScope),
            prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope,
        )
        settle()

        vm.onBurst(listOf("000000000000000000100348", "tag-2", "tag-3")); settle()

        // The whole burst failed together: none of its tags queued, not even
        // the ones that would have persisted fine on their own.
        assertEquals(0, vm.outboxSnapshot.value.rows.size)
        assertEquals("Couldn't save this scan on the kiosk. Check its storage.", vm.state.value.storageError)

        // A later, healthy burst still works: the failure didn't wedge the outbox.
        vm.onBurst(listOf("000000000000000000100348", "tag-2", "tag-3")); settle()
        assertEquals(3, vm.outboxSnapshot.value.rows.size)
        assertEquals(null, vm.state.value.storageError)
    }

    @Test fun aSuccessfulBurstAfterSetupClearsAStaleError() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Tagged rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "stale.preferences_pb") })
        val api = FakeKioskApi()
        val outbox = Outbox(RoomOutboxStore(db.outbox()), api, Identity(prefs), backgroundScope)
        val vm = ScanViewModel(
            db, Sync(api, db, backgroundScope), outbox, throwawayRfidController(backgroundScope),
            prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope,
        )
        settle()

        // Burst before setup sets the error.
        vm.onBurst(listOf("000000000000000000100348")); settle()
        assertEquals(NO_MOVE_DATA, vm.state.value.error)
        assertEquals(0, vm.outboxSnapshot.value.rows.size)

        // Now finish setup and try again.
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage")); settle()
        vm.onBurst(listOf("000000000000000000100348")); settle()

        // The successful burst clears the stale error.
        assertEquals(null, vm.state.value.error)
        assertEquals(1, vm.outboxSnapshot.value.rows.size)
        assertEquals("000000000000000000100348", vm.outboxSnapshot.value.rows[0].scannedValue)
    }

    /**
     * I6, end to end: a burst that fails to persist must not leave the tag
     * permanently marked "already sent" in the controller's `queued` state.
     * Sweep 1 succeeds and seeds `queued`. Sweep 2 of the same tag proves
     * `queued` really was populated: under SKIP_SILENT the controller's own
     * dedup drops it before a burst is even emitted. Then a burst of the
     * same tag is driven straight at the ViewModel (bypassing the controller,
     * as the other tests in this file do) with the store failing — this is
     * where `ScanViewModel.onBurst` calls `rfid.forgetQueued`. A final sweep
     * through the real controller proves the tag reads as fresh again: only
     * possible if `forgetQueued` actually removed it from `queued`.
     */
    @Test fun aFailedBurstForgetsQueuedTagsSoARepeatSweepIsNotSilentlySkipped() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Tagged rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "i6.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val store = FailOnDemandOutboxStore(RoomOutboxStore(db.outbox()))
        val outbox = Outbox(store, api, Identity(prefs), backgroundScope)

        val reader = FakeRfidReader()
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true, repeatPolicy = RepeatSweepPolicy.SKIP_SILENT))
        val controller = RfidController(reader, settings, backgroundScope)
        val vm = ScanViewModel(
            db, Sync(api, db, backgroundScope), outbox, controller,
            prefs, FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope,
        )
        settle()
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { controller.bursts.collect { bursts += it } }
        controller.start(); controller.arm(); settle()
        controller.connectNow(); settle()

        // Sweep 1: succeeds, seeding the controller's `queued` with this tag.
        reader.emitTrigger(TriggerEvent.PRESSED); reader.emitTag("100348"); settle()
        reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(listOf(listOf("100348")), bursts)
        vm.onBurst(bursts.last()); settle()
        assertEquals(1, vm.outboxSnapshot.value.rows.size)

        // Sweep 2 of the SAME tag: the controller's own SKIP_SILENT dedup
        // drops it before a burst is even emitted — proof `queued` was
        // really populated by sweep 1.
        reader.emitTrigger(TriggerEvent.PRESSED); reader.emitTag("100348"); settle()
        reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(listOf(listOf("100348"), emptyList()), bursts)
        vm.onBurst(bursts.last()); settle()   // onBurst no-ops on an empty list
        assertEquals(1, vm.outboxSnapshot.value.rows.size)   // nothing new queued

        // Now fail persistence for a repeat of the same tag, driven directly
        // at the ViewModel (bypassing the controller for this one call).
        store.failNext = true
        vm.onBurst(listOf("100348")); settle()
        assertEquals("Couldn't save this scan on the kiosk. Check its storage.", vm.state.value.storageError)
        assertEquals(1, vm.outboxSnapshot.value.rows.size)   // the failed write queued nothing new

        // The proof: if forgetQueued really removed the key, the same tag
        // reads as fresh again on the next real sweep instead of being
        // silently skipped as "already sent".
        reader.emitTrigger(TriggerEvent.PRESSED); reader.emitTag("100348"); settle()
        reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(listOf(listOf("100348"), emptyList(), listOf("100348")), bursts)
    }
}
