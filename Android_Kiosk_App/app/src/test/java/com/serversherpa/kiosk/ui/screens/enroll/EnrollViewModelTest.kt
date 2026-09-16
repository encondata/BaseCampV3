package com.serversherpa.kiosk.ui.screens.enroll

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
class EnrollViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Background-scope work (DataStore, Sync collectors) needs repeated
     *  runCurrent() to settle each hop; advanceUntilIdle() only drives foreground work.
     *  Room's suspend DAO queries hop onto its own real query executor (a genuine
     *  background thread, not the virtual test dispatcher), so each round also
     *  gets a short real sleep to let that thread post its result back. */
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { Thread.sleep(50); runCurrent() } }

    private suspend fun kotlinx.coroutines.test.TestScope.build(api: FakeKioskApi): Pair<EnrollViewModel, KioskDatabase> {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Rack", rfid = null, serial_number = "SN1", make_model = "Dell").toEntity(),
            KioskAssetRow("a2", "A-2", "Tagged", rfid = "000000000000000000100348", serial_number = "SN2", make_model = "HP").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "en.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val vm = EnrollViewModel(db, Sync(api, db, backgroundScope), api, prefs, Identity(prefs), FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope, clock = { 0L }, idGen = { "c1" })
        settle()
        return vm to db
    }

    @Test fun stepOneMatchesAssetOrSerialOnlyAndRefusesTags() = runTest {
        val (vm, _) = build(FakeKioskApi())
        vm.onScan("100348")
        assertNull(vm.state.value.asset)
        assertEquals("That's an RFID tag. Scan the asset's serial or ID first.", vm.state.value.error)
        vm.onScan("nope"); assertEquals("No asset found for \"nope\".", vm.state.value.error)
        vm.onScan("sn1"); assertEquals("a1", vm.state.value.asset?.id)
    }

    @Test fun stepTwoPadsSavesAndUpdatesLocalRoster() = runTest {
        val api = FakeKioskApi()
        val (vm, db) = build(api)
        vm.onScan("A-1"); vm.setTagValue("10 03 49")
        vm.submitTag("10 03 49"); settle()
        assertNull(vm.state.value.asset)                          // back to step one
        assertEquals("Enrolled Rack → 100349", vm.state.value.toast)
        assertEquals("000000000000000000100349", db.assets().all().first { it.id == "a1" }.rfid)
        assertEquals(1, vm.state.value.enrollments.size)
        assertEquals(false, vm.state.value.enrollments[0].replaced)
    }

    @Test fun errorsMapToCopy() = runTest {
        val api = FakeKioskApi().apply { rfidResult = { _, _ -> throw ApiError(409, "rfid_in_use", buildJsonObject { put("code", "rfid_in_use"); put("asset_name", "Other rack") }) } }
        val (vm, _) = build(api)
        vm.onScan("A-1"); vm.submitTag("100349"); settle()
        assertEquals("That tag is already on Other rack.", vm.state.value.error)
        assertEquals("a1", vm.state.value.asset?.id)   // stays on step two
        vm.submitTag("bad-tag"); assertEquals("That tag has characters we can't store — letters and numbers only.", vm.state.value.error)
    }
}
