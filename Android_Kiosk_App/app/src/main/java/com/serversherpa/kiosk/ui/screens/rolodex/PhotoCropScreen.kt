package com.serversherpa.kiosk.ui.screens.rolodex

import android.graphics.Bitmap
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.photo.Crop
import com.serversherpa.kiosk.input.camera.PhotoStepBar
import com.serversherpa.kiosk.input.camera.PhotoStepError
import com.serversherpa.kiosk.input.camera.drawCircleDim
import com.serversherpa.kiosk.input.camera.photoGuide
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * "Position your photo" (spec §4.2): the picture (upright, at most [CROP_DECODE_MAX_SIDE]) and where
 * it sits under the circle: zoom 1×–4× over cover-fit, and an offset (picture center minus circle
 * center) in circle diameters, so a rotation or a resize keeps the framing. The offset is always
 * clamped, so the picture covers the circle. Held by the flow (the view model), not the screen.
 */
@Stable
class PhotoCrop private constructor(val image: Bitmap) {
    companion object {
        /** A crop for [image]; null for no picture or one with no pixels (the crop math needs a size). */
        fun of(image: Bitmap?): PhotoCrop? = image?.takeIf { it.width > 0 && it.height > 0 }?.let(::PhotoCrop)
    }

    private val w = image.width.toFloat()
    private val h = image.height.toFloat()

    /** The picture as the screen draws it. */
    val preview: ImageBitmap by lazy { image.asImageBitmap() }

    var zoom by mutableFloatStateOf(Crop.MIN_ZOOM)
        private set
    var offsetX by mutableFloatStateOf(0f)
        private set
    var offsetY by mutableFloatStateOf(0f)
        private set

    /** The slider. */
    fun zoomTo(z: Float) {
        zoom = Crop.clampZoom(z)
        move(offsetX, offsetY)
    }

    /** A pinch that scaled by [factor] since the last event. */
    fun zoomBy(factor: Float) {
        if (factor.isFinite() && factor > 0f) zoomTo(zoom * factor)
    }

    /** A drag of ([dx], [dy]) pixels under a circle [viewport] pixels across. */
    fun moveBy(dx: Float, dy: Float, viewport: Float) {
        if (viewport > 0f) move(offsetX + dx / viewport, offsetY + dy / viewport)
    }

    private fun move(x: Float, y: Float) {
        val (cx, cy) = Crop.clampOffset(w, h, 1f, zoom, x, y)
        offsetX = cx
        offsetY = cy
    }

    /** Screen pixels per picture pixel under a circle [viewport] pixels across. */
    fun displayScale(viewport: Float): Float = Crop.scale(w, h, viewport, zoom)

    /** Where the picture sits now (zoom, offset x, offset y): read on the main thread, rendered off it. */
    fun position(): FloatArray = floatArrayOf(zoom, offsetX, offsetY)

    /** What the circle shows at [position], as the 512×512 JPEG the Rolodex uploads. */
    fun jpeg(position: FloatArray = position()): ByteArray = renderCrop(image, 1f, position[0], position[1], position[2])
}

/** "That photo couldn't be used. Take or choose another one." */
internal val PHOTO_UNUSABLE: String get() = rolodexErrorText("unreadable_image")

/** A capture or a pick decoded for the crop, off the main thread; null when it isn't a picture this device can use. */
internal suspend fun decodeCrop(load: suspend () -> Bitmap?): PhotoCrop? = try {
    withContext(Dispatchers.IO) { PhotoCrop.of(load()) }
} catch (e: CancellationException) { throw e
} catch (e: Exception) { null
} catch (e: OutOfMemoryError) { null }

/** [crop] at [position] as the upload's JPEG, off the main thread; null if it can't be rendered here. */
internal suspend fun renderOrNull(crop: PhotoCrop, position: FloatArray): ByteArray? = try {
    withContext(Dispatchers.Default) { crop.jpeg(position) }
} catch (e: CancellationException) { throw e
} catch (e: Exception) { null
} catch (e: OutOfMemoryError) { null }

/**
 * "Position your photo" (mockup 3): the picture under a circular mask; drag to move, pinch or the
 * slider to zoom, never uncovering the circle. Retake / [useLabel] ("Use photo" on the worker
 * page, "Create worker" in the New worker flow). [busyText] ("Saving…", "Creating…") replaces the
 * primary while the photo or the worker is on its way. Content of a [com.serversherpa.kiosk.input.camera.PhotoStepsWindow].
 */
@Composable
internal fun PhotoCropScreen(
    crop: PhotoCrop,
    useLabel: String,
    busyText: String?,
    errorText: String?,
    onRetake: () -> Unit,
    onUse: () -> Unit,
    insets: PaddingValues,
) {
    val c = LocalKioskColors.current
    val busy = busyText != null
    val busyNow by rememberUpdatedState(busy)
    val density = LocalDensity.current
    Column(Modifier.fillMaxSize()) {
        PhotoStepBar("‹ Retake", backEnabled = !busy, title = "Position your photo", onBack = onRetake, topInset = insets.calculateTopPadding())
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val reserve = with(density) { 210.dp.toPx() }
            val widthPx = constraints.maxWidth.toFloat()
            val heightPx = constraints.maxHeight.toFloat()
            val (diameter, center) = photoGuide(widthPx, heightPx, reserve, density)
            Canvas(
                Modifier.fillMaxSize()
                    .pointerInput(crop, diameter) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            if (!busyNow) {
                                crop.zoomBy(zoom)
                                crop.moveBy(pan.x, pan.y, diameter)
                            }
                        }
                    }
                    .semantics { contentDescription = "Photo position. Drag to move · pinch or slide to zoom" }
                    .testTag("photo-crop"),
            ) {
                val s = crop.displayScale(diameter)
                val dw = crop.image.width * s
                val dh = crop.image.height * s
                val cx = center.x + crop.offsetX * diameter
                val cy = center.y + crop.offsetY * diameter
                drawRect(Color(0xFF0B0F14))
                drawImage(
                    crop.preview,
                    dstOffset = IntOffset((cx - dw / 2f).roundToInt(), (cy - dh / 2f).roundToInt()),
                    dstSize = IntSize(dw.roundToInt().coerceAtLeast(1), dh.roundToInt().coerceAtLeast(1)),
                    filterQuality = FilterQuality.Medium,
                )
                drawCircleDim(diameter, center, Color.Black.copy(alpha = 0.6f))
                drawCircle(Color.White.copy(alpha = 0.9f), radius = diameter / 2f, center = center, style = Stroke(2.dp.toPx()))
            }
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp + insets.calculateBottomPadding()),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Drag to move · pinch or slide to zoom", style = MaterialTheme.typography.bodyMedium, color = Color.White, fontWeight = FontWeight.Medium)
                Slider(
                    value = crop.zoom, onValueChange = crop::zoomTo, valueRange = Crop.MIN_ZOOM..Crop.MAX_ZOOM, enabled = !busy,
                    colors = SliderDefaults.colors(thumbColor = c.accent, activeTrackColor = c.accent, inactiveTrackColor = Color.White.copy(alpha = 0.25f)),
                    modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth().semantics { contentDescription = "Zoom" }.testTag("photo-zoom"),
                )
                PhotoStepError(errorText)
                Row(Modifier.widthIn(max = 520.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        onClick = onRetake, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("photo-retake"),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White, disabledContentColor = Color.White.copy(alpha = 0.45f)),
                        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.35f)),
                    ) { Text("Retake") }
                    Button(
                        onClick = onUse, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("photo-use"),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = c.accent, contentColor = c.ink,
                            disabledContainerColor = c.accent.copy(alpha = 0.7f), disabledContentColor = c.ink,
                        ),
                    ) {
                        if (busy) {
                            CircularProgressIndicator(color = c.ink, strokeWidth = 2.dp, modifier = Modifier.padding(end = 8.dp).size(18.dp))
                        }
                        Text(busyText ?: useLabel)
                    }
                }
            }
        }
    }
}
