package com.serversherpa.kiosk.ui.screens.setup

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskSetupResult
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.SetupOptionInitiative
import com.serversherpa.kiosk.core.model.SetupOptionScanType
import com.serversherpa.kiosk.core.model.SetupOptionSite
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
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
class KioskSetupViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    private val options = SetupOptions(
        initiatives = listOf(SetupOptionInitiative("i1", "Move A", "in_progress", "In progress", "Acme", "2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z", SetupOptionSite("s1", "Origin"), SetupOptionSite("s2", "Dest"))),
        scan_types = listOf(SetupOptionScanType("pre_stage", "Pre-stage", "#abc")),
    )

    @Test fun wizardWalksThreeStepsAndSaves() = runTest {
        val api = FakeKioskApi().apply {
            setupOptionsResult = { options }
            submitSetupResult = { KioskSetupResult("d", it.initiative_id, "Move A", it.site_id, "Dest", "destination", it.scan_status, "Pre-stage") }
        }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "s.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); repeat(5) { runCurrent() }
        assertEquals(1, vm.state.value.step)
        vm.selectMove("i1"); assertEquals(2, vm.state.value.step)
        assertEquals(listOf("Origin" to "source", "Dest" to "destination"), vm.siteChoices().map { it.first.name to it.second })
        vm.selectSite("s2"); assertEquals(3, vm.state.value.step)
        vm.finish("pre_stage"); repeat(5) { runCurrent() }
        assertEquals(false, vm.state.value.wizardOpen)
        assertEquals("Dest", prefs.setupSelection.first()?.siteName)
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals(true, "syncAssets" in api.calls)
    }

    @Test fun failureMarksFailedOnlyWhenNotAlreadyComplete() = runTest {
        val api = FakeKioskApi().apply { setupOptionsResult = { options }; submitSetupResult = { throw ApiError(422, "bad_site") } }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "f.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); repeat(5) { runCurrent() }; vm.selectMove("i1"); vm.selectSite("s1"); vm.finish("pre_stage"); repeat(5) { runCurrent() }
        assertEquals("bad_site", vm.state.value.submitError)
        assertEquals(SetupState.FAILED, prefs.setupState.first())
        assertNull(prefs.setupSelection.first())
    }

    /** A Clear Setup (or any drop of the saved setup) landing while the summary shows must
     *  open the wizard and load the moves, not leave the screen stuck on "Loading moves…". */
    @Test fun aClearLandingOnTheSummaryOpensTheWizardAndLoadsTheMoves() = runTest {
        val api = FakeKioskApi().apply { setupOptionsResult = { options } }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "c.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move A", "s2", "Dest", "destination", "pre_stage", "Pre-stage"))
        prefs.setSetupState(SetupState.COMPLETE)
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        repeat(5) { runCurrent() }
        assertEquals(false, vm.state.value.wizardOpen)                 // the summary
        assertEquals(false, "setupOptions" in api.calls)
        prefs.applySetupClear("c1"); repeat(5) { runCurrent() }
        assertEquals(true, vm.state.value.wizardOpen)
        assertEquals(1, vm.state.value.step)
        assertEquals("", vm.state.value.initiativeId)
        assertEquals(options, vm.state.value.options)
        assertEquals(1, api.calls.count { it == "setupOptions" })
    }

    /** "Change setup" is open (picking a move) when a Clear Setup lands: the wizard starts
     *  over at step 1 with no choices and reloads the moves, as on the summary. */
    @Test fun aClearLandingWhileTheWizardIsOpenRestartsIt() = runTest {
        val api = FakeKioskApi().apply { setupOptionsResult = { options } }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "w.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move A", "s2", "Dest", "destination", "pre_stage", "Pre-stage"))
        prefs.setSetupState(SetupState.COMPLETE)
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        repeat(5) { runCurrent() }
        vm.openWizard(preselect = true); repeat(5) { runCurrent() }
        vm.selectMove("i1"); vm.selectSite("s1")
        assertEquals(3, vm.state.value.step)
        assertEquals(1, api.calls.count { it == "setupOptions" })
        prefs.applySetupClear("c3"); repeat(5) { runCurrent() }
        assertEquals(true, vm.state.value.wizardOpen)
        assertEquals(1, vm.state.value.step)
        assertEquals("", vm.state.value.initiativeId); assertEquals("", vm.state.value.siteId)
        assertEquals(2, api.calls.count { it == "setupOptions" })
    }

    /** Changing an existing setup through the wizard never restarts it on the way out. */
    @Test fun changingSetupThroughTheWizardDoesNotRestartIt() = runTest {
        val api = FakeKioskApi().apply {
            setupOptionsResult = { options }
            submitSetupResult = { KioskSetupResult("d", it.initiative_id, "Move A", it.site_id, "Origin", "source", it.scan_status, "Pre-stage") }
        }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "x.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move A", "s2", "Dest", "destination", "pre_stage", "Pre-stage"))
        prefs.setSetupState(SetupState.COMPLETE)
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        repeat(5) { runCurrent() }
        vm.openWizard(preselect = true); repeat(5) { runCurrent() }
        vm.selectMove("i1"); vm.selectSite("s1"); vm.finish("pre_stage"); repeat(5) { runCurrent() }
        assertEquals(false, vm.state.value.wizardOpen)
        assertEquals("Origin", prefs.setupSelection.first()?.siteName)
        assertEquals(1, api.calls.count { it == "setupOptions" })
    }

    @Test fun finishingSetupDismissesTheClearNotice() = runTest {
        val api = FakeKioskApi().apply {
            setupOptionsResult = { options }
            submitSetupResult = { KioskSetupResult("d", it.initiative_id, "Move A", it.site_id, "Dest", "destination", it.scan_status, "Pre-stage") }
        }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "n.preferences_pb") })
        prefs.applySetupClear("c2")
        assertEquals(true, prefs.setupClear.first()?.notice)
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        repeat(5) { runCurrent() }
        assertEquals(true, vm.state.value.wizardOpen)
        assertEquals(1, api.calls.count { it == "setupOptions" })   // opening on the wizard loads once, not twice
        vm.selectMove("i1"); vm.selectSite("s2"); vm.finish("pre_stage"); repeat(5) { runCurrent() }
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals(false, prefs.setupClear.first()?.notice)
        assertEquals(false, vm.state.value.wizardOpen)                 // the fresh setup's summary, not reopened
    }

    @Test fun dates() {
        assertEquals("Sep 20 – Sep 22", formatMoveDates(options.initiatives[0]))
        assertEquals("Starts Sep 20", formatMoveDates(options.initiatives[0].copy(scheduled_end = null)))
        assertNull(formatMoveDates(options.initiatives[0].copy(scheduled_start = null, scheduled_end = null)))
    }
}
