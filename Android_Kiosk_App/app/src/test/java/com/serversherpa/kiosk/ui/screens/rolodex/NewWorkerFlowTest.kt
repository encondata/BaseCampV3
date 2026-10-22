package com.serversherpa.kiosk.ui.screens.rolodex

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexCreateIn
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexDuplicatesIn
import com.serversherpa.kiosk.core.model.RolodexList
import com.serversherpa.kiosk.core.model.RolodexMatch
import com.serversherpa.kiosk.core.model.RolodexPhotoOut
import com.serversherpa.kiosk.core.people.RolodexEdit
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.ROLODEX_META_KEY
import com.serversherpa.kiosk.data.rolodex.RolodexCacheStore
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * "+ New" (spec §3.6, §3.7, §3.16, §4.2): details, the duplicate check, the required photo with
 * its "Continue without photo" confirmation, Position your photo, Create worker, then the upload.
 * Native graphics: the photo is a real bitmap rendered to a real JPEG.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NewWorkerFlowTest {
    @get:Rule val fonts = NativeFontsSettled()

    private val abbott = rolodexRow("p-abbott", "Ann", "Abbott", job = "Rigger", company = "Summit Crew")
    private val ortiz = rolodexRow("p-ortiz", "Ana", "Ortiz", job = "Rigger", company = "Summit Crew")
    private val reed = rolodexRow("p-reed", "Marcus", "Reed", job = "Rigger", company = "Summit Crew", hasPhoto = false)
    /** The create's answer: Marcus Reed, a worker with no photo yet. */
    private val created: RolodexDetail = rolodexDetail(reed)

    private val marcus = RolodexEdit(
        firstName = " Marcus ", lastName = "Reed", jobTitle = "Rigger", phone = "(312) 555-0199",
        email = "marcus@example.com", partnerId = "c-Summit Crew", trade = "Rigging", level = "L1",
    )

    private val workerMatch = RolodexMatch("p-ortiz", "Ana Ortiz", "Rigger", "Summit Crew", is_worker = true, matched_on = listOf("name"))
    private val staffMatch = RolodexMatch("p-staff", "Marcus Reed", "Dispatcher", "ServerSherpa", is_worker = false, has_account = true, matched_on = listOf("name"))
    private val emailMatch = RolodexMatch("p-mr", "Marc Reed", null, null, is_worker = true, matched_on = listOf("email"))

    private var admin = true

    private fun TestScope.settle(done: () -> Boolean = { true }) {
        repeat(6) { Thread.sleep(50); runCurrent() }
        val deadline = System.nanoTime() + 10_000_000_000L
        while (!done() && System.nanoTime() < deadline) { Thread.sleep(50); runCurrent() }
    }

    private fun newDb() = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())

    private fun api() = FakeKioskApi().apply {
        rolodexWorkersResult = { RolodexList("now", listOf(ortiz, abbott)) }
        rolodexOptionsResult = { ROLODEX_OPTIONS }
        rolodexWorkerResult = { id -> rolodexDetail(listOf(ortiz, abbott, reed).first { it.person_id == id }) }
        rolodexCreateResult = { created }
        rolodexPhotoResult = { _, _ -> RolodexPhotoOut("https://files/p-reed-v2.jpg", "v2") }
    }

    private fun TestScope.build(api: FakeKioskApi, db: KioskDatabase = newDb()): RolodexViewModel {
        val vm = RolodexViewModel(api, db, RolodexCacheStore(db) { admin }, scopeOverride = backgroundScope, clock = { Instant.parse("2026-10-22T20:42:00Z") })
        settle { !vm.state.value.loading }
        val ui = vm.state.value
        if (!ui.offline && ui.listError == null) settle { runBlocking { db.meta().get(ROLODEX_META_KEY) } != null }
        return vm
    }

    private val flowState get() = vmUnderTest.newWorker.state.value
    private lateinit var vmUnderTest: RolodexViewModel

    /** "+ New" with Marcus Reed typed in. */
    private fun TestScope.started(api: FakeKioskApi, db: KioskDatabase = newDb()): RolodexViewModel {
        val vm = build(api, db)
        vmUnderTest = vm
        vm.startNewWorker()
        assertNotNull(vm.newWorker.state.value)
        vm.newWorker.update(marcus)
        return vm
    }

    /** Next with no matches: the photo step. */
    private fun TestScope.atPhoto(vm: RolodexViewModel) {
        vm.newWorker.next(); settle { vm.newWorker.state.value?.checking == false }
        assertEquals(NewWorkerStage.PHOTO, vm.newWorker.state.value?.stage)
    }

    /** A picture: 800×600, red left, blue right. */
    private fun picture(): Bitmap = Bitmap.createBitmap(800, 600, Bitmap.Config.ARGB_8888).also { b ->
        val canvas = Canvas(b)
        canvas.drawRect(0f, 0f, 400f, 600f, Paint().apply { color = Color.RED })
        canvas.drawRect(400f, 0f, 800f, 600f, Paint().apply { color = Color.BLUE })
    }

    /** A photo taken and positioned: the crop step. */
    private fun TestScope.atCrop(vm: RolodexViewModel) {
        atPhoto(vm)
        vm.newWorker.usePhoto { picture() }; settle { vm.newWorker.state.value?.loadingPhoto == false }
        assertEquals(NewWorkerStage.CROP, vm.newWorker.state.value?.stage)
        assertNotNull(vm.newWorker.state.value?.crop)
    }

    private val sentMarcus = RolodexCreateIn(
        first_name = "Marcus", last_name = "Reed", job_title = "Rigger", phone = "(312) 555-0199",
        email = "marcus@example.com", partner_id = "c-Summit Crew", trade = "Rigging", level = "L1",
    )

    // ── starting ──

    @Test fun onlyAnOnlineAdminWithTheListCanStart() = runTest {
        val db = newDb()
        build(api(), db)
        val offline = build(api().apply { rolodexWorkersResult = { throw ApiError(0, "network") } }, db)
        assertFalse(offline.state.value.canStartNewWorker)
        offline.startNewWorker()
        assertNull(offline.newWorker.state.value)

        val refused = build(api().apply { rolodexWorkersResult = { throw ApiError(403, "forbidden") } })
        refused.startNewWorker()
        assertNull(refused.newWorker.state.value)

        val vm = build(api())
        vm.select("p-abbott"); settle { !vm.state.value.detailLoading }
        vm.startEdit()
        vm.startNewWorker()                                     // an open Edit form holds the screen
        assertNull(vm.newWorker.state.value)
        vm.cancelEdit()
        assertTrue(vm.state.value.canStartNewWorker)
        vm.startNewWorker()
        assertEquals(NewWorkerStage.DETAILS, vm.newWorker.state.value?.stage)
        assertEquals(RolodexEdit(), vm.newWorker.state.value?.form)
    }

    // ── details and duplicates ──

    @Test fun nextRunsTheDuplicateCheckThenThePhotoStep() = runTest {
        val api = api()
        val vm = started(api)
        atPhoto(vm)
        assertEquals(listOf(RolodexDuplicatesIn("Marcus", "Reed", null, "marcus@example.com", "(312) 555-0199")), api.rolodexDuplicateBodies)
        assertTrue(api.rolodexCreates.isEmpty())
        assertNull(flowState?.error)
    }

    @Test fun nextChecksTheFormFirst() = runTest {
        val api = api()
        val vm = started(api)
        vm.newWorker.update(marcus.copy(lastName = " "))
        vm.newWorker.next(); settle()
        assertEquals("First and last name are required.", flowState?.error)
        vm.newWorker.update(marcus.copy(email = "marcus@example"))
        vm.newWorker.next(); settle()
        assertEquals("Enter a valid email address.", flowState?.error)
        assertEquals(NewWorkerStage.DETAILS, flowState?.stage)
        assertTrue(api.rolodexDuplicateBodies.isEmpty())
    }

    @Test fun aFailedCheckKeepsTheFormAndSaysWhy() = runTest {
        val vm = started(api().apply { rolodexDuplicatesResult = { throw ApiError(0, "network") } })
        vm.newWorker.next(); settle { flowState?.checking == false }
        assertEquals(NewWorkerStage.DETAILS, flowState?.stage)
        assertEquals(marcus, flowState?.form)
        assertEquals("No connection. Try again when you're back online.", flowState?.error)
    }

    @Test fun aWorkerMatchOffersOpenAndCreateAnyway() = runTest {
        val api = api().apply { rolodexDuplicatesResult = { listOf(workerMatch) } }
        val vm = started(api)
        vm.newWorker.next(); settle { flowState?.checking == false }
        val s = flowState!!
        assertTrue(s.showMatches)
        assertEquals(listOf(workerMatch), s.matches)
        assertTrue(canOpen(workerMatch))
        assertNull(matchNote(workerMatch))
        assertTrue(s.canCreateAnyway)
        assertNull(s.blockText)

        vm.newWorker.createAnyway()
        assertFalse(flowState!!.showMatches)
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        assertTrue(flowState!!.allowDuplicate)
        // The duplicate is allowed on the create that follows (here without a photo, after the confirmation).
        vm.newWorker.continueWithoutPhoto()
        vm.newWorker.createWithoutPhoto(); settle { flowState == null }
        assertEquals(listOf(sentMarcus.copy(allow_duplicate = true, photo_skipped = true)), api.rolodexCreates)
    }

    @Test fun openGoesToThatWorkerInsteadOfANewOne() = runTest {
        val api = api().apply { rolodexDuplicatesResult = { listOf(workerMatch) } }
        val vm = started(api)
        vm.newWorker.next(); settle { flowState?.checking == false }
        vm.newWorker.openMatch("p-ortiz"); settle { !vm.state.value.detailLoading }
        assertNull(flowState)
        assertEquals("p-ortiz", vm.state.value.selectedId)
        assertEquals("Ana", vm.state.value.detail?.first_name)
        assertTrue(api.rolodexCreates.isEmpty())
    }

    @Test fun aNonWorkerMatchSaysToAddTheRoleInThePortalWithNoOpen() = runTest {
        val api = api().apply { rolodexDuplicatesResult = { listOf(staffMatch) } }
        val vm = started(api)
        vm.newWorker.next(); settle { flowState?.checking == false }
        assertTrue(flowState!!.showMatches)
        assertFalse(canOpen(staffMatch))
        assertEquals("Already in the portal, not a worker. Add the worker role there.", matchNote(staffMatch))
        vm.newWorker.openMatch("p-staff"); settle()
        assertNotNull(flowState)                                // no Open for them
        assertNull(vm.state.value.selectedId)
        assertTrue(flowState!!.canCreateAnyway)                 // a name match can still be created
    }

    @Test fun anEmailMatchBlocksCreateAnyway() = runTest {
        val api = api().apply { rolodexDuplicatesResult = { body -> if (body.email != null) listOf(emailMatch) else emptyList() } }
        val vm = started(api)
        vm.newWorker.next(); settle { flowState?.checking == false }
        val s = flowState!!
        assertTrue(s.showMatches)
        assertFalse(s.canCreateAnyway)
        assertEquals("That email belongs to Marc Reed. Change or clear the email.", s.blockText)
        vm.newWorker.createAnyway()
        assertTrue(flowState!!.showMatches)                     // refused
        assertFalse(flowState!!.allowDuplicate)
        vm.newWorker.create(byteArrayOf(1, 2, 3), photoSkipped = false, allowDuplicate = true); settle()
        assertTrue(api.rolodexCreates.isEmpty())                // no way around it

        vm.newWorker.dismissMatches()
        assertEquals(NewWorkerStage.DETAILS, flowState?.stage)
        assertEquals("That email belongs to Marc Reed. Change or clear the email.", flowState?.error)
        vm.newWorker.update(marcus.copy(email = ""))
        atPhoto(vm)
    }

    // ── the photo ──

    @Test fun continueWithoutPhotoAsksFirstAndOnlyThenSkips() = runTest {
        val api = api()
        val vm = started(api)
        atPhoto(vm)
        vm.newWorker.createWithoutPhoto(); settle()            // not asked yet
        vm.newWorker.create(null, photoSkipped = true, allowDuplicate = false); settle()
        assertTrue(api.rolodexCreates.isEmpty())

        vm.newWorker.continueWithoutPhoto()
        assertTrue(flowState!!.confirmNoPhoto)
        assertEquals("Create Marcus Reed without a photo?", flowState!!.confirmTitle)
        vm.newWorker.takePhotoInstead()                         // the default: back to the camera
        assertFalse(flowState!!.confirmNoPhoto)
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        vm.newWorker.createWithoutPhoto(); settle()
        assertTrue(api.rolodexCreates.isEmpty())

        vm.newWorker.continueWithoutPhoto()
        vm.newWorker.createWithoutPhoto(); settle { flowState == null }
        assertEquals(listOf(sentMarcus.copy(photo_skipped = true)), api.rolodexCreates)
        assertTrue(api.rolodexPhotos.isEmpty())
        assertEquals("p-reed", vm.state.value.selectedId)       // the new worker's page opens
    }

    @Test fun aNonPictureStaysOnThePhotoStep() = runTest {
        val vm = started(api())
        atPhoto(vm)
        vm.newWorker.usePhoto { decodeForCrop("not a picture".toByteArray()) }; settle { flowState?.loadingPhoto == false }
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        assertNull(flowState?.crop)
        assertEquals("That photo couldn't be used. Take or choose another one.", flowState?.error)
    }

    // ── the camera (M3, Task 7 minor 2) ──

    /** M3: a capture on its way holds "Continue without photo": a create can't skip the photo being taken. */
    @Test fun aCaptureInFlightBlocksContinueWithoutPhoto() = runTest {
        val api = api()
        val vm = started(api)
        atPhoto(vm)
        assertTrue(vm.newWorker.captureStarted())
        assertTrue(flowState!!.capturing)
        assertTrue(flowState!!.busy)
        assertFalse(vm.newWorker.captureStarted())             // one capture at a time
        vm.newWorker.flip()                                     // no switching cameras mid-shot
        assertFalse(flowState!!.front)
        vm.newWorker.continueWithoutPhoto()
        assertFalse(flowState!!.confirmNoPhoto)
        vm.newWorker.createWithoutPhoto(); settle()
        vm.newWorker.create(null, photoSkipped = true, allowDuplicate = false); settle()
        assertTrue(api.rolodexCreates.isEmpty())

        // The capture lands: Position your photo, with no confirmation over it.
        vm.newWorker.usePhoto { picture() }; settle { flowState?.loadingPhoto == false }
        assertEquals(NewWorkerStage.CROP, flowState?.stage)
        assertFalse(flowState!!.capturing)
        assertFalse(flowState!!.confirmNoPhoto)
    }

    @Test fun aFailedCaptureFreesTheStep() = runTest {
        val vm = started(api())
        atPhoto(vm)
        vm.newWorker.captureStarted()
        vm.newWorker.captureFailed()
        assertFalse(flowState!!.capturing)
        assertFalse(flowState!!.busy)
        vm.newWorker.continueWithoutPhoto()
        assertTrue(flowState!!.confirmNoPhoto)
    }

    /** While a capture or a pick is decoded, "Continue without photo" waits too. */
    @Test fun aDecodeInFlightBlocksContinueWithoutPhoto() = runTest {
        val gate = CompletableDeferred<Unit>()
        val vm = started(api())
        atPhoto(vm)
        vm.newWorker.usePhoto { gate.await(); picture() }
        assertTrue(flowState!!.loadingPhoto)
        vm.newWorker.continueWithoutPhoto()
        assertFalse(flowState!!.confirmNoPhoto)
        gate.complete(Unit); settle { flowState?.loadingPhoto == false }
        assertEquals(NewWorkerStage.CROP, flowState?.stage)
        assertFalse(flowState!!.confirmNoPhoto)
    }

    /** Belt and braces: a photo that lands under the confirmation closes it, and no create may then skip it. */
    @Test fun aPhotoThatLandsUnderTheConfirmationClosesIt() = runTest {
        val api = api()
        val vm = started(api)
        atPhoto(vm)
        vm.newWorker.continueWithoutPhoto()
        assertTrue(flowState!!.confirmNoPhoto)
        vm.newWorker.usePhoto { picture() }; settle { flowState?.loadingPhoto == false }
        assertEquals(NewWorkerStage.CROP, flowState?.stage)
        assertFalse(flowState!!.confirmNoPhoto)
        vm.newWorker.createWithoutPhoto(); settle()
        vm.newWorker.create(null, photoSkipped = true, allowDuplicate = false); settle()
        assertTrue(api.rolodexCreates.isEmpty())
    }

    /** Task 7 minor 2: Flip holds across Retake and Back within the flow; a new flow starts on the back camera. */
    @Test fun flipSurvivesRetakeUntilTheFlowEnds() = runTest {
        val vm = started(api())
        atPhoto(vm)
        assertFalse(flowState!!.front)
        vm.newWorker.flip()
        assertTrue(flowState!!.front)
        vm.newWorker.usePhoto { picture() }; settle { flowState?.loadingPhoto == false }
        assertEquals(NewWorkerStage.CROP, flowState?.stage)
        vm.newWorker.retake()
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        assertTrue(flowState!!.front)
        vm.newWorker.backToDetails()
        vm.newWorker.next(); settle { flowState?.checking == false }
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        assertTrue(flowState!!.front)
        vm.newWorker.flip()
        assertFalse(flowState!!.front)
        vm.newWorker.flip()
        vm.newWorker.cancel()
        vm.startNewWorker()
        assertFalse(flowState!!.front)
    }

    @Test fun retakeAndBackKeepTheDetailsAndThePhoto() = runTest {
        val vm = started(api())
        atCrop(vm)
        val crop = flowState!!.crop
        vm.newWorker.backToDetails()
        assertEquals(NewWorkerStage.DETAILS, flowState?.stage)
        assertEquals(marcus, flowState?.form)
        vm.newWorker.next(); settle { flowState?.checking == false }
        assertEquals(NewWorkerStage.CROP, flowState?.stage)     // straight back to the photo already positioned
        assertTrue(crop === flowState?.crop)
        vm.newWorker.retake()
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        assertNull(flowState?.crop)
        assertEquals(marcus, flowState?.form)
    }

    // ── Create worker ──

    @Test fun aCreateWithAPhotoUploadsItOnceAndOpensThePage() = runTest {
        val db = newDb()
        val api = api()
        val vm = started(api, db)
        atCrop(vm)
        vm.newWorker.createWithPhoto(); settle { flowState == null }

        assertEquals(listOf(sentMarcus), api.rolodexCreates)
        val (id, jpeg) = api.rolodexPhotos.single()
        assertEquals("p-reed", id)
        val sent = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
        assertEquals(512, sent.width)
        assertEquals(512, sent.height)
        val ui = vm.state.value
        assertEquals("p-reed", ui.selectedId)
        assertEquals("v2", ui.detail?.photo_version)
        assertTrue(ui.detail!!.has_photo)
        // The list has them in last-name order, with the new photo; no reload.
        assertEquals(listOf("p-abbott", "p-ortiz", "p-reed"), ui.rows.map { it.person_id })
        assertEquals("v2", ui.rows.last().photo_version)
        assertEquals(1, api.calls.count { it == "rolodexWorkers" })
        // The Time Clock finds them now.
        val person = db.people().get("p-reed")!!
        assertTrue(person.isWorker)
        assertEquals("Marcus Reed", person.displayName)
        settle { runBlocking { db.meta().get(ROLODEX_META_KEY) }?.value?.contains("p-reed") == true }
        assertNull(vm.photos.state.value.failures["p-reed"])
    }

    /** Review Focus 3: a double tap on Create worker sends one POST. */
    @Test fun aDoubleTapOnCreateWorkerSendsOnePost() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = api().apply { rolodexCreateResult = { gate.await(); created } }
        val vm = started(api)
        atCrop(vm)
        vm.newWorker.createWithPhoto()
        vm.newWorker.createWithPhoto(); settle { api.rolodexCreates.isNotEmpty() }
        vm.newWorker.createWithPhoto()
        vm.newWorker.create(ByteArray(3), photoSkipped = false, allowDuplicate = false)
        vm.newWorker.continueWithoutPhoto()
        vm.newWorker.createWithoutPhoto(); settle()
        assertEquals(1, api.rolodexCreates.size)
        assertTrue(flowState!!.creating)
        gate.complete(Unit); settle { flowState == null }
        assertEquals(1, api.rolodexCreates.size)
        assertEquals(1, api.rolodexPhotos.size)
    }

    /** Review Focus 5: the worker is saved, the photo isn't: their page says so, with Try again. */
    @Test fun anUploadFailingAfterTheCreateOpensTheWorkerWithTryAgain() = runTest {
        var upload: suspend () -> RolodexPhotoOut = { throw ApiError(0, "network") }
        val api = api().apply { rolodexPhotoResult = { _, _ -> upload() } }
        val vm = started(api)
        atCrop(vm)
        vm.newWorker.createWithPhoto(); settle { flowState == null }

        assertEquals("p-reed", vm.state.value.selectedId)
        assertEquals("Marcus Reed was saved, but the photo didn't upload.", vm.photos.failureText("p-reed"))
        assertFalse(vm.state.value.detail!!.has_photo)
        val first = api.rolodexPhotos.single().second

        vm.retryPhoto("p-reed"); settle { vm.photos.state.value.failures["p-reed"]?.retrying == false }
        assertEquals(2, api.rolodexPhotos.size)
        assertEquals("Marcus Reed was saved, but the photo didn't upload.", vm.photos.failureText("p-reed"))
        assertEquals("No connection. Try again when you're back online.", vm.photos.state.value.failures["p-reed"]?.retryError)

        upload = { RolodexPhotoOut("https://files/p-reed-v2.jpg", "v2") }
        vm.retryPhoto("p-reed"); settle { vm.photos.failureText("p-reed") == null }
        assertEquals(3, api.rolodexPhotos.size)
        assertArrayEquals(first, api.rolodexPhotos.last().second)   // the same photo
        assertNull(vm.photos.failureText("p-reed"))
        assertEquals("v2", vm.state.value.detail?.photo_version)
        assertEquals("v2", vm.state.value.rows.first { it.person_id == "p-reed" }.photo_version)
    }

    /** Spec §3.15: Try again needs a connection. */
    @Test fun tryAgainIsOffWhileOffline() = runTest {
        val api = api().apply { rolodexPhotoResult = { _, _ -> throw ApiError(0, "network") } }
        val vm = started(api)
        atCrop(vm)
        vm.newWorker.createWithPhoto(); settle { flowState == null }
        api.rolodexWorkersResult = { throw ApiError(0, "network") }
        vm.refresh(); settle { vm.state.value.offline }
        vm.retryPhoto("p-reed"); settle()
        assertEquals(1, api.rolodexPhotos.size)
        assertNotNull(vm.photos.failureText("p-reed"))
    }

    /** Task 7 minor 3: Try again after a sign-out sends nothing (as Use photo), and the waiting photo goes with the session. */
    @Test fun tryAgainSendsNothingAfterSignOut() = runTest {
        val api = api().apply { rolodexPhotoResult = { _, _ -> throw ApiError(0, "network") } }
        val vm = started(api)
        atCrop(vm)
        vm.newWorker.createWithPhoto(); settle { flowState == null }
        assertNotNull(vm.photos.failureText("p-reed"))
        admin = false
        vm.retryPhoto("p-reed"); settle()
        assertEquals(1, api.rolodexPhotos.size)
        assertNull(vm.photos.failureText("p-reed"))
    }

    /** Task 7 minor 4: a device that can't open the photo library says so on the photo step. */
    @Test fun aLibraryThatCantOpenSaysSo() = runTest {
        val vm = started(api())
        atPhoto(vm)
        vm.newWorker.libraryUnavailable()
        assertEquals("This device can't open the photo library.", flowState?.error)
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        vm.newWorker.usePhoto { picture() }; settle { flowState?.loadingPhoto == false }
        assertNull(flowState?.error)
    }

    /** A worker added since Next is caught by the create: the check runs again and Create anyway re-sends it. */
    @Test fun aPossibleDuplicateOnCreateRerunsTheCheckAndShowsTheSheet() = runTest {
        var matches = emptyList<RolodexMatch>()
        val api = api().apply {
            rolodexDuplicatesResult = { matches }
            rolodexCreateResult = { body -> if (body.allow_duplicate) created else throw ApiError(409, "possible_duplicate") }
        }
        val vm = started(api)
        atCrop(vm)
        matches = listOf(workerMatch)
        vm.newWorker.createWithPhoto(); settle { flowState?.showMatches == true }
        assertEquals(2, api.rolodexDuplicateBodies.size)
        assertEquals(NewWorkerStage.CROP, flowState?.stage)
        assertFalse(flowState!!.creating)

        vm.newWorker.createAnyway(); settle { flowState == null }
        assertEquals(listOf(sentMarcus, sentMarcus.copy(allow_duplicate = true)), api.rolodexCreates)
        assertEquals(1, api.rolodexPhotos.size)
        assertEquals("p-reed", vm.state.value.selectedId)
    }

    /** A create the server refused is never re-sent later with an old photo or an old "without photo". */
    @Test fun aRefusedCreateIsForgottenWhenTheAdminMovesOn() = runTest {
        var matches = emptyList<RolodexMatch>()
        val api = api().apply {
            rolodexDuplicatesResult = { matches }
            rolodexCreateResult = { body -> if (body.allow_duplicate) created else throw ApiError(409, "possible_duplicate") }
        }
        val vm = started(api)
        atPhoto(vm)
        // Refused without a photo, and the check that follows finds nobody.
        vm.newWorker.continueWithoutPhoto()
        vm.newWorker.createWithoutPhoto(); settle { flowState?.checking == false && !flowState!!.creating }
        assertFalse(flowState!!.showMatches)
        assertEquals("Something went wrong. Try again.", flowState?.error)

        // Back to the details and Next again: a match now; Create anyway goes on to the photo step
        // (it does not re-send the old "without photo" create).
        vm.newWorker.backToDetails()
        matches = listOf(workerMatch)
        vm.newWorker.next(); settle { flowState?.checking == false }
        vm.newWorker.createAnyway(); settle()
        assertEquals(NewWorkerStage.PHOTO, flowState?.stage)
        assertEquals(1, api.rolodexCreates.size)

        // The create that follows carries the new photo.
        vm.newWorker.usePhoto { picture() }; settle { flowState?.loadingPhoto == false }
        vm.newWorker.createWithPhoto(); settle { flowState == null }
        assertEquals(sentMarcus.copy(allow_duplicate = true), api.rolodexCreates.last())
        assertEquals(1, api.rolodexPhotos.size)
    }

    /** A failure that isn't about a field stays on Position your photo, form and photo kept (Create worker tries again). */
    @Test fun aFailedCreateKeepsTheFormAndThePhoto() = runTest {
        val cases = listOf(
            ApiError(423, "read_only_mode") to "The system is in read-only mode, so changes can't be saved right now.",
            ApiError(0, "network") to "No connection. Try again when you're back online.",
            ApiError(500, "unknown_error") to "Something went wrong. Try again.",
        )
        for ((failure, copy) in cases) {
            val api = api().apply { rolodexCreateResult = { throw failure } }
            val vm = started(api)
            atCrop(vm)
            val crop = flowState!!.crop
            vm.newWorker.createWithPhoto(); settle { flowState?.creating == false }
            assertEquals(failure.code, copy, flowState?.error)
            assertEquals(failure.code, marcus, flowState?.form)
            assertTrue(failure.code, crop === flowState?.crop)
            assertEquals(failure.code, NewWorkerStage.CROP, flowState?.stage)
            assertTrue(failure.code, api.rolodexPhotos.isEmpty())
            assertNull(failure.code, vm.state.value.selectedId)
        }
    }

    /**
     * M7 (iOS parity): a create refused over a field on the details (here the email) goes back to
     * the details with the error and the positioned photo kept; once the field is fixed, Next comes
     * straight back to the photo and Create sends the same photo, with no retake.
     */
    @Test fun aCreateRefusedOverTheEmailGoesBackToTheDetailsWithThePhotoKept() = runTest {
        var refuse = true
        val api = api().apply { rolodexCreateResult = { if (refuse) throw ApiError(409, "email_in_use") else created } }
        val vm = started(api)
        atCrop(vm)
        val crop = flowState!!.crop!!
        val photo = crop.jpeg()
        vm.newWorker.createWithPhoto(); settle { flowState?.creating == false }
        assertEquals(NewWorkerStage.DETAILS, flowState?.stage)
        assertEquals("Another person already uses that email.", flowState?.error)
        assertTrue(crop === flowState?.crop)
        assertEquals(marcus, flowState?.form)
        assertTrue(api.rolodexPhotos.isEmpty())
        assertNull(vm.state.value.selectedId)

        vm.newWorker.update(marcus.copy(email = "marcus.reed@example.com"))
        refuse = false
        vm.newWorker.next(); settle { flowState?.checking == false }
        assertEquals(NewWorkerStage.CROP, flowState?.stage)
        assertTrue(crop === flowState?.crop)
        assertNull(flowState?.error)
        vm.newWorker.createWithPhoto(); settle { flowState == null }
        assertEquals(2, api.rolodexCreates.size)
        assertEquals("marcus.reed@example.com", api.rolodexCreates.last().email)
        assertArrayEquals(photo, api.rolodexPhotos.single().second)
        assertEquals("p-reed", vm.state.value.selectedId)
    }

    /** The other field refusals (company, level) go back to the details too; Retake is still there on the photo. */
    @Test fun otherFieldRefusalsGoBackToTheDetailsToo() = runTest {
        for (code in listOf("partner_archived", "partner_not_found", "unknown_level")) {
            val api = api().apply { rolodexCreateResult = { throw ApiError(422, code) } }
            val vm = started(api)
            atCrop(vm)
            val crop = flowState!!.crop
            vm.newWorker.createWithPhoto(); settle { flowState?.creating == false }
            assertEquals(code, NewWorkerStage.DETAILS, flowState?.stage)
            assertEquals(code, "Something went wrong. Try again.", flowState?.error)
            assertTrue(code, crop === flowState?.crop)
            vm.newWorker.next(); settle { flowState?.checking == false }
            assertEquals(code, NewWorkerStage.CROP, flowState?.stage)
            vm.newWorker.retake()
            assertEquals(code, NewWorkerStage.PHOTO, flowState?.stage)
            assertNull(code, flowState?.crop)
        }
    }

    /** Without a photo, a field refusal goes back to the details too; the next try asks again before skipping. */
    @Test fun aSkippedPhotoCreateRefusedOverAFieldGoesBackToTheDetails() = runTest {
        var refuse = true
        val api = api().apply { rolodexCreateResult = { if (refuse) throw ApiError(409, "email_in_use") else created } }
        val vm = started(api)
        atPhoto(vm)
        vm.newWorker.continueWithoutPhoto()
        vm.newWorker.createWithoutPhoto(); settle { flowState?.creating == false }
        assertEquals(NewWorkerStage.DETAILS, flowState?.stage)
        assertEquals("Another person already uses that email.", flowState?.error)
        vm.newWorker.update(marcus.copy(email = ""))
        refuse = false
        atPhoto(vm)
        vm.newWorker.createWithoutPhoto(); settle()
        assertEquals(1, api.rolodexCreates.size)                // not asked again yet
        vm.newWorker.continueWithoutPhoto()
        vm.newWorker.createWithoutPhoto(); settle { flowState == null }
        assertEquals(2, api.rolodexCreates.size)
        assertNull(api.rolodexCreates.last().email)
    }

    /** A sign-out while the create is out: the late answer is dropped and no upload starts. */
    @Test fun noUploadStartsAfterSignOut() = runTest {
        val db = newDb()
        val gate = CompletableDeferred<Unit>()
        val api = api().apply { rolodexCreateResult = { gate.await(); created } }
        val vm = started(api, db)
        atCrop(vm)
        vm.newWorker.createWithPhoto(); settle { api.rolodexCreates.isNotEmpty() }
        admin = false
        gate.complete(Unit); settle { flowState == null }
        assertTrue(api.rolodexPhotos.isEmpty())
        assertNull(db.people().get("p-reed"))
        assertNull(vm.state.value.selectedId)
        assertNull(vm.photos.failureText("p-reed"))
    }

    /** Signed out while the photo was being rendered: nothing is sent at all. */
    @Test fun noCreateStartsAfterSignOut() = runTest {
        val api = api()
        val vm = started(api)
        atCrop(vm)
        admin = false
        vm.newWorker.createWithPhoto(); settle { flowState == null || flowState?.creating == false }
        assertTrue(api.rolodexCreates.isEmpty())
        assertTrue(api.rolodexPhotos.isEmpty())
    }

    @Test fun cancelDropsTheFormButNotWhileCreating() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = api().apply { rolodexCreateResult = { gate.await(); created } }
        val vm = started(api)
        atCrop(vm)
        vm.newWorker.createWithPhoto(); settle { api.rolodexCreates.isNotEmpty() }
        vm.newWorker.cancel()
        assertNotNull(flowState)
        gate.complete(Unit); settle { flowState == null }
        assertEquals("p-reed", vm.state.value.selectedId)

        vm.startNewWorker()
        vm.newWorker.update(marcus)
        vm.newWorker.cancel()
        assertNull(flowState)
    }
}
