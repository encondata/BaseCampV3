package com.serversherpa.kiosk.core.photo

import kotlin.math.max

/**
 * "Position your photo" math (plan "Crop math"; iOS PhotoCropMath mirrors it). The viewport is a
 * square of side `v` over an image `w`×`h`; zoom `z` is over cover-fit and clamped to
 * [MIN_ZOOM]..[MAX_ZOOM]; the offset `(dx, dy)` is the image center minus the viewport center,
 * in viewport points.
 */
object Crop {
    /** The uploaded photo is OUTPUT_PX × OUTPUT_PX. */
    const val OUTPUT_PX = 512
    const val JPEG_QUALITY = 92
    const val MIN_ZOOM = 1f
    const val MAX_ZOOM = 4f

    fun clampZoom(z: Float): Float = if (z.isNaN()) MIN_ZOOM else z.coerceIn(MIN_ZOOM, MAX_ZOOM)

    /** Viewport points per image pixel: cover-fit times the clamped zoom. */
    fun scale(w: Float, h: Float, v: Float, z: Float): Float = max(v / w, v / h) * clampZoom(z)

    /** The offset limited so the image always covers the viewport: |dx| ≤ (w·scale − v)/2, likewise dy. */
    fun clampOffset(w: Float, h: Float, v: Float, z: Float, dx: Float, dy: Float): Pair<Float, Float> {
        val s = scale(w, h, v, z)
        val maxX = max(0f, (w * s - v) / 2f)
        val maxY = max(0f, (h * s - v) / 2f)
        return dx.coerceIn(-maxX, maxX) to dy.coerceIn(-maxY, maxY)
    }

    /**
     * The square of the image, in image pixels, that the viewport shows: `x, y, side, side`.
     * The offset is clamped first, so the square never leaves the image.
     */
    fun sourceRect(w: Float, h: Float, v: Float, z: Float, dx: Float, dy: Float): FloatArray {
        val s = scale(w, h, v, z)
        val (cx, cy) = clampOffset(w, h, v, z, dx, dy)
        val side = v / s
        return floatArrayOf(w / 2f - cx / s - side / 2f, h / 2f - cy / s - side / 2f, side, side)
    }
}
