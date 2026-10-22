package com.serversherpa.kiosk.ui.screens.rolodex

import android.graphics.Bitmap
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexCreateIn
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexDuplicatesIn
import com.serversherpa.kiosk.core.model.RolodexMatch
import com.serversherpa.kiosk.core.people.RolodexEdit
import com.serversherpa.kiosk.core.people.validate
import com.serversherpa.kiosk.data.api.KioskApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** "+ New": the details (Step 1 of 2), the photo step, then "Position your photo". */
enum class NewWorkerStage { DETAILS, PHOTO, CROP }

/** The confirmation's message (mockup 4-photo-required). */
const val NO_PHOTO_MESSAGE = "Every worker should have a photo. You can add one later from their page, and the Rolodex lists who is missing one."

/** Worker matches open their page; anyone else is managed in the portal (spec §3.16). */
fun canOpen(match: RolodexMatch): Boolean = match.is_worker

/** What the sheet says under a match that isn't a worker; null for a worker. */
fun matchNote(match: RolodexMatch): String? =
    if (match.is_worker) null else "Already in the portal, not a worker. Add the worker role there."

/** "Job title · Company" for a possible duplicate, each part only when set. */
fun matchSubtitle(match: RolodexMatch): String? =
    listOfNotNull(match.job_title.cleaned(), match.company.cleaned()).joinToString(" · ").ifEmpty { null }

private fun String?.cleaned(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

/** The duplicates question: names, email and phone in the body (never in a URL), blanks left out. */
internal fun duplicatesBody(form: RolodexEdit) = RolodexDuplicatesIn(
    first_name = form.firstName.trim(), last_name = form.lastName.trim(),
    preferred_name = form.preferredName.cleaned(), email = form.email.cleaned(), phone = form.phone.cleaned(),
)

/** The create: the details as typed (trimmed, blanks left out). Status isn't sent: a new worker starts Active. */
internal fun createBody(form: RolodexEdit, allowDuplicate: Boolean, photoSkipped: Boolean) = RolodexCreateIn(
    first_name = form.firstName.trim(), last_name = form.lastName.trim(),
    preferred_name = form.preferredName.cleaned(), job_title = form.jobTitle.cleaned(),
    phone = form.phone.cleaned(), email = form.email.cleaned(), partner_id = form.partnerId,
    trade = form.trade.cleaned(), level = form.level, allow_duplicate = allowDuplicate, photo_skipped = photoSkipped,
)

data class NewWorkerUi(
    val stage: NewWorkerStage = NewWorkerStage.DETAILS,
    /** The details as typed (status isn't on this form). */
    val form: RolodexEdit = RolodexEdit(),
    /** The duplicate check is under way. */
    val checking: Boolean = false,
    /** Create worker (and the photo upload after it) is under way. */
    val creating: Boolean = false,
    /** The worker is created and their photo is going up. */
    val uploading: Boolean = false,
    /** A capture or a pick is being decoded. */
    val loadingPhoto: Boolean = false,
    /** The shutter was pressed and the capture hasn't landed yet (M3: it holds "Continue without photo"). */
    val capturing: Boolean = false,
    /** Flip: the front camera. Kept across Retake and Back within the flow; a new flow starts on the back camera. */
    val front: Boolean = false,
    /** What went wrong, in the spec's words. */
    val error: String? = null,
    /** The people the new worker may already be. */
    val matches: List<RolodexMatch> = emptyList(),
    /** The "Possible duplicate" sheet is up. */
    val showMatches: Boolean = false,
    /** The admin chose Create anyway. */
    val allowDuplicate: Boolean = false,
    /** "Create Marcus Reed without a photo?" is up. */
    val confirmNoPhoto: Boolean = false,
    /** The photo, positioned (kept on Back to the details; Retake drops it). */
    val crop: PhotoCrop? = null,
) {
    /** Something is under way (a capture on its way included); the buttons wait. */
    val busy: Boolean get() = checking || creating || loadingPhoto || capturing

    /** The name the worker will show: preferred (else first) name and last name. */
    val workerName: String get() =
        listOfNotNull(form.preferredName.cleaned() ?: form.firstName.cleaned(), form.lastName.cleaned()).joinToString(" ")

    val confirmTitle: String get() = "Create $workerName without a photo?"

    /** Who already has the typed email (it can't be reused). */
    val emailOwner: String? get() = matches.firstOrNull { "email" in it.matched_on }?.display_name

    /** Why Create anyway is off. */
    val blockText: String? get() = emailOwner?.let { "That email belongs to $it. Change or clear the email." }

    /** A name or phone match can be created anyway; an email match can't. */
    val canCreateAnyway: Boolean get() = emailOwner == null

    /** The photo steps' progress words. */
    val busyText: String? get() = when {
        uploading -> "Uploading…"
        creating -> "Creating…"
        checking -> "Checking…"
        loadingPhoto -> "Loading photo…"
        else -> null
    }
}

/**
 * "+ New" (spec §2, §3.6, §3.7, §3.16, §4.2): the details, the duplicate check on Next, the photo
 * step (camera or library, with "Continue without photo" behind a confirmation), "Position your
 * photo", then Create worker. The worker is created first, then the photo uploads; either way
 * their page opens. If the upload fails the page says "Marcus Reed was saved, but the photo didn't
 * upload." with Try again ([RolodexPhotoFlow]).
 *
 * Built by [RolodexViewModel] and run in its scope, so a rotation keeps what was typed. The create
 * and the upload after it run under NonCancellable. [signedIn] is checked after the photo is
 * rendered and after the create answers: once the admin has signed out nothing more is sent, and
 * a late answer is dropped. [onCreated] opens the new worker (page, list row, the Time Clock's
 * roster, the offline copy); [onOpen] opens a match's page.
 */
class NewWorkerFlow internal constructor(
    private val api: KioskApi,
    private val scope: CoroutineScope,
    private val photos: RolodexPhotoFlow,
    private val signedIn: () -> Boolean,
    private val onCreated: suspend (RolodexDetail) -> Unit,
    private val onOpen: (personId: String) -> Unit,
) {
    private val _state = MutableStateFlow<NewWorkerUi?>(null)
    /** Null while the flow is closed. */
    val state: StateFlow<NewWorkerUi?> = _state

    /** Bumped by [reset] (Cancel, Open, done): work started before it is dropped. */
    private var generation = 0
    /** Bumped when a decode starts, on Back and on Retake: a decode that lands later is dropped. */
    private var visit = 0

    /** A create the server refused as a possible duplicate: Create anyway on the sheet that follows sends it again. */
    private class Refused(val photo: ByteArray?, val photoSkipped: Boolean)
    private var refused: Refused? = null

    /** "Continue without photo" was tapped and not answered with Take photo: only then may a create skip the photo. */
    private var skipAsked = false

    private fun change(f: (NewWorkerUi) -> NewWorkerUi) = _state.update { it?.let(f) }

    // ── open and close ──

    /** "+ New": an empty form (the view model checks the connection and the list first). */
    internal fun start() {
        reset()
        _state.value = NewWorkerUi()
    }

    /** Cancel: the form is dropped. Not while the worker is being created. */
    fun cancel() {
        if (_state.value?.creating == true) return
        reset()
    }

    /** Closes the flow and forgets the form, the photo and any refused create. */
    internal fun reset() {
        generation++
        visit++
        refused = null
        skipAsked = false
        _state.value = null
    }

    // ── details and duplicates ──

    /** The details as typed; only on the details step, and not while something is under way. */
    fun update(form: RolodexEdit) {
        val s = _state.value ?: return
        if (s.stage != NewWorkerStage.DETAILS || s.busy) return
        _state.value = s.copy(form = form)
    }

    /**
     * Next: photo. Checks the form, then whether the worker may already exist: matches show the
     * "Possible duplicate" sheet; none goes on to the photo (or back to the photo already positioned).
     */
    fun next() {
        val s = _state.value ?: return
        if (s.stage != NewWorkerStage.DETAILS || s.busy) return
        refused = null
        validate(s.form)?.let { problem -> _state.value = s.copy(error = problem); return }
        runCheck(advance = true)
    }

    /** Asks the server who the new worker may already be; matches show the sheet. */
    fun checkDuplicates() = runCheck(advance = false)

    private fun runCheck(advance: Boolean, afterRefusal: Boolean = false) {
        val s = _state.value ?: return
        if (s.checking) return
        _state.value = s.copy(checking = true, error = null, allowDuplicate = false, matches = emptyList(), showMatches = false)
        val mine = generation
        val body = duplicatesBody(s.form)
        scope.launch {
            val found = try {
                api.rolodexDuplicates(body)
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                if (mine != generation) return@launch
                if (afterRefusal) refused = null
                change { it.copy(checking = false, error = rolodexErrorText((e as? ApiError)?.code)) }
                return@launch
            }
            if (mine != generation) return@launch
            change { it.copy(checking = false, matches = found, showMatches = found.isNotEmpty()) }
            when {
                found.isNotEmpty() -> Unit
                // The server saw a duplicate the check can't find: say so; that create is never sent again.
                afterRefusal -> { refused = null; change { it.copy(error = rolodexErrorText(null)) } }
                advance -> advanceToPhoto()
            }
        }
    }

    private fun advanceToPhoto() =
        change { it.copy(error = null, stage = if (it.crop == null) NewWorkerStage.PHOTO else NewWorkerStage.CROP) }

    /** Create anyway (never past an email match). After a refused create it sends that create again; otherwise on to the photo. */
    fun createAnyway() {
        val s = _state.value ?: return
        if (!s.showMatches || !s.canCreateAnyway || s.busy) return
        val again = refused
        refused = null
        if (again != null) {
            _state.value = s.copy(allowDuplicate = true, showMatches = false, creating = true, error = null)
            scope.launch { send(again.photo, again.photoSkipped, allowDuplicate = true) }
        } else {
            _state.value = s.copy(allowDuplicate = true, showMatches = false)
            advanceToPhoto()
        }
    }

    /** The sheet's Back. An email match goes back to the details to change it. */
    fun dismissMatches() {
        val s = _state.value ?: return
        if (!s.showMatches || s.creating) return
        refused = null
        val block = s.blockText
        _state.value = if (block == null) s.copy(showMatches = false)
        else {
            skipAsked = false
            s.copy(showMatches = false, stage = NewWorkerStage.DETAILS, error = block, confirmNoPhoto = false)
        }
    }

    /** Open on a worker match: that worker's page instead of a new one. The form is dropped. */
    fun openMatch(personId: String) {
        val s = _state.value ?: return
        if (!s.showMatches || s.busy) return
        val match = s.matches.firstOrNull { it.person_id == personId } ?: return
        if (!canOpen(match)) return
        reset()
        onOpen(personId)
    }

    /** "‹ Details" from the photo steps; a photo already positioned is kept. */
    fun backToDetails() {
        val s = _state.value ?: return
        if (s.creating || s.checking) return
        refused = null
        skipAsked = false
        visit++
        _state.value = s.copy(stage = NewWorkerStage.DETAILS, confirmNoPhoto = false, error = null, loadingPhoto = false, capturing = false)
    }

    // ── the photo ──

    /**
     * A capture or a pick ([load] decodes it, off the main thread): "Position your photo". One that
     * isn't a picture stays on the photo step and says so. A photo on its way closes "Create …
     * without a photo?" and forgets the ask: a create can't skip a photo the admin took (M3).
     */
    fun usePhoto(load: suspend () -> Bitmap?) {
        val s = _state.value ?: return
        // Not [NewWorkerUi.busy]: a capture on its way lands here.
        if (s.stage != NewWorkerStage.PHOTO || s.checking || s.creating || s.loadingPhoto) return
        val mine = ++visit
        val gen = generation
        skipAsked = false
        _state.value = s.copy(loadingPhoto = true, capturing = false, confirmNoPhoto = false, error = null)
        scope.launch {
            val crop = decodeCrop(load)
            if (gen != generation || mine != visit) return@launch
            change {
                if (crop == null) it.copy(loadingPhoto = false, error = PHOTO_UNUSABLE)
                else it.copy(loadingPhoto = false, crop = crop, stage = NewWorkerStage.CROP)
            }
        }
    }

    /** Retake: back to the camera (or Choose photo). */
    fun retake() {
        val s = _state.value ?: return
        if (s.creating || s.checking) return
        refused = null
        visit++
        _state.value = s.copy(crop = null, error = null, stage = NewWorkerStage.PHOTO, loadingPhoto = false, capturing = false)
    }

    /**
     * The shutter: a capture may start (true) on the photo step when nothing else is under way. Until
     * it lands ([usePhoto]) or fails ([captureFailed]) the step waits, "Continue without photo" included.
     */
    fun captureStarted(): Boolean {
        val s = _state.value ?: return false
        if (s.stage != NewWorkerStage.PHOTO || s.busy || s.confirmNoPhoto) return false
        _state.value = s.copy(capturing = true, error = null)
        return true
    }

    /** The capture failed (the camera says why): the step is free again. */
    fun captureFailed() = change { it.copy(capturing = false) }

    /** Flip: the other camera, kept until the flow ends. Not while a capture is on its way. */
    fun flip() {
        val s = _state.value ?: return
        if (s.stage != NewWorkerStage.PHOTO || s.capturing) return
        _state.value = s.copy(front = !s.front)
    }

    /** The quiet "Continue without photo" link: asks first. */
    fun continueWithoutPhoto() {
        val s = _state.value ?: return
        if (s.stage != NewWorkerStage.PHOTO || s.busy) return
        skipAsked = true
        _state.value = s.copy(confirmNoPhoto = true)
    }

    /** The confirmation's default: back to the camera. */
    fun takePhotoInstead() {
        skipAsked = false
        change { it.copy(confirmNoPhoto = false) }
    }

    // ── Create worker ──

    /** "Create without photo" in the confirmation: the create says `photo_skipped` (only ever after that confirmation). */
    fun createWithoutPhoto() {
        val s = _state.value ?: return
        create(null, photoSkipped = true, allowDuplicate = s.allowDuplicate)
    }

    /** Create worker on "Position your photo": what the circle shows, as the 512×512 JPEG. */
    fun createWithPhoto() {
        val s = _state.value ?: return
        val crop = s.crop ?: return
        if (s.stage != NewWorkerStage.CROP || s.busy || s.showMatches) return
        _state.value = s.copy(creating = true, error = null)
        val position = crop.position()
        val allow = s.allowDuplicate
        val mine = generation
        scope.launch {
            val jpeg = renderOrNull(crop, position)
            if (mine != generation) return@launch
            if (jpeg == null) { change { it.copy(creating = false, error = PHOTO_UNUSABLE) }; return@launch }
            send(jpeg, photoSkipped = false, allowDuplicate = allow)
        }
    }

    /**
     * Creates the worker from the form with [photo]. One create at a time: a call while one is
     * under way sends nothing. The rules the screens follow hold here too: a photo is required
     * unless the admin confirmed "Create without photo" on the photo step ([photoSkipped], with no photo), and
     * [allowDuplicate] only after Create anyway, never past an email match.
     */
    fun create(photo: ByteArray?, photoSkipped: Boolean, allowDuplicate: Boolean) {
        val s = _state.value ?: return
        if (s.busy) return
        if (photo == null && !photoSkipped) return
        if (photoSkipped && (photo != null || !skipAsked || s.stage != NewWorkerStage.PHOTO)) return
        if (allowDuplicate && (!s.allowDuplicate || !s.canCreateAnyway)) return
        skipAsked = false
        _state.value = s.copy(creating = true, confirmNoPhoto = false, error = null)
        scope.launch { send(photo, photoSkipped, allowDuplicate) }
    }

    /**
     * The create, then the worker's page, then the photo. `creating` is already set. A failure
     * keeps the form and the photo; a possible duplicate runs the check again for the sheet.
     */
    private suspend fun send(photo: ByteArray?, photoSkipped: Boolean, allowDuplicate: Boolean): Unit = withContext(NonCancellable) {
        val s = _state.value ?: return@withContext
        val mine = generation
        // Signed out while the photo was rendered: nothing is sent.
        if (!signedIn()) { reset(); return@withContext }
        val created = try {
            api.rolodexCreate(createBody(s.form, allowDuplicate, photoSkipped))
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) {
            if (mine != generation) return@withContext
            val code = (e as? ApiError)?.code
            if (code == "possible_duplicate") {
                // Someone like them was added since Next: show who, as Next does.
                refused = Refused(photo, photoSkipped)
                change { it.copy(creating = false) }
                runCheck(advance = false, afterRefusal = true)
            } else {
                change { it.copy(creating = false, error = rolodexErrorText(code)) }
            }
            return@withContext
        }
        // Signed out (or closed) while it was out: the late answer is dropped, and no upload starts.
        if (mine != generation || !signedIn()) {
            if (mine == generation) reset()
            return@withContext
        }
        onCreated(created)
        if (photo != null && mine == generation && signedIn()) {
            change { it.copy(uploading = true) }
            try {
                photos.uploadPhoto(created.person_id, photo)
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                if (signedIn()) photos.recordFailure(created.person_id, nameOf(created), photo)
            }
        }
        if (mine == generation) reset()
    }

    private fun nameOf(d: RolodexDetail): String =
        d.display_name.ifBlank { listOfNotNull(d.first_name.cleaned(), d.last_name.cleaned()).joinToString(" ") }
}
