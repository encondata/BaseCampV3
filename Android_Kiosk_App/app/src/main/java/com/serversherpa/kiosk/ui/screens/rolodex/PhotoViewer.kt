package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.input.camera.PhotoStepsWindow
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/**
 * The worker's photo, large and whole: full screen on the photo steps' dark backdrop, scaled to fit
 * ([ContentScale.Fit]) and never cut to the avatar's circle. The saved photo is the square chosen in
 * "Position your photo" (the original isn't kept), so whole means all of that square. Close, a tap
 * anywhere or Back closes it. [photo] is the avatar's own bitmap ([rememberWorkerPhoto]), so nothing
 * is fetched again.
 */
@Composable
internal fun PhotoViewer(photo: ImageBitmap, name: String, onClose: () -> Unit) {
    PhotoStepsWindow(onBack = onClose) { insets -> PhotoViewerContent(photo, name, insets, onClose) }
}

/** The viewer inside its window. [insets] are the system bars' and the display cutout's (read
 *  outside the window, where they are live): the photo and Close stay clear of all four sides, so
 *  in landscape with 3-button navigation Close never sits under the side navigation bar. */
@Composable
internal fun PhotoViewerContent(photo: ImageBitmap, name: String, insets: PaddingValues, onClose: () -> Unit) {
    val c = LocalKioskColors.current
    val close by rememberUpdatedState(onClose)
    val direction = LocalLayoutDirection.current
    val start = insets.calculateStartPadding(direction)
    val end = insets.calculateEndPadding(direction)
    // A tap anywhere closes it. Not `clickable`: that would merge the photo into one node.
    Box(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures { close() } }.testTag("photo-viewer")) {
        Image(
            photo, contentDescription = "Photo of $name", contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize()
                .padding(start = start + 16.dp, end = end + 16.dp, top = insets.calculateTopPadding() + 60.dp, bottom = insets.calculateBottomPadding() + 16.dp)
                .testTag("photo-viewer-image"),
        )
        TextButton(
            onClick = onClose,
            modifier = Modifier.align(Alignment.TopEnd).padding(top = insets.calculateTopPadding() + 6.dp, end = end + 8.dp)
                .heightIn(min = 48.dp).testTag("photo-viewer-close"),
        ) {
            Text("Close", color = c.accent, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
        }
    }
}
