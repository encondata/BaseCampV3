package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexCompany
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexLevel
import com.serversherpa.kiosk.core.model.RolodexList
import com.serversherpa.kiosk.core.model.RolodexOptions
import com.serversherpa.kiosk.core.model.RolodexPartner
import com.serversherpa.kiosk.core.model.RolodexRow
import com.serversherpa.kiosk.core.model.RolodexStatus
import com.serversherpa.kiosk.core.people.FILTER_ALL
import com.serversherpa.kiosk.core.people.FILTER_NO_PHOTO
import com.serversherpa.kiosk.core.people.RolodexEdit
import com.serversherpa.kiosk.core.people.buildPatch
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.PersonEntity
import com.serversherpa.kiosk.data.db.ROLODEX_META_KEY
import com.serversherpa.kiosk.testContainer
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private val T1: Instant = Instant.parse("2026-10-22T20:42:00Z")
private val T2: Instant = Instant.parse("2026-10-22T21:10:00Z")

internal fun rolodexRow(
    id: String, first: String, last: String, job: String? = null, company: String? = null,
    status: String = "active", hasPhoto: Boolean = true, preferred: String? = null,
) = RolodexRow(
    person_id = id, first_name = first, last_name = last, preferred_name = preferred,
    display_name = "${preferred ?: first} $last", job_title = job,
    company = company?.let { RolodexCompany("c-$it", it) },
    status = status, status_label = status.replaceFirstChar { it.uppercase() },
    status_color = when (status) { "active" -> "#3DDC84"; "standby" -> "#FFB84D"; else -> "#FF5D6C" },
    has_photo = hasPhoto,
)

/** The worker page's answer for [row]: the row plus contact details and edit rights. */
internal fun rolodexDetail(
    row: RolodexRow, email: String? = "${row.first_name.lowercase()}@example.com", phone: String? = "(312) 555-0142",
    canEdit: Boolean = true, canChangeStatus: Boolean = true, statusNote: String? = null,
) = RolodexDetail(
    person_id = row.person_id, first_name = row.first_name, last_name = row.last_name, preferred_name = row.preferred_name,
    display_name = row.display_name, job_title = row.job_title, company = row.company, trade = row.trade, level = row.level,
    status = row.status, status_label = row.status_label, status_color = row.status_color, has_photo = row.has_photo,
    rfid_enrolled = row.rfid_enrolled, has_account = row.has_account, email = email, phone = phone, external_id = "SC-1042",
    status_note = statusNote, can_edit = canEdit, can_change_status = canChangeStatus,
    edit_block_reason = if (canEdit) null else "rank_too_low",
    status_block_reason = if (canChangeStatus) null else "self",
)

internal val ROLODEX_OPTIONS = RolodexOptions(
    levels = listOf(RolodexLevel("L1", "Helper"), RolodexLevel("L3", "Lead")),
    statuses = listOf(RolodexStatus("active", "Active"), RolodexStatus("standby", "Standby"), RolodexStatus("blacklist", "Blacklist")),
    partners = listOf(RolodexPartner("c-Summit Crew", "Summit Crew"), RolodexPartner("c-Peak", "Peak Logistics")),
)

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RolodexViewModelTest {
    private val abbott = rolodexRow("p-abbott", "Ann", "Abbott", job = "Rigger", company = "Summit Crew", status = "standby")
    private val nunez = rolodexRow("p-nunez", "José", "Núñez", job = "Mover", hasPhoto = false)
    private val obrien = rolodexRow("p-obrien", "Sean", "O'Brien", status = "blacklist")

    /**
     * Room's suspend DAOs and the index build run on real threads: sleep, then drive the test
     * dispatcher. A few rounds always; then more, up to 10 s, until [done] holds (a loaded machine
     * can take far longer than the rounds for a cold Room or thread pool).
     */
    private fun TestScope.settle(done: () -> Boolean = { true }) {
        repeat(6) { Thread.sleep(50); runCurrent() }
        val deadline = System.nanoTime() + 10_000_000_000L
        while (!done() && System.nanoTime() < deadline) { Thread.sleep(50); runCurrent() }
    }

    private fun newDb() = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())

    private fun cached(db: KioskDatabase): String? = runBlocking { db.meta().get(ROLODEX_META_KEY)?.value }

    private fun onlineApi() = FakeKioskApi().apply {
        rolodexWorkersResult = { RolodexList("2026-10-22T20:42:00Z", listOf(obrien, abbott, nunez)) }
        rolodexOptionsResult = { ROLODEX_OPTIONS }
        rolodexWorkerResult = { id -> rolodexDetail(listOf(obrien, abbott, nunez).first { it.person_id == id }) }
    }

    private fun TestScope.build(api: FakeKioskApi, db: KioskDatabase = newDb(), now: Instant = T1, scope: CoroutineScope = backgroundScope): RolodexViewModel {
        val vm = RolodexViewModel(api, db, scopeOverride = scope, clock = { now })
        settle { !vm.state.value.loading }
        // A list that loaded is cached just after it shows.
        val ui = vm.state.value
        if (!ui.offline && ui.listError == null) settle { cached(db) != null }
        return vm
    }

    /** Opens [id]'s worker page and starts editing it. */
    private fun TestScope.editing(vm: RolodexViewModel, id: String = "p-abbott"): RolodexEdit {
        vm.select(id); settle { !vm.state.value.detailLoading }
        vm.startEdit()
        return vm.state.value.editing!!
    }

    // ── loading and the offline copy ──

    @Test fun loadSortsTheListAndCachesItWithoutEmailOrPhone() = runTest {
        val db = newDb()
        val vm = build(onlineApi(), db)
        val ui = vm.state.value
        assertEquals(listOf("Abbott", "Núñez", "O'Brien"), ui.rows.map { it.last_name })
        assertEquals(listOf("A", "N", "O"), ui.sections.map { it.first })
        assertFalse(ui.offline)
        assertFalse(ui.loading)
        assertEquals(T1, ui.cachedAt)
        assertEquals(ROLODEX_OPTIONS, ui.options)
        assertEquals(3, ui.counts[FILTER_ALL])

        val cached = db.meta().get(ROLODEX_META_KEY)!!.value
        assertTrue(cached.contains("p-abbott"))
        assertFalse(cached.contains("email"))
        assertFalse(cached.contains("phone"))
    }

    @Test fun aLoadThatFailsOfflineShowsTheCachedListWithItsTime() = runTest {
        val db = newDb()
        build(onlineApi(), db, now = T1)
        val offline = onlineApi().apply { rolodexWorkersResult = { throw ApiError(0, "network") } }
        val vm = build(offline, db, now = T2)
        val ui = vm.state.value
        assertTrue(ui.offline)
        assertEquals(T1, ui.cachedAt)
        assertEquals(listOf("Abbott", "Núñez", "O'Brien"), ui.rows.map { it.last_name })
        assertNull(ui.listError)
        // Offline, the cached options still build the filter chips.
        assertEquals(listOf(FILTER_ALL, "active", "standby", "blacklist", FILTER_NO_PHOTO), ui.filters.map { it.first })
    }

    @Test fun aLoadThatFailsOfflineWithoutACacheSaysSo() = runTest {
        val vm = build(onlineApi().apply { rolodexWorkersResult = { throw ApiError(0, "network") } })
        val ui = vm.state.value
        assertTrue(ui.offline)
        assertNull(ui.cachedAt)
        assertTrue(ui.rows.isEmpty())
        assertEquals("No connection. Try again when you're back online.", ui.listError)
    }

    @Test fun aRefusedLoadDropsTheListAndTheCache() = runTest {
        val db = newDb()
        build(onlineApi(), db)
        val vm = build(onlineApi().apply { rolodexWorkersResult = { throw ApiError(403, "forbidden") } }, db)
        val ui = vm.state.value
        assertTrue(ui.rows.isEmpty())
        assertFalse(ui.offline)
        assertEquals("Your account can't use the Rolodex.", ui.listError)
        assertNull(db.meta().get(ROLODEX_META_KEY))
    }

    @Test fun refreshReadsTheListAgainAndClearsOffline() = runTest {
        val api = onlineApi()
        val db = newDb()
        build(api, db, now = T1)
        api.rolodexWorkersResult = { throw ApiError(0, "network") }
        val vm = build(api, db, now = T2)
        assertTrue(vm.state.value.offline)
        api.rolodexWorkersResult = { RolodexList("now", listOf(abbott)) }
        vm.refresh(); settle { !vm.state.value.loading }
        assertFalse(vm.state.value.offline)
        assertEquals(T2, vm.state.value.cachedAt)
        assertEquals(listOf("p-abbott"), vm.state.value.rows.map { it.person_id })
    }

    // ── search and filters ──

    @Test fun searchFiltersAndCountsFollowTheFoldRules() = runTest {
        val vm = build(onlineApi())
        vm.setQuery("obr")
        assertEquals(listOf("p-obrien"), vm.state.value.sections.flatMap { it.second }.map { it.person_id })
        assertEquals(1, vm.state.value.counts[FILTER_ALL])
        vm.setQuery("nunez")
        assertEquals(listOf("p-nunez"), vm.state.value.sections.flatMap { it.second }.map { it.person_id })
        vm.setQuery("rig sum")
        assertEquals(listOf("p-abbott"), vm.state.value.sections.flatMap { it.second }.map { it.person_id })

        vm.setQuery("")
        vm.setFilter("blacklist")
        assertEquals(listOf("p-obrien"), vm.state.value.sections.flatMap { it.second }.map { it.person_id })
        assertEquals(mapOf(FILTER_ALL to 3, "active" to 1, "standby" to 1, "blacklist" to 1, FILTER_NO_PHOTO to 1), vm.state.value.counts)
        vm.setFilter(FILTER_NO_PHOTO)
        assertEquals(listOf("p-nunez"), vm.state.value.sections.flatMap { it.second }.map { it.person_id })
    }

    // ── the worker page ──

    @Test fun selectLoadsTheWorkerPage() = runTest {
        val api = onlineApi()
        val vm = build(api)
        vm.select("p-abbott"); settle { !vm.state.value.detailLoading }
        assertEquals("p-abbott", vm.state.value.selectedId)
        assertEquals("ann@example.com", vm.state.value.detail?.email)
        assertTrue("rolodexWorker:p-abbott" in api.calls)
        vm.select(null)
        assertNull(vm.state.value.selectedId)
        assertNull(vm.state.value.detail)
    }

    @Test fun startEditDoesNothingWhenThePersonCantBeEdited() = runTest {
        val api = onlineApi().apply { rolodexWorkerResult = { rolodexDetail(abbott, canEdit = false) } }
        val vm = build(api)
        vm.select("p-abbott"); settle { !vm.state.value.detailLoading }
        assertNotNull(vm.state.value.detail)                    // the page is there; only Edit is refused
        vm.startEdit()
        assertNull(vm.state.value.editing)
    }

    @Test fun startEditDoesNothingOffline() = runTest {
        val db = newDb()
        build(onlineApi(), db)
        val vm = build(onlineApi().apply { rolodexWorkersResult = { throw ApiError(0, "network") } }, db)
        vm.select("p-abbott"); settle { !vm.state.value.detailLoading }
        assertNotNull(vm.state.value.detail)                    // the page is there; only Edit is refused
        vm.startEdit()
        assertNull(vm.state.value.editing)
    }

    @Test fun theStatusStaysPutWhenItCantBeChanged() = runTest {
        val vm = build(onlineApi().apply { rolodexWorkerResult = { rolodexDetail(abbott, canChangeStatus = false) } })
        val edit = editing(vm)
        vm.updateEdit(edit.copy(status = "blacklist", statusNote = "No show", jobTitle = "Lead"))
        assertEquals("standby", vm.state.value.editing?.status)
        assertEquals("", vm.state.value.editing?.statusNote)
        assertEquals("Lead", vm.state.value.editing?.jobTitle)
    }

    @Test fun saveSendsOnlyTheChangedFieldsAndUpdatesTheListRosterAndCache() = runTest {
        val db = newDb()
        db.people().insertAll(listOf(PersonEntity("p-abbott", "Ann Abbott", "Ann", "Abbott", null, rfidTag = "TAG-1", isWorker = true, hasAccount = false, badgeUid = "BADGE-1")))
        val api = onlineApi()
        val before = rolodexDetail(abbott)
        api.rolodexUpdateResult = { _, _ -> before.copy(job_title = "Lead rigger", phone = null) }
        val vm = build(api, db)
        val edit = editing(vm).copy(jobTitle = "Lead rigger", phone = "")
        vm.updateEdit(edit)
        vm.save(); settle { !vm.state.value.saving }
        settle { cached(db)?.contains("Lead rigger") == true }

        assertEquals(listOf("p-abbott" to buildPatch(before, edit)), api.rolodexUpdates)
        assertEquals(buildJsonObject { put("job_title", JsonPrimitive("Lead rigger")); put("phone", JsonNull) }, api.rolodexUpdates.single().second)
        val ui = vm.state.value
        assertNull(ui.editing)
        assertFalse(ui.saving)
        assertNull(ui.error)
        assertEquals("Lead rigger", ui.detail?.job_title)
        assertEquals("Lead rigger", ui.rows.first { it.person_id == "p-abbott" }.job_title)
        // The Time Clock's roster has the new title and keeps the tag and badge the detail doesn't carry.
        val person = db.people().get("p-abbott")!!
        assertEquals("Lead rigger", person.jobTitle)
        assertEquals("TAG-1", person.rfidTag)
        assertEquals("BADGE-1", person.badgeUid)
        assertEquals("SC-1042", person.externalId)
        // The offline copy follows the edit, still without contact details.
        val cached = db.meta().get(ROLODEX_META_KEY)!!.value
        assertTrue(cached.contains("Lead rigger"))
        assertFalse(cached.contains("ann@example.com"))
        assertFalse(cached.contains("email"))
    }

    @Test fun aSaveOfAPersonNotInTheRosterAddsThemAsAWorker() = runTest {
        val db = newDb()
        val api = onlineApi().apply { rolodexUpdateResult = { _, _ -> rolodexDetail(nunez).copy(job_title = "Driver") } }
        val vm = build(api, db)
        vm.updateEdit(editing(vm, "p-nunez").copy(jobTitle = "Driver"))
        vm.save(); settle { !vm.state.value.saving }
        val person = db.people().get("p-nunez")!!
        assertTrue(person.isWorker)
        assertEquals("Driver", person.jobTitle)
        assertNull(person.rfidTag)
    }

    /** Review Focus 3: a double tap on Save changes sends one request. */
    @Test fun aSecondSaveWhileSavingSendsOneRequest() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = onlineApi()
        api.rolodexUpdateResult = { _, _ -> gate.await(); rolodexDetail(abbott).copy(job_title = "Lead") }
        val vm = build(api)
        vm.updateEdit(editing(vm).copy(jobTitle = "Lead"))
        vm.save()
        vm.save(); settle()
        vm.save(); settle()
        assertEquals(1, api.rolodexUpdates.size)
        assertTrue(vm.state.value.saving)
        gate.complete(Unit); settle { !vm.state.value.saving }
        assertFalse(vm.state.value.saving)
        assertNull(vm.state.value.editing)
        vm.save(); settle()                                    // nothing left to save
        assertEquals(1, api.rolodexUpdates.size)
    }

    /** Review Focus 4: a failed save keeps everything typed and shows the spec's words. */
    @Test fun aFailedSaveKeepsWhatWasTypedAndShowsTheSpecCopy() = runTest {
        val cases = listOf(
            ApiError(0, "network") to "No connection. Try again when you're back online.",
            ApiError(423, "read_only_mode") to "The system is in read-only mode, so changes can't be saved right now.",
            ApiError(409, "email_in_use") to "Another person already uses that email.",
            ApiError(403, "rank_too_low") to "This person has a portal login ranked above yours.",
            ApiError(403, "cannot_target_self") to "You can't change your own status.",
        )
        for ((failure, copy) in cases) {
            val api = onlineApi().apply { rolodexUpdateResult = { _, _ -> throw failure } }
            val vm = build(api)
            val typed = editing(vm).copy(firstName = "Annie", email = "annie@example.com", jobTitle = "Lead rigger", trade = "Rigging")
            vm.updateEdit(typed)
            vm.save(); settle { !vm.state.value.saving }
            val ui = vm.state.value
            assertEquals(failure.code, typed, ui.editing)
            assertEquals(failure.code, copy, ui.error)
            assertFalse(failure.code, ui.saving)
            assertEquals(failure.code, "Ann", ui.detail?.first_name)
            vm.save(); settle { !vm.state.value.saving }        // Try again sends again
            assertEquals(failure.code, 2, api.rolodexUpdates.size)
        }
    }

    @Test fun aBlacklistWithoutANoteIsStoppedBeforeSending() = runTest {
        val api = onlineApi()
        val vm = build(api)
        val typed = editing(vm).copy(status = "blacklist", statusNote = " ")
        vm.updateEdit(typed)
        vm.save(); settle()
        assertTrue(api.rolodexUpdates.isEmpty())
        assertEquals("Add a note to blacklist someone.", vm.state.value.error)
        assertEquals(typed, vm.state.value.editing)
    }

    /** A stray tap on another row can't throw away an open form: Save or Cancel first. */
    @Test fun anOpenFormHoldsTheSelection() = runTest {
        val vm = build(onlineApi())
        val typed = editing(vm).copy(jobTitle = "Lead")
        vm.updateEdit(typed)
        vm.select("p-nunez"); settle()
        assertEquals("p-abbott", vm.state.value.selectedId)
        assertEquals(typed, vm.state.value.editing)
        vm.cancelEdit()
        vm.select("p-nunez"); settle { !vm.state.value.detailLoading }
        assertEquals("p-nunez", vm.state.value.selectedId)
    }

    @Test fun aMalformedEmailIsStoppedBeforeSending() = runTest {
        val api = onlineApi()
        val vm = build(api)
        val typed = editing(vm).copy(email = "ana@example")
        vm.updateEdit(typed)
        vm.save(); settle()
        assertTrue(api.rolodexUpdates.isEmpty())
        assertEquals("Enter a valid email address.", vm.state.value.error)
        assertEquals(typed, vm.state.value.editing)
    }

    @Test fun aSaveWithNothingChangedClosesTheFormWithoutARequest() = runTest {
        val api = onlineApi()
        val vm = build(api)
        editing(vm)
        vm.save(); settle()
        assertTrue(api.rolodexUpdates.isEmpty())
        assertNull(vm.state.value.editing)
    }

    /** Leaving the screen mid-save can't half-cancel the write: the PATCH and the roster upsert finish. */
    @Test fun aSaveRunsToTheEndAfterTheScreenGoes() = runTest {
        val db = newDb()
        val gate = CompletableDeferred<Unit>()
        val api = onlineApi()
        api.rolodexUpdateResult = { _, _ -> gate.await(); rolodexDetail(abbott).copy(job_title = "Lead") }
        val screen = CoroutineScope(backgroundScope.coroutineContext + Job(backgroundScope.coroutineContext[Job]))
        val vm = build(api, db, scope = screen)
        vm.updateEdit(editing(vm).copy(jobTitle = "Lead"))
        vm.save(); settle()
        screen.cancel()
        gate.complete(Unit)
        settle { runBlocking { db.people().get("p-abbott") } != null }
        assertEquals("Lead", db.people().get("p-abbott")?.jobTitle)
    }

    // ── copy and helpers ──

    @Test fun errorTextUsesTheSpecWords() {
        // A scope that is already gone: nothing loads, only the words are under test.
        val vm = RolodexViewModel(FakeKioskApi(), newDb(), scopeOverride = CoroutineScope(Job()).also { it.cancel() }, clock = { T1 })
        assertEquals("Your account can't use the Rolodex.", vm.errorText("forbidden"))
        assertEquals("Your account can't use the Rolodex.", vm.errorText("move_locked"))
        assertEquals("The system is in read-only mode, so changes can't be saved right now.", vm.errorText("read_only_mode"))
        assertEquals("Another person already uses that email.", vm.errorText("email_in_use"))
        assertEquals("This person has a portal login ranked above yours.", vm.errorText("rank_too_low"))
        assertEquals("You can't change your own status.", vm.errorText("cannot_target_self"))
        assertEquals("Add a note to blacklist someone.", vm.errorText("blacklist_requires_note"))
        for (code in listOf("file_too_large", "empty_file", "invalid_file_type", "unreadable_image", "image_too_large")) {
            assertEquals(code, "That photo couldn't be used. Take or choose another one.", vm.errorText(code))
        }
        assertEquals("No connection. Try again when you're back online.", vm.errorText("network"))
        assertEquals("Something went wrong. Try again.", vm.errorText("unknown_error"))
        assertEquals("Something went wrong. Try again.", vm.errorText(null))
    }

    @Test fun theOfflineBannerNamesTheTimeAndTheDayWhenItIsntToday() {
        val zone = ZoneId.of("America/Chicago")
        assertEquals(
            "Offline · showing the list from 3:42 PM. Changes need a connection.",
            offlineBannerText(T1, now = T2, zone = zone),
        )
        assertEquals(
            "Offline · showing the list from Oct 22, 3:42 PM. Changes need a connection.",
            offlineBannerText(T1, now = Instant.parse("2026-10-23T15:00:00Z"), zone = zone),
        )
    }

    /** The form offers the worker's own status and company even when the portal has retired or archived them. */
    @Test fun theFormKeepsARetiredStatusAndAnArchivedCompany() {
        val gone = rolodexDetail(abbott.copy(status = "on_leave", status_label = "On leave", company = RolodexCompany("c-old", "Old Crew")))
        assertEquals(listOf("active", "standby", "blacklist", "on_leave"), editStatuses(ROLODEX_OPTIONS, gone).map { it.first })
        assertEquals("On leave", editStatuses(ROLODEX_OPTIONS, gone).last().second)
        assertEquals(listOf(null, "c-Summit Crew", "c-Peak", "c-old"), companyChoices(ROLODEX_OPTIONS, gone).map { it.first })
        assertEquals("None", companyChoices(ROLODEX_OPTIONS, gone).first().second)
        val here = rolodexDetail(abbott)
        assertEquals(3, editStatuses(ROLODEX_OPTIONS, here).size)
        assertEquals(3, companyChoices(ROLODEX_OPTIONS, here).size)
        assertEquals(listOf(null, "L1", "L3"), levelChoices(ROLODEX_OPTIONS, here).map { it.first })
    }

    // ── the cache leaves with the session ──

    @Test fun signingOutClearsTheCachedList() = runBlocking<Unit> {
        val c = testContainer(api = FakeKioskApi())
        c.db.meta().put(MetaEntity(ROLODEX_META_KEY, "{}"))
        c.logout()
        assertNull(c.db.meta().get(ROLODEX_META_KEY))
    }

    @Test fun resetAppClearsTheCachedList() = runBlocking<Unit> {
        val c = testContainer(api = FakeKioskApi())
        c.db.meta().put(MetaEntity(ROLODEX_META_KEY, "{}"))
        c.resetApp(clearLocalData = {})
        assertNull(c.db.meta().get(ROLODEX_META_KEY))
    }
}
