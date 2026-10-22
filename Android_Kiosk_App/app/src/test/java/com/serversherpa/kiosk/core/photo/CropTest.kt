package com.serversherpa.kiosk.core.photo

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/** The pinned vectors from the plan's Global Constraints; iOS checks the same ones. */
class CropTest {
    private val eps = 1e-3f

    @Test fun outputConstants() {
        assertEquals(512, Crop.OUTPUT_PX)
        assertEquals(92, Crop.JPEG_QUALITY)
        assertEquals(1f, Crop.MIN_ZOOM, 0f)
        assertEquals(4f, Crop.MAX_ZOOM, 0f)
    }

    @Test fun coverFitAtZoomOneCentered() {
        assertEquals(0.6f, Crop.scale(1000f, 500f, 300f, 1f), eps)
        assertArrayEquals(floatArrayOf(250f, 0f, 500f, 500f), Crop.sourceRect(1000f, 500f, 300f, 1f, 0f, 0f), eps)
    }

    @Test fun offsetClampsSoTheImageCoversTheViewport() {
        val (dx, dy) = Crop.clampOffset(1000f, 500f, 300f, 1f, 400f, 50f)
        assertEquals(150f, dx, eps); assertEquals(0f, dy, eps)
        val (nx, ny) = Crop.clampOffset(1000f, 500f, 300f, 1f, -400f, -50f)
        assertEquals(-150f, nx, eps); assertEquals(0f, ny, eps)
    }

    @Test fun zoomTwoCentered() {
        assertArrayEquals(floatArrayOf(375f, 125f, 250f, 250f), Crop.sourceRect(1000f, 500f, 300f, 2f, 0f, 0f), eps)
    }

    @Test fun zoomClampsToOneThroughFour() {
        assertEquals(4f, Crop.clampZoom(7f), 0f)
        assertEquals(1f, Crop.clampZoom(0.2f), 0f)
        assertEquals(2.5f, Crop.clampZoom(2.5f), 0f)
        assertEquals(1f, Crop.clampZoom(Float.NaN), 0f)
        assertEquals(Crop.scale(1000f, 500f, 300f, 4f), Crop.scale(1000f, 500f, 300f, 7f), eps)
    }

    @Test fun sourceRectStaysInsideTheImageForAnOutOfRangeOffset() {
        // A drag past the edge is clamped first, so the source square never leaves the image.
        assertArrayEquals(floatArrayOf(0f, 0f, 500f, 500f), Crop.sourceRect(1000f, 500f, 300f, 1f, 999f, -999f), eps)
        assertArrayEquals(floatArrayOf(500f, 0f, 500f, 500f), Crop.sourceRect(1000f, 500f, 300f, 1f, -999f, 999f), eps)
    }
}
