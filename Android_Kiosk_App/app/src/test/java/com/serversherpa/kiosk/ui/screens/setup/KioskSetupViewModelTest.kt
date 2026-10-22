package com.serversherpa.kiosk.ui.screens.setup

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.model.KioskSetupIn
import com.serversherpa.kiosk.core.model.KioskSetupResult
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.SetupOptionInitiative
import com.serversherpa.kiosk.core.model.SetupOptionScanType
import com.serversherpa.kiosk.core.model.SetupOptionSite
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.labels.LabelSettingsStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.station.StationKeyStore
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

    @Test fun wizardWalksFourStepsAndSaves() = runTest {
        val api = FakeKioskApi().apply {
            setupOptionsResult = { options }
            submitSetupResult = { KioskSetupResult("d", it.initiative_id, "Move A", it.site_id, "Dest", "destination", it.scan_status, "Pre-stage") }
        }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "s.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); repeat(5) { runCurrent() }
        assertEquals(0, vm.state.value.step)                           // what is this kiosk?
        vm.selectKind(SetupKind.REGULAR); assertEquals(1, vm.state.value.step)
        vm.selectMove("i1"); assertEquals(2, vm.state.value.step)
        assertEquals(listOf("Origin" to "source", "Dest" to "destination"), vm.siteChoices().map { it.first.name to it.second })
        vm.selectSite("s2"); assertEquals(3, vm.state.value.step)
        vm.selectScanType("pre_stage"); assertEquals(4, vm.state.value.step)
        assertEquals(false, "submitSetup" in api.calls)               // the scan type only advances
        assertEquals("top", vm.state.value.labelKind)                  // Top is preselected
        vm.finish("top"); repeat(5) { runCurrent() }
        assertEquals(false, vm.state.value.wizardOpen)
        assertEquals("Dest", prefs.setupSelection.first()?.siteName)
        assertEquals("top", prefs.setupSelection.first()?.labelKind)
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals(true, "syncAssets" in api.calls)
    }

    @Test fun finishingOnFrontSavesFrontAndTheStoreReportsIt() = runTest {
        val api = FakeKioskApi().apply {
            setupOptionsResult = { options }
            submitSetupResult = { KioskSetupResult("d", it.initiative_id, "Move A", it.site_id, "Dest", "destination", it.scan_status, "Pre-stage") }
        }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "k.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); repeat(5) { runCurrent() }
        vm.selectMove("i1"); vm.selectSite("s2"); vm.selectScanType("pre_stage")
        assertEquals(LabelKind.TOP, LabelSettingsStore(prefs).settings.first().kind)
        vm.finish("front"); repeat(5) { runCurrent() }
        assertEquals("front", prefs.setupSelection.first()?.labelKind)
        assertEquals(LabelKind.FRONT, LabelSettingsStore(prefs).settings.first().kind)
    }

    @Test fun backFromStepFourGoesToStepThree() = runTest {
        val api = FakeKioskApi().apply { setupOptionsResult = { options } }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "b.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); repeat(5) { runCurrent() }
        vm.selectMove("i1"); vm.selectSite("s2"); vm.selectScanType("pre_stage"); assertEquals(4, vm.state.value.step)
        vm.back(); assertEquals(3, vm.state.value.step)
        assertEquals("pre_stage", vm.state.value.scanStatus)
    }

    @Test fun aRerunPreselectsTheSavedKind() = runTest {
        val api = FakeKioskApi().apply { setupOptionsResult = { options } }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "r.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move A", "s2", "Dest", "destination", "pre_stage", "Pre-stage", labelKind = "front"))
        prefs.setSetupState(SetupState.COMPLETE)
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        repeat(5) { runCurrent() }
        vm.openWizard(preselect = true); repeat(5) { runCurrent() }
        assertEquals("front", vm.state.value.labelKind)
        vm.openWizard(preselect = false); repeat(5) { runCurrent() }
        assertEquals("top", vm.state.value.labelKind)
    }

    @Test fun failureMarksFailedOnlyWhenNotAlreadyComplete() = runTest {
        val api = FakeKioskApi().apply { setupOptionsResult = { options }; submitSetupResult = { throw ApiError(422, "bad_site") } }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "f.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); repeat(5) { runCurrent() }; vm.selectMove("i1"); vm.selectSite("s1"); vm.selectScanType("pre_stage"); vm.finish("top"); repeat(5) { runCurrent() }
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
        assertEquals(0, vm.state.value.step)
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
        assertEquals(0, vm.state.value.step)
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
        vm.selectMove("i1"); vm.selectSite("s1"); vm.selectScanType("pre_stage"); vm.finish("top"); repeat(5) { runCurrent() }
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
        vm.selectMove("i1"); vm.selectSite("s2"); vm.selectScanType("pre_stage"); vm.finish("top"); repeat(5) { runCurrent() }
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals(false, prefs.setupClear.first()?.notice)
        assertEquals(false, vm.state.value.wizardOpen)                 // the fresh setup's summary, not reopened
    }

    @Test fun dates() {
        assertEquals("Sep 20 – Sep 22", formatMoveDates(options.initiatives[0]))
        assertEquals("Starts Sep 20", formatMoveDates(options.initiatives[0].copy(scheduled_end = null)))
        assertNull(formatMoveDates(options.initiatives[0].copy(scheduled_start = null, scheduled_end = null)))
    }

    // ---- the Time Clock path ----

    private val tcOptions = options.copy(sites = listOf(SetupOptionSite("s1", "Origin"), SetupOptionSite("s2", "Dest"), SetupOptionSite("s9", "Yard")))

    private class Rig(val vm: KioskSetupViewModel, val api: FakeKioskApi, val prefs: KioskPrefs, val keys: StationKeyStore, val bodies: MutableList<KioskSetupIn>, val events: MutableList<String>)

    private fun kotlinx.coroutines.test.TestScope.rig(name: String, preKey: String? = null): Rig {
        val bodies = mutableListOf<KioskSetupIn>()
        val events = mutableListOf<String>()
        val api = FakeKioskApi().apply {
            setupOptionsResult = { tcOptions }
            submitSetupResult = { b ->
                bodies += b
                if (b.station_type == "timeclock") KioskSetupResult("d", b.initiative_id, b.initiative_id?.let { "Move A" }, b.site_id, b.site_id?.let { "Yard" }, if (b.site_id == null) "none" else "other")
                else KioskSetupResult("d", b.initiative_id, "Move A", b.site_id, "Dest", "destination", b.scan_status, "Pre-stage")
            }
            issueStationKeyResult = { events += "issue"; "tc-key-1" }
        }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "$name.preferences_pb") })
        val keys = StationKeyStore(MemorySecretStore())
        if (preKey != null) keys.put(preKey)
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(
            api, prefs, Identity(prefs), sync, backgroundScope,
            stationKeys = keys, signInBeat = { events += "beat" }, signOut = { events += "signOut" },
            io = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler),
        )
        return Rig(vm, api, prefs, keys, bodies, events)
    }

    private fun kotlinx.coroutines.test.TestScope.settle() = repeat(10) { runCurrent() }

    @Test fun theTypeStepComesFirstAndBackReturnsToIt() = runTest {
        val r = rig("t1")
        r.vm.load(); settle()
        assertEquals(0, r.vm.state.value.step)
        assertNull(r.vm.state.value.kind)
        r.vm.selectKind(SetupKind.TIMECLOCK)
        assertEquals(1, r.vm.state.value.step)
        r.vm.back()
        assertEquals(0, r.vm.state.value.step)
        assertEquals(SetupKind.TIMECLOCK, r.vm.state.value.kind)       // still marked
        r.vm.back()
        assertEquals(0, r.vm.state.value.step)
    }

    @Test fun aTimeClockWithNoMoveOffersEverySiteThenSavesIssuesTheKeyAndSignsOut() = runTest {
        val r = rig("t2")
        r.vm.load(); settle()
        r.vm.selectKind(SetupKind.TIMECLOCK); r.vm.selectNoMove()
        assertEquals(2, r.vm.state.value.step)
        assertEquals(true, r.vm.state.value.noMove)
        assertEquals(listOf("Origin", "Dest", "Yard"), r.vm.siteChoices().map { it.first.name })
        assertEquals(listOf("", "", ""), r.vm.siteChoices().map { it.second })   // no source/destination roles
        r.vm.selectSite("s9"); settle()
        assertEquals(KioskSetupIn(r.bodies[0].serial, null, "s9", null, "timeclock"), r.bodies.single())
        assertEquals("tc-key-1", r.keys.get())
        val sel = r.prefs.setupSelection.first()!!
        assertEquals("timeclock", sel.stationType)
        assertNull(sel.initiativeId); assertEquals("s9", sel.siteId); assertNull(sel.scanStatus)
        assertEquals(SetupState.COMPLETE, r.prefs.setupState.first())
        assertEquals(listOf("issue", "signOut"), r.events)
        assertEquals(false, r.vm.state.value.wizardOpen)
        assertEquals(false, "syncAssets" in r.api.calls)                // a Time Clock downloads no move data
    }

    @Test fun aTimeClockMaySayNoSite() = runTest {
        val r = rig("t3")
        r.vm.load(); settle()
        r.vm.selectKind(SetupKind.TIMECLOCK); r.vm.selectNoMove(); r.vm.selectNoSite(); settle()
        assertEquals(null, r.bodies.single().site_id)
        assertEquals(null, r.bodies.single().initiative_id)
        assertEquals(null, r.bodies.single().scan_status)
        assertEquals("timeclock", r.bodies.single().station_type)
        assertEquals("tc-key-1", r.keys.get())
        assertEquals(true, r.vm.state.value.noSite)
    }

    @Test fun aTimeClockWithAMoveOffersThatMovesSites() = runTest {
        val r = rig("t4")
        r.vm.load(); settle()
        r.vm.selectKind(SetupKind.TIMECLOCK); r.vm.selectMove("i1")
        assertEquals(false, r.vm.state.value.noMove)
        assertEquals(listOf("Origin" to "source", "Dest" to "destination"), r.vm.siteChoices().map { it.first.name to it.second })
        r.vm.selectSite("s2"); settle()
        assertEquals("i1", r.bodies.single().initiative_id)
        assertEquals("s2", r.bodies.single().site_id)
        assertEquals(null, r.bodies.single().scan_status)
        assertEquals("i1", r.prefs.setupSelection.first()?.initiativeId)
        assertEquals("tc-key-1", r.keys.get())
    }

    @Test fun notSignedInHereSendsOneHeartbeatAndRetriesOnce() = runTest {
        val r = rig("t5")
        var tries = 0
        r.api.issueStationKeyResult = { tries++; if (tries == 1) throw ApiError(403, "not_signed_in_here") else "tc-key-2" }
        r.vm.load(); settle()
        r.vm.selectKind(SetupKind.TIMECLOCK); r.vm.selectNoMove(); r.vm.selectSite("s1"); settle()
        assertEquals(2, tries)
        assertEquals(listOf("beat", "signOut"), r.events)
        assertEquals("tc-key-2", r.keys.get())
    }

    @Test fun aSecondRefusalStopsAndStaysSignedIn() = runTest {
        val r = rig("t6", preKey = "stale")
        var tries = 0
        r.api.issueStationKeyResult = { tries++; throw ApiError(403, "not_signed_in_here") }
        r.vm.load(); settle()
        r.vm.selectKind(SetupKind.TIMECLOCK); r.vm.selectNoMove(); r.vm.selectSite("s1"); settle()
        assertEquals(2, tries)                                          // one retry, never a loop
        assertEquals(listOf("beat"), r.events)                          // not signed out
        assertEquals("not_signed_in_here", r.vm.state.value.keyError)
        assertEquals(true, r.vm.state.value.wizardOpen)
        assertEquals(false, r.vm.state.value.submitting)
        assertNull(r.keys.get())                                        // the old key went with the old setup
        // the portal holds the Time Clock setup now, and so does this kiosk
        assertEquals("timeclock", r.prefs.setupSelection.first()?.stationType)
    }

    @Test fun rerunningSetupAsARegularKioskClearsTheKey() = runTest {
        val r = rig("t7", preKey = "tc-old")
        r.prefs.setSetupSelection(KioskSetupSelection(siteId = "s9", siteName = "Yard", siteRole = "other", stationType = "timeclock"))
        r.prefs.setSetupState(SetupState.COMPLETE)
        settle()
        r.vm.openWizard(preselect = true); settle()
        assertEquals(SetupKind.TIMECLOCK, r.vm.state.value.kind)       // the saved type is marked
        assertEquals(true, r.vm.state.value.noMove)
        r.vm.selectKind(SetupKind.REGULAR)
        r.vm.selectMove("i1"); r.vm.selectSite("s2"); r.vm.selectScanType("pre_stage"); r.vm.finish("top"); settle()
        assertNull(r.bodies.single().station_type)
        assertNull(r.keys.get())
        assertNull(r.prefs.setupSelection.first()?.stationType)
        assertEquals(false, "signOut" in r.events)
    }
}
