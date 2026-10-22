package com.serversherpa.kiosk.input.camera

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.serversherpa.kiosk.ui.components.lineIcon
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

// The dark photo screens (mockups 3–4: the camera, "Position your photo").
private val BACKDROP = Color(0xFF05070A)
private val BAR = Color(0xFF0C1117)
private val ERROR_RED = Color(0xFFB4202F)

/** What a capture is shot at, at most: "Position your photo" works on a 2048 px picture anyway. */
private val CAPTURE_BOUND = Size(2048, 1536)

/** The camera's Library button: a framed picture. */
private val LibraryIcon: ImageVector = lineIcon(
    "library",
    listOf("M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M3 16l5-5 4 4 3-3 6 6"),
    fills = listOf("M15.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"),
)

/** Flip: two arrows chasing round. */
private val FlipIcon: ImageVector = lineIcon(
    "flip",
    listOf("M4.5 10a7.5 7.5 0 0 1 13.4-3.6", "M18.5 3.5v3.3h-3.3", "M19.5 14a7.5 7.5 0 0 1-13.4 3.6", "M5.5 20.5v-3.3h3.3"),
)

/**
 * A full-screen window over the kiosk for the photo steps (the camera, then "Position your
 * photo"), like [CameraScanSheet]: a Dialog, so the camera fills the screen instead of the shell's
 * padded page. The steps switch inside one window, so the page under it never flashes between
 * them. Back calls [onBack]. The system bars' insets are read here, outside the window, where
 * they are live (inside a Dialog they read zero), and handed to [content].
 */
@Composable
fun PhotoStepsWindow(onBack: () -> Unit, content: @Composable (insets: PaddingValues) -> Unit) {
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Dialog(
        onDismissRequest = onBack,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(BACKDROP)) { content(PaddingValues(top = top, bottom = bottom)) }
    }
}

/** The photo screens' dark top bar: an accent back action on the left, the title centered. */
@Composable
fun PhotoStepBar(backLabel: String, backEnabled: Boolean, title: String, onBack: () -> Unit, topInset: Dp) {
    val c = LocalKioskColors.current
    Box(Modifier.fillMaxWidth().background(BAR).padding(top = topInset).heightIn(min = 52.dp).padding(horizontal = 8.dp)) {
        Text(
            title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = Color.White, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.align(Alignment.Center).padding(horizontal = 80.dp),
        )
        TextButton(onClick = onBack, enabled = backEnabled, modifier = Modifier.align(Alignment.CenterStart).heightIn(min = 48.dp).testTag("photo-back")) {
            Text(backLabel, color = c.accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.alpha(if (backEnabled) 1f else 0.45f))
        }
    }
}

/** An error line on the dark photo screens (the shell's toasts are under the window). */
@Composable
fun PhotoStepError(text: String?) {
    if (text == null) return
    Text(
        text, style = MaterialTheme.typography.bodyMedium, color = Color.White, textAlign = TextAlign.Center,
        modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth().background(ERROR_RED.copy(alpha = 0.9f), RoundedCornerShape(10.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp).testTag("photo-error"),
    )
}

/**
 * The circle's place on a photo screen [width]×[height] pixels with [reserve] pixels kept for the
 * controls below: a little above the middle, sized to the room (at most 440 dp across). Returns
 * the diameter and the center, in pixels.
 */
fun photoGuide(width: Float, height: Float, reserve: Float, density: Density): Pair<Float, Offset> = with(density) {
    val room = max(height - reserve, 120.dp.toPx())
    val diameter = max(minOf(width - 48.dp.toPx(), room - 56.dp.toPx(), 440.dp.toPx()), 120.dp.toPx())
    diameter to Offset(width / 2f, max(room * 0.5f, diameter / 2f + 40.dp.toPx()))
}

/** Dims everything but the circle [diameter] across at [center]. */
fun DrawScope.drawCircleDim(diameter: Float, center: Offset, color: Color) {
    val hole = Path().apply {
        fillType = PathFillType.EvenOdd
        addRect(Rect(Offset.Zero, size))
        addOval(Rect(center, diameter / 2f))
    }
    drawPath(hole, color)
}

/**
 * The photo picker (images only; no storage permission). Returns the call that opens it; a pick
 * comes to [onPick], a cancel to nothing. On a device without the system picker it falls back to
 * the document picker.
 */
@Composable
fun rememberPhotoPicker(onPick: (Uri) -> Unit): () -> Unit {
    val latest by rememberUpdatedState(onPick)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) latest(uri) }
    return remember(launcher) {
        { try { launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } catch (_: ActivityNotFoundException) {} }
    }
}

/**
 * The photo step (mockups 3–4), content of a [PhotoStepsWindow]: the live back camera behind a
 * dashed circle guide, "Frame the worker's face in the circle", the shutter, Flip and Library.
 * A device without a camera ([hasCamera] false, e.g. the MC2200) offers Choose photo only. A
 * denied camera says so and offers Choose photo. A capture arrives as JPEG bytes (EXIF orientation
 * set; the decoder applies it). [busyText] ("Loading photo…", "Creating…") stands in for the
 * controls while a picture is decoded or the worker created. [footer] holds the New worker
 * flow's "Continue without photo".
 */
@Composable
fun PhotoCaptureSheet(
    backLabel: String,
    onBack: () -> Unit,
    hasCamera: Boolean,
    busyText: String?,
    errorText: String?,
    onCapture: (ByteArray) -> Unit,
    onLibrary: () -> Unit,
    insets: PaddingValues,
    footer: @Composable ColumnScope.() -> Unit = {},
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val density = LocalDensity.current
    var granted by remember { mutableStateOf(hasCamera && ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var denied by remember { mutableStateOf(false) }
    var capturing by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var front by remember { mutableStateOf(false) }
    var canFlip by remember { mutableStateOf(false) }
    var bindError by remember { mutableStateOf(false) }
    var provider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
    val live = hasCamera && granted && !bindError
    val busy = busyText != null || capturing

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> granted = ok; denied = !ok }
    LaunchedEffect(Unit) { if (hasCamera && !granted) permission.launch(Manifest.permission.CAMERA) }
    // Allowing the camera in Settings works without leaving the screen.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && hasCamera && !granted &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            ) { granted = true; denied = false }
        }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer) }
    }

    // TextureView-backed, so the dim and the guide composite over it on every device.
    val previewView = remember { PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE; scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val capture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(ResolutionStrategy(CAPTURE_BOUND, ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                    .build(),
            )
            .build()
    }
    LaunchedEffect(hasCamera && granted) {
        if (!(hasCamera && granted) || provider != null) return@LaunchedEffect
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try { provider = future.get() } catch (e: Exception) { bindError = true }
        }, ContextCompat.getMainExecutor(context))
    }
    // Every photo starts on the back camera (the admin holds the device); Flip rebinds.
    LaunchedEffect(provider, front) {
        val p = provider ?: return@LaunchedEffect
        try {
            val hasBack = p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)
            val hasFront = p.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)
            canFlip = hasBack && hasFront
            val selector = if ((front && hasFront) || !hasBack) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            p.unbindAll()
            p.bindToLifecycle(lifecycle, selector, preview, capture)
            bindError = false
        } catch (e: Exception) {
            bindError = true
        }
    }
    DisposableEffect(provider) {
        val p = provider
        onDispose { p?.unbindAll() }
    }

    fun shoot() {
        if (busy || !live) return
        capturing = true
        failure = null
        val out = ByteArrayOutputStream()
        capture.takePicture(
            ImageCapture.OutputFileOptions.Builder(out).build(), ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(results: ImageCapture.OutputFileResults) { capturing = false; onCapture(out.toByteArray()) }
                override fun onError(e: ImageCaptureException) { capturing = false; failure = "Something went wrong. Try again." }
            },
        )
    }

    Column(Modifier.fillMaxSize()) {
        PhotoStepBar(backLabel, backEnabled = busyText == null, title = "Photo", onBack = onBack, topInset = insets.calculateTopPadding())
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val reserve = with(density) { (if (live) 190.dp else 170.dp).toPx() }
            val (diameter, center) = photoGuide(constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), reserve, density)
            if (live) AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
            Canvas(Modifier.fillMaxSize()) {
                drawCircleDim(diameter, center, Color.Black.copy(alpha = 0.55f))
                drawCircle(
                    Color.White.copy(alpha = 0.8f), radius = diameter / 2f, center = center,
                    style = Stroke(width = 2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(7.dp.toPx(), 6.dp.toPx()))),
                )
            }
            if (!live) {
                // Centered in the circle, a little narrower than it.
                val side = with(density) { (diameter - 32.dp.toPx()).coerceAtLeast(100.dp.toPx()) }.roundToInt()
                Layout(content = { CameraMessage(hasCamera, denied, bindError, context) }, modifier = Modifier.fillMaxSize()) { measurables, box ->
                    val message = measurables.first().measure(Constraints(maxWidth = side, maxHeight = box.maxHeight))
                    layout(box.maxWidth, box.maxHeight) {
                        message.place((center.x - message.width / 2f).roundToInt(), (center.y - message.height / 2f).roundToInt())
                    }
                }
            }
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp + insets.calculateBottomPadding()),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PhotoStepError(errorText ?: failure)
                when {
                    busyText != null -> Row(Modifier.heightIn(min = 66.dp).testTag("photo-busy"), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(busyText, style = MaterialTheme.typography.labelLarge, color = Color.White)
                    }
                    live -> Row(Modifier.widthIn(max = 420.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        RoundButton("Library", LibraryIcon, "Choose photo", enabled = !busy, onClick = onLibrary)
                        Spacer(Modifier.weight(1f))
                        Shutter(capturing, enabled = !busy, onClick = ::shoot)
                        Spacer(Modifier.weight(1f))
                        if (canFlip) RoundButton("Flip", FlipIcon, "Flip camera", enabled = !busy) { front = !front }
                        else Spacer(Modifier.width(64.dp))
                    }
                    else -> ChooseButton(onLibrary)
                }
                footer()
            }
            if (live) {
                Text(
                    "Frame the worker's face in the circle", style = MaterialTheme.typography.bodyMedium, color = Color.White,
                    fontWeight = FontWeight.Medium, modifier = Modifier.align(Alignment.TopCenter).padding(top = 14.dp),
                )
            }
        }
    }
}

/** In the circle when there's no live camera: nothing on a device without one, the denied copy, or the wait for access. */
@Composable
private fun CameraMessage(hasCamera: Boolean, denied: Boolean, bindError: Boolean, context: android.content.Context) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        when {
            !hasCamera -> Unit
            bindError -> Text("Couldn't start the camera on this device.", color = Color.White, textAlign = TextAlign.Center)
            denied -> {
                Text(
                    "Camera access is off. Turn it on in Settings, or choose a photo instead.", color = Color.White,
                    style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, modifier = Modifier.testTag("photo-denied"),
                )
                TextButton(onClick = {
                    runCatching {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(intent)
                    }
                }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Open Settings", color = c.accent, fontWeight = FontWeight.SemiBold) }
            }
            else -> Text("Requesting camera access…", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ChooseButton(onClick: () -> Unit) {
    val c = LocalKioskColors.current
    Button(
        onClick = onClick, modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth().heightIn(min = 48.dp).testTag("photo-choose"),
        shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.ink),
    ) { Text("Choose photo") }
}

@Composable
private fun Shutter(capturing: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(80.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = "Take photo" }.testTag("photo-shutter"),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(76.dp).border(4.dp, Color.White.copy(alpha = 0.35f), CircleShape))
        Box(Modifier.size(66.dp).background(Color.White, CircleShape))
        if (capturing) CircularProgressIndicator(color = Color.Black, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
    }
}

@Composable
private fun RoundButton(title: String, icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    Column(
        Modifier.widthIn(min = 64.dp).heightIn(min = 64.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }.alpha(if (enabled) 1f else 0.45f),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(46.dp).background(Color.White.copy(alpha = 0.14f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.height(4.dp))
        Text(title, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = Color.White)
    }
}
