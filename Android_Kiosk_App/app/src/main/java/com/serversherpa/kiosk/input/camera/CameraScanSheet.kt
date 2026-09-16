package com.serversherpa.kiosk.input.camera

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraControl
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.util.concurrent.Executors

enum class CameraMode { SINGLE, MULTI }

/** The strip that reports a multi-read session. Fixed height, so the
 *  panel can never creep up over the preview as the count grows. */
private val TALLY_HEIGHT = 40.dp

private val PANEL = Color(0xE60C1117)   // --ink at 90%: readable over any scene
private val INK = Color(0xFF0C1117)
private val SNOW = Color(0xFFE8EDF4)

/**
 * The camera scanner, as a full-screen window over the kiosk.
 *
 * It is a `Dialog` rather than page content on purpose: the screens that
 * open it live inside the kiosk shell's scrolling, padded content box, so
 * a composable placed there can never fill the screen — it collapses to
 * the preview's own height and the controls land in the middle of the
 * picture. A dialog gets its own window, so the preview is genuinely
 * full-screen and the controls sit on the bottom edge.
 *
 * SINGLE publishes the first barcode and dismisses; MULTI publishes each
 * distinct barcode once and stays open until Done. Frames are never
 * stored, and Back closes the sheet.
 */
@Composable
fun CameraScanSheet(initialMode: CameraMode = CameraMode.SINGLE, onScan: (ScanEvent) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    // The kiosk paints in the signed-in person's accent; the sheet follows it
    // rather than hardcoding one, so the frame and chips match the rest of the app.
    val accent = LocalKioskColors.current.accent
    // Read the gesture-bar inset HERE, in the activity's composition: inside a
    // Dialog the window insets report zero, so navigationBarsPadding() there is a
    // no-op and the Done button ends up drawn under the pill.
    val bottomInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    var mode by remember { mutableStateOf(initialMode) }
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var denied by remember { mutableStateOf(false) }
    var torch by remember { mutableStateOf(false) }
    val session = remember { MultiReadSession() }
    var count by remember { mutableIntStateOf(0) }
    var recent by remember { mutableStateOf(listOf<String>()) }
    var finished by remember { mutableStateOf(false) }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> granted = ok; denied = !ok }
    LaunchedEffect(Unit) { if (!granted) launcher.launch(Manifest.permission.CAMERA) }

    val executor = remember { Executors.newSingleThreadExecutor() }
    val analyzer = remember {
        // ML Kit Task listeners registered without an executor run on the main thread, so these
        // Compose state writes (finished/count/recent) from the analyzer callback are safe.
        BarcodeAnalyzer { value, symbology ->
            if (finished) return@BarcodeAnalyzer
            if (!session.offer(value)) return@BarcodeAnalyzer
            if (mode == CameraMode.SINGLE) {
                finished = true
                onScan(ScanEvent(value, ScanSource.CAMERA, symbology))
                onDismiss()
            } else {
                count = session.count; recent = session.recent
                onScan(ScanEvent(value, ScanSource.CAMERA, symbology))
            }
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            cameraProvider?.unbindAll()
            analyzer.close()
            executor.shutdown()
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        // decorFitsSystemWindows = false: the preview runs edge to edge and the
        // insets are live, so the controls below can lift themselves clear of the
        // gesture bar instead of being drawn under it.
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnClickOutside = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (granted) {
                var cameraControl by remember { mutableStateOf<CameraControl?>(null) }
                var bindError by remember { mutableStateOf(false) }
                if (bindError) {
                    Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Couldn't start the camera on this device.", color = Color.White)
                    }
                } else {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { ctx ->
                            val view = PreviewView(ctx)
                            val future = ProcessCameraProvider.getInstance(ctx)
                            future.addListener({
                                try {
                                    val provider = future.get()
                                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                                    val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                                        .also { it.setAnalyzer(executor, analyzer) }
                                    provider.unbindAll()
                                    val camera = provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                                    cameraControl = camera.cameraControl
                                    cameraProvider = provider
                                } catch (e: Exception) {
                                    bindError = true
                                }
                            }, ContextCompat.getMainExecutor(ctx))
                            view
                        },
                    )
                    // Aiming frame: a thin accent square the operator centers the label in.
                    Box(
                        Modifier.align(Alignment.Center).size(240.dp)
                            .border(2.dp, accent, RoundedCornerShape(16.dp)),
                    )
                }
                LaunchedEffect(torch, cameraControl) { cameraControl?.enableTorch(torch) }
            } else {
                Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (denied) {
                        Text("Camera access was denied. Allow it in Android Settings › Apps › ServerSherpa Kiosk.", color = Color.White)
                        TextButton(onClick = {
                            runCatching {
                                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
                                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                context.startActivity(intent)
                            }
                        }) { Text("Open Settings") }
                    } else {
                        Text("Requesting camera access…", color = Color.White)
                    }
                }
            }

            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(PANEL)
                    .padding(bottom = bottomInset)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ModeButton("Single", mode == CameraMode.SINGLE, accent) { mode = CameraMode.SINGLE }
                    ModeButton("Multi", mode == CameraMode.MULTI, accent) { mode = CameraMode.MULTI }
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { torch = !torch }) {
                        Text(if (torch) "Torch on" else "Torch off", color = if (torch) accent else SNOW)
                    }
                }
                if (mode == CameraMode.MULTI) {
                    Row(
                        Modifier.fillMaxWidth().height(TALLY_HEIGHT),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        CountChip(count, accent)
                        Row(
                            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            recent.forEach { ValueChip(it) }
                        }
                    }
                }
                Button(
                    onClick = onDismiss,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = INK),
                ) { Text(if (mode == CameraMode.MULTI) "Done" else "Close") }
            }
        }
    }
}

/** Single / Multi: the chosen one is filled, the other is an outline. */
@Composable
private fun ModeButton(label: String, on: Boolean, accent: Color, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp)) {
        Text(
            label,
            color = if (on) accent else SNOW,
            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

@Composable
private fun CountChip(count: Int, accent: Color) {
    Text(
        "$count scanned",
        color = INK,
        fontWeight = FontWeight.SemiBold,
        fontSize = 13.sp,
        modifier = Modifier.background(accent, RoundedCornerShape(999.dp)).padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
private fun ValueChip(value: String) {
    Text(
        value,
        color = SNOW,
        fontFamily = FragmentMono,
        fontSize = 12.sp,
        maxLines = 1,
        modifier = Modifier
            .background(Color(0x22FFFFFF), RoundedCornerShape(999.dp))
            .border(1.dp, Color(0x33FFFFFF), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}
