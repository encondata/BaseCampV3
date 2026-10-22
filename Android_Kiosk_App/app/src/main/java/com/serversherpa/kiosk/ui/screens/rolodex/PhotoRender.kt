package com.serversherpa.kiosk.ui.screens.rolodex

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.net.Uri
import com.serversherpa.kiosk.core.photo.Crop
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt

/** The longest side a picture is decoded at for "Position your photo" (a 48 MP photo is never decoded whole). */
internal const val CROP_DECODE_MAX_SIDE = 2048

/**
 * A picture's bytes (a capture's JPEG, or a file) decoded for "Position your photo": the EXIF
 * orientation applied (ImageDecoder does it), shrunk so its longest side is at most [maxSide]
 * (never enlarged), in a software bitmap a Canvas can draw. Null for bytes that aren't a picture
 * this device can read, or a picture with no pixels: the crop math never sees a zero size.
 */
fun decodeForCrop(bytes: ByteArray, maxSide: Int = CROP_DECODE_MAX_SIDE): Bitmap? =
    if (bytes.isEmpty()) null else decode(ImageDecoder.createSource(ByteBuffer.wrap(bytes)), maxSide)

/** [decodeForCrop] for a library pick (a content Uri from the photo picker). Read and decoded off the main thread by the caller. */
fun decodeForCrop(context: Context, uri: Uri, maxSide: Int = CROP_DECODE_MAX_SIDE): Bitmap? =
    decode(ImageDecoder.createSource(context.contentResolver, uri), maxSide)

private fun decode(source: ImageDecoder.Source, maxSide: Int): Bitmap? = try {
    ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        // A hardware bitmap can't be drawn into the renderer's software Canvas.
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        // The size is the upright one (after the EXIF orientation), as is the target.
        val w = info.size.width
        val h = info.size.height
        val longest = max(w, h)
        if (longest > maxSide && w > 0 && h > 0) {
            val f = maxSide.toDouble() / longest
            decoder.setTargetSize(max(1, (w * f).roundToInt()), max(1, (h * f).roundToInt()))
        }
    }.takeIf { it.width > 0 && it.height > 0 }
} catch (e: Exception) {
    null
} catch (e: OutOfMemoryError) {
    // Even shrunk, a picture this device can't hold is one it can't use.
    null
}

/**
 * What the circle shows, as the Rolodex uploads it (spec §4.2): [Crop.OUTPUT_PX] square, white
 * painted first (so a transparent picture comes out white, not black), the JPEG at
 * [Crop.JPEG_QUALITY]. [v], [z], [dx] and [dy] are [Crop.sourceRect]'s viewport, zoom and offset
 * (the offset is clamped, so the square never leaves the picture). [source] must have pixels.
 */
fun renderCrop(source: Bitmap, v: Float, z: Float, dx: Float, dy: Float): ByteArray {
    require(source.width > 0 && source.height > 0) { "a picture with no pixels" }
    val out = Crop.OUTPUT_PX
    val rect = Crop.sourceRect(source.width.toFloat(), source.height.toFloat(), v, z, dx, dy)
    val (x, y, side) = Triple(rect[0], rect[1], rect[2])

    // A square many times the output is shrunk by halves first: one bilinear pass from far
    // larger skips most of the pixels and aliases (hair, fabric). Each half is a 2×2 average.
    var part = source
    var left = 0
    var top = 0
    var scaleX = 1f
    var scaleY = 1f
    if (side > out * 2) {
        left = floor(x).toInt().coerceIn(0, source.width - 1)
        top = floor(y).toInt().coerceIn(0, source.height - 1)
        val right = ceil(x + side).toInt().coerceIn(left + 1, source.width)
        val bottom = ceil(y + side).toInt().coerceIn(top + 1, source.height)
        part = Bitmap.createBitmap(source, left, top, right - left, bottom - top)
        while (side * scaleX > out * 2 && part.width > 1 && part.height > 1) {
            val half = Bitmap.createScaledBitmap(part, part.width / 2, part.height / 2, true)
            scaleX *= half.width.toFloat() / part.width
            scaleY *= half.height.toFloat() / part.height
            if (part !== source) part.recycle()
            part = half
        }
    }

    val bitmap = Bitmap.createBitmap(out, out, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.WHITE)
    val matrix = Matrix().apply {
        postTranslate(-(x - left) * scaleX, -(y - top) * scaleY)
        postScale(out / (side * scaleX), out / (side * scaleY))
    }
    canvas.drawBitmap(part, matrix, Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG))
    if (part !== source) part.recycle()
    val jpeg = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, Crop.JPEG_QUALITY, it) }.toByteArray()
    bitmap.recycle()
    return jpeg
}
