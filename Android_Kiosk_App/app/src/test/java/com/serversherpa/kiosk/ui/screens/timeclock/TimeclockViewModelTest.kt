package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TimeclockViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Background-scope work (DataStore, Sync collectors) needs repeated
     *  runCurrent() to settle each hop; advanceUntilIdle() only drives foreground work.
     *  Room's suspend DAO queries hop onto its own real query executor (a genuine
     *  background thread, not the virtual test dispatcher), so each round also
     *  gets a short real sleep to let that thread post its result back. */
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { Thread.sleep(50); runCurrent() } }

    private suspend fun kotlinx.coroutines.test.TestScope.build(api: FakeKioskApi): TimeclockViewModel {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.people().insertAll(listOf(
            KioskPersonRow("p1", "Jimmy Henderson", "James", "Henderson", "Jimmy", "000000000000000000100348", true, true).toEntity(),
            KioskPersonRow("p2", "Tina Timeclock", "Tina", "Timeclock", null, "1003", true, false).toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "tc.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val vm = TimeclockViewModel(db, Sync(api, db, backgroundScope), api, prefs, Identity(prefs), FlashController(backgroundScope), null, scopeOverride = backgroundScope, clock = { testScheduler.currentTime })
        settle()
        return vm
    }

    @Test fun badgeAutoSelectsButAmbiguousPrefixWaits() = runTest {
        val vm = build(FakeKioskApi())
        assertEquals(LoadStatus.READY, vm.state.value.loadStatus)
        vm.onChange("1003")
        assertNull(vm.state.value.selected)          // 1003 is also a prefix of 100348
        vm.onChange("100348"); settle()
        assertEquals("p1", vm.state.value.selected?.id)
        assertEquals(LoadStatus.READY, vm.state.value.statusPhase)
    }

    @Test fun typedNameSearchesAndEnterSelectsSingleResult() = runTest {
        val vm = build(FakeKioskApi())
        vm.onChange("hen jim")
        assertEquals(listOf("p1"), vm.state.value.results.map { it.id })
        vm.onEnter("hen jim"); settle()
        assertEquals("p1", vm.state.value.selected?.id)
        vm.toEntry(); vm.onEnter("nobody")
        assertEquals("No worker found for \"nobody\".", vm.state.value.error)
    }

    @Test fun punchClocksInWithSetupThenReturnsToEntryAndIdleResets() = runTest {
        val api = FakeKioskApi()
        val vm = build(api)
        vm.onChange("100348"); settle()
        vm.punch(); settle()
        assertEquals("clockIn", api.calls.last())
        assertEquals("Clocked in — Tina T", vm.state.value.toast)
        assertNull(vm.state.value.selected)
        vm.onChange("100348"); settle()
        advanceTimeBy(IDLE_MS + 1); runCurrent()
        assertNull(vm.state.value.selected)
    }

    @Test fun punchErrorsMapAndRefreshStatus() = runTest {
        val api = FakeKioskApi().apply { clockInResult = { throw ApiError(409, "already_clocked_in") } }
        val vm = build(api)
        vm.onChange("100348"); settle()
        vm.punch(); settle()
        assertEquals("They are already clocked in. Refreshing…", vm.state.value.error)
        assertEquals(2, api.calls.count { it == "timeclockStatus" })
        assertEquals("3h 12m", formatMinutes(192)); assertEquals("45m", formatMinutes(45)); assertEquals("JH", initialsOf("Jimmy Henderson"))
    }
}
