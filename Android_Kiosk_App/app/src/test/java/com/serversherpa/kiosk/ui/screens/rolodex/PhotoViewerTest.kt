package com.serversherpa.kiosk.ui.screens.rolodex

import android.graphics.Bitmap
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The photo viewer keeps clear of the side insets: in landscape with 3-button navigation the
 * navigation bar (or a display cutout) sits at a side, and Close and the photo stay out from under
 * it. The insets are the ones its window reads outside the dialog ([PhotoStepsWindow]).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w800dp-h360dp-land-mdpi")
class PhotoViewerTest {
    @get:Rule val compose = createComposeRule()

    private val photo = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).asImageBitmap()

    private fun check(insets: PaddingValues, startPx: Float, endPx: Float) {
        compose.setContent { KioskTheme { PhotoViewerContent(photo, "Ann Abbott", insets) {} } }
        compose.waitForIdle()
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val close = compose.onNodeWithTag("photo-viewer-close").fetchSemanticsNode().boundsInRoot
        val image = compose.onNodeWithTag("photo-viewer-image").fetchSemanticsNode().boundsInRoot
        assertTrue("Close is under the end inset: $close in $root", close.right <= root.right - endPx)
        assertTrue("the photo is under the end inset: $image in $root", image.right <= root.right - endPx - 16f)
        assertTrue("the photo is under the start inset: $image in $root", image.left >= root.left + startPx + 16f)
        assertTrue("Close is under the status bar", close.top >= 24f)
    }

    /** The navigation bar on the right (rotated one way). */
    @Test fun closeStaysClearOfANavigationBarAtTheEnd() = check(PaddingValues(top = 24.dp, end = 48.dp), startPx = 0f, endPx = 48f)

    /** The navigation bar on the left (rotated the other way), with a cutout's inset. */
    @Test fun thePhotoStaysClearOfANavigationBarAtTheStart() = check(PaddingValues(start = 48.dp, top = 24.dp, end = 30.dp), startPx = 48f, endPx = 30f)
}
