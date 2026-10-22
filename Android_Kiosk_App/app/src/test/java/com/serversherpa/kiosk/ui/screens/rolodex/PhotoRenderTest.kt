package com.serversherpa.kiosk.ui.screens.rolodex

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.photo.Crop
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
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
 * Review Focus 2: a huge, rotated or transparent picture becomes an upright 512×512 JPEG on white
 * under 5 MiB, never an upload error. Real bitmaps and codecs need Robolectric's native graphics.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotoRenderTest {
    @get:Rule val fonts = NativeFontsSettled()

    private fun jpegOf(b: Bitmap): ByteArray = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
    private fun pngOf(b: Bitmap): ByteArray = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    private fun decoded(jpeg: ByteArray): Bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)!!
    private fun isJpeg(b: ByteArray) = b.size > 3 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte()

    /** A busy picture (a gradient both ways), so the JPEG isn't trivially small. */
    private fun scene(w: Int, h: Int): Bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { b ->
        val canvas = Canvas(b)
        canvas.drawPaint(Paint().apply { shader = LinearGradient(0f, 0f, w.toFloat(), 0f, Color.RED, Color.BLUE, Shader.TileMode.MIRROR) })
        canvas.drawPaint(Paint().apply { alpha = 120; shader = LinearGradient(0f, 0f, 0f, h / 7f, Color.YELLOW, Color.BLACK, Shader.TileMode.MIRROR) })
    }

    /** Within a JPEG's rounding of [expected]. */
    private fun assertColor(what: String, expected: Int, actual: Int, tolerance: Int = 24) {
        val ok = listOf(Color::red, Color::green, Color::blue).all { c -> kotlin.math.abs(c(expected) - c(actual)) <= tolerance }
        assertTrue("$what: expected #%06X, was #%06X".format(expected and 0xFFFFFF, actual and 0xFFFFFF), ok)
    }

    @Test fun aHugeSourceRendersA512SquareJpegUnderFiveMebibytes() {
        val huge = scene(4000, 3000)
        val jpeg = renderCrop(huge, 300f, 1f, 0f, 0f)
        assertTrue(isJpeg(jpeg))
        assertTrue("${jpeg.size} bytes", jpeg.size < 5 * 1024 * 1024)
        val out = decoded(jpeg)
        assertEquals(Crop.OUTPUT_PX, out.width)
        assertEquals(Crop.OUTPUT_PX, out.height)

        // The same picture as a library file: shrunk to 2048 on its long side, never decoded whole.
        val picked = decodeForCrop(jpegOf(huge))!!
        assertEquals(2048, picked.width)
        assertEquals(1536, picked.height)
        val fromFile = decoded(renderCrop(picked, 300f, 4f, 90f, -40f))
        assertEquals(512, fromFile.width)
        assertEquals(512, fromFile.height)
    }

    @Test fun aSmallPictureIsNeverEnlargedOnDecode() {
        val small = decodeForCrop(jpegOf(scene(320, 200)))!!
        assertEquals(320, small.width)
        assertEquals(200, small.height)
    }

    @Test fun aTransparentPngRendersWhiteWhereItIsClear() {
        // Left half clear, right half opaque red.
        val src = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888).also { b ->
            b.eraseColor(Color.TRANSPARENT)
            Canvas(b).drawRect(100f, 0f, 200f, 200f, Paint().apply { color = Color.RED })
        }
        val picked = decodeForCrop(pngOf(src))!!
        val out = decoded(renderCrop(picked, 1f, 1f, 0f, 0f))
        assertColor("clear part", Color.WHITE, out.getPixel(60, 256))
        assertColor("opaque part", Color.RED, out.getPixel(450, 256))
        // Handed straight to the renderer (no file in between), clear is still white.
        val direct = decoded(renderCrop(src, 1f, 1f, 0f, 0f))
        assertColor("clear part, direct", Color.WHITE, direct.getPixel(60, 256))
    }

    @Test fun anExifSixJpegDecodesUpright() {
        // Stored 200 wide × 100 tall, red left and blue right, tagged "rotate 90° clockwise to show".
        val stored = Bitmap.createBitmap(200, 100, Bitmap.Config.ARGB_8888).also { b ->
            val canvas = Canvas(b)
            canvas.drawRect(0f, 0f, 100f, 100f, Paint().apply { color = Color.RED })
            canvas.drawRect(100f, 0f, 200f, 100f, Paint().apply { color = Color.BLUE })
        }
        val upright = decodeForCrop(withExifOrientation(jpegOf(stored), 6))!!
        assertEquals(100, upright.width)
        assertEquals(200, upright.height)
        assertColor("top", Color.RED, upright.getPixel(50, 40))
        assertColor("bottom", Color.BLUE, upright.getPixel(50, 160))

        // A 1×2 picture under a square, centered: the top half of the output is red, the bottom blue.
        val out = decoded(renderCrop(upright, 1f, 1f, 0f, 0f))
        assertColor("rendered top", Color.RED, out.getPixel(256, 60))
        assertColor("rendered bottom", Color.BLUE, out.getPixel(256, 450))
    }

    @Test fun theOffsetPicksWhatTheCircleShows() {
        // Red left half, blue right half; zoomed in and moved all the way right, the circle shows the left (red) part.
        val src = Bitmap.createBitmap(400, 200, Bitmap.Config.ARGB_8888).also { b ->
            val canvas = Canvas(b)
            canvas.drawRect(0f, 0f, 200f, 200f, Paint().apply { color = Color.RED })
            canvas.drawRect(200f, 0f, 400f, 200f, Paint().apply { color = Color.BLUE })
        }
        assertColor("image moved right", Color.RED, decoded(renderCrop(src, 1f, 1f, 10f, 0f)).getPixel(256, 256))
        assertColor("image moved left", Color.BLUE, decoded(renderCrop(src, 1f, 1f, -10f, 0f)).getPixel(256, 256))
    }

    @Test fun junkAndEmptyBytesDecodeToNothing() {
        assertNull(decodeForCrop(ByteArray(0)))
        assertNull(decodeForCrop("not a picture".toByteArray()))
        assertNotNull(decodeForCrop(jpegOf(scene(10, 10))))
    }

    /** [jpeg] with an APP1 Exif segment (big-endian TIFF, one IFD entry: Orientation) after its SOI. */
    private fun withExifOrientation(jpeg: ByteArray, orientation: Int): ByteArray {
        val tiff = byteArrayOf(
            0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,                     // "MM", 42, IFD0 at 8
            0x00, 0x01,                                                         // one entry
            0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation.toByte(), 0x00, 0x00, // Orientation, SHORT, 1
            0x00, 0x00, 0x00, 0x00,                                             // no next IFD
        )
        val payload = "Exif".toByteArray() + byteArrayOf(0, 0) + tiff
        val length = payload.size + 2
        val app1 = byteArrayOf(0xFF.toByte(), 0xE1.toByte(), (length shr 8).toByte(), (length and 0xFF).toByte()) + payload
        return jpeg.copyOfRange(0, 2) + app1 + jpeg.copyOfRange(2, jpeg.size)
    }
}
