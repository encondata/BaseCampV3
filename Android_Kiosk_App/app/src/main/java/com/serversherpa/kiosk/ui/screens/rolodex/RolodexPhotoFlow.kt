package com.serversherpa.kiosk.ui.screens.rolodex

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexPhotoOut
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.ui.screens.timeclock.screens.decodePhoto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The worker page's photo screens: [NONE]; [CAMERA], the photo step (the camera, or Choose photo
 * only on a device without one); [LOADING], a capture or pick being decoded; [CROP], "Position
 * your photo".
 */
enum class PhotoStage { NONE, CAMERA, LOADING, CROP }

/** The worker a new photo is for. */
data class PhotoTarget(val personId: String, val name: String)

/** A new worker's photo that didn't upload after the create (spec §3.6), kept for Try again. */
class PhotoFailure(
    val name: String,
    val jpeg: ByteArray,
    /** Why the last Try again failed, in the spec's words. */
    val retryError: String? = null,
    val retrying: Boolean = false,
) {
    fun copy(retryError: String? = this.retryError, retrying: Boolean = this.retrying) = PhotoFailure(name, jpeg, retryError, retrying)
}

/** "Marcus Reed was saved, but the photo didn't upload." */
fun photoFailureText(name: String): String = "$name was saved, but the photo didn't upload."

data class RolodexPhotoUi(
    val target: PhotoTarget? = null,
    /** "Photo for Ana Ortiz": Take new photo / Choose photo / Cancel. */
    val sheet: Boolean = false,
    val stage: PhotoStage = PhotoStage.NONE,
    val crop: PhotoCrop? = null,
    /** Use photo: the JPEG is on its way. */
    val uploading: Boolean = false,
    /** What went wrong with the picture or its upload, in the spec's words. */
    val error: String? = null,
    /** New workers whose photo didn't upload after the create, by person id. */
    val failures: Map<String, PhotoFailure> = emptyMap(),
)

/**
 * A worker's new photo from their page's camera badge (spec §4.2): the "Take new photo / Choose
 * photo" sheet, the camera or the library, "Position your photo", then the upload. Also owns the
 * upload itself (the New worker flow's too) and the photos that didn't upload after a create,
 * with Try again. Built by [RolodexViewModel], whose scope it runs in; [signedIn] says whether an
 * admin is still signed in, and [onUploaded] shows a new photo on the page, the list and the
 * offline copy.
 */
class RolodexPhotoFlow internal constructor(
    private val api: KioskApi,
    private val scope: CoroutineScope,
    private val signedIn: () -> Boolean,
    private val onUploaded: suspend (personId: String, out: RolodexPhotoOut) -> Unit,
) {
    private val _state = MutableStateFlow(RolodexPhotoUi())
    val state: StateFlow<RolodexPhotoUi> = _state

    /** Bumped when the photo screens close or a new decode starts: a decode that lands later is dropped. */
    private var visit = 0

    /** The camera badge (the view model checks the edit rule and the connection first). */
    internal fun start(target: PhotoTarget) {
        if (_state.value.uploading) return
        closeScreens()
        _state.update { it.copy(target = target, sheet = true) }
    }

    /** Take new photo: the camera (on the back camera). */
    fun takePhoto() {
        val s = _state.value
        if (s.target == null || s.uploading) return
        _state.update { it.copy(sheet = false, error = null, crop = null, stage = PhotoStage.CAMERA) }
    }

    /** Choose photo from the sheet: the sheet closes while the screen opens the photo picker, whose pick comes to [use]. */
    fun closeSheet() = _state.update { it.copy(sheet = false) }

    /**
     * A capture or a pick ([load] decodes it, off the main thread): "Position your photo". One that
     * isn't a picture goes to the photo step and says so.
     */
    fun use(load: suspend () -> Bitmap?) {
        val s = _state.value
        if (s.target == null || s.uploading || s.stage == PhotoStage.LOADING) return
        val mine = ++visit
        _state.update { it.copy(sheet = false, error = null, stage = PhotoStage.LOADING) }
        scope.launch {
            val crop = decodeCrop(load)
            if (mine != visit || _state.value.target == null) return@launch
            _state.update {
                if (crop == null) it.copy(stage = PhotoStage.CAMERA, crop = null, error = PHOTO_UNUSABLE)
                else it.copy(stage = PhotoStage.CROP, crop = crop)
            }
        }
    }

    /** Retake: back to the photo step. */
    fun retake() {
        if (_state.value.uploading) return
        visit++
        _state.update { it.copy(crop = null, error = null, stage = PhotoStage.CAMERA) }
    }

    /** Cancel (the sheet, the camera, or Back): nothing changes. Not while the photo uploads. */
    fun close() {
        if (_state.value.uploading) return
        closeScreens()
    }

    private fun closeScreens() {
        visit++
        _state.update { it.copy(target = null, sheet = false, stage = PhotoStage.NONE, crop = null, error = null) }
    }

    /**
     * Use photo: what the circle shows goes up as the worker's photo, and the page and the list
     * show it. One upload at a time (a second tap does nothing); a failure keeps the crop and says why.
     */
    fun usePhoto() {
        val s = _state.value
        val target = s.target ?: return
        val crop = s.crop ?: return
        if (s.uploading || s.stage != PhotoStage.CROP) return
        _state.update { it.copy(uploading = true, error = null) }
        val position = crop.position()
        scope.launch {
            val jpeg = renderOrNull(crop, position)
            if (jpeg == null) { _state.update { it.copy(uploading = false, error = PHOTO_UNUSABLE) }; return@launch }
            // Signed out while it rendered: nothing is sent.
            if (!signedIn()) { _state.update { it.copy(uploading = false) }; return@launch }
            try {
                uploadPhoto(target.personId, jpeg)
                _state.update { it.copy(uploading = false) }
                closeScreens()
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                _state.update { it.copy(uploading = false, error = rolodexErrorText((e as? ApiError)?.code)) }
            }
        }
    }

    // ── the upload ──

    /**
     * Sends [jpeg] as [personId]'s photo. The PUT and what follows it run to the end even if the
     * screen goes (NonCancellable). On success the photo cache already holds the picture under its
     * new version (no fetch of the new link), a photo left over from a failed upload is forgotten,
     * and [onUploaded] shows it; after a sign-out nothing is shown or stored. Throws the API's error.
     */
    suspend fun uploadPhoto(personId: String, jpeg: ByteArray): RolodexPhotoOut = withContext(NonCancellable) {
        val out = api.rolodexPhoto(personId, jpeg)
        if (signedIn()) {
            out.photo_version?.let { version -> remember(personId, version, jpeg) }
            setFailures { it - personId }
            onUploaded(personId, out)
        }
        out
    }

    /** The page's and the rows' size of the new photo, in the photo cache under its new version. */
    private suspend fun remember(personId: String, version: String, jpeg: ByteArray) {
        val photo = withContext(Dispatchers.Default) {
            try { decodePhoto(jpeg, PHOTO_DECODE_PX)?.asImageBitmap() } catch (e: Exception) { null }
        }
        photo?.let { WorkerPhotoCache.put(WorkerPhotoCache.key(personId, version), it) }
    }

    // ── a new worker's photo that didn't upload ──

    /** Kept so the worker's page can say so and Try again. */
    internal fun recordFailure(personId: String, name: String, jpeg: ByteArray) = setFailures { it + (personId to PhotoFailure(name, jpeg)) }

    /** "Marcus Reed was saved, but the photo didn't upload." while that photo is waiting. */
    fun failureText(personId: String): String? = _state.value.failures[personId]?.let { photoFailureText(it.name) }

    /** Try again: the same photo, one try at a time per worker (the view model checks the connection). */
    internal fun retry(personId: String) {
        val failure = _state.value.failures[personId] ?: return
        if (failure.retrying) return
        setFailure(personId) { it.copy(retrying = true, retryError = null) }
        scope.launch {
            try {
                uploadPhoto(personId, failure.jpeg)
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                setFailure(personId) { it.copy(retryError = rolodexErrorText((e as? ApiError)?.code)) }
            } finally {
                setFailure(personId) { it.copy(retrying = false) }
            }
        }
    }

    private fun setFailures(change: (Map<String, PhotoFailure>) -> Map<String, PhotoFailure>) =
        _state.update { it.copy(failures = change(it.failures)) }

    private fun setFailure(personId: String, change: (PhotoFailure) -> PhotoFailure) =
        setFailures { all -> all[personId]?.let { all + (personId to change(it)) } ?: all }
}
