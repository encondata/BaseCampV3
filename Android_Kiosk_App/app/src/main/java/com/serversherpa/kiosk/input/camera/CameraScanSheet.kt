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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
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
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import java.util.concurrent.Executors

enum class CameraMode { SINGLE, MULTI }

/**
 * Full-screen camera scanner. SINGLE publishes the first barcode and
 * dismisses; MULTI publishes each distinct barcode once and stays open
 * until Done. Frames are never stored.
 */
@Composable
fun CameraScanSheet(initialMode: CameraMode = CameraMode.SINGLE, onScan: (ScanEvent) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
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
                // Reticle
                Box(Modifier.align(Alignment.Center).size(240.dp).background(Color.Transparent)
                    .padding(2.dp)) {
                    Box(Modifier.fillMaxSize().background(Color.Transparent))
                }
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
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color(0xCC0C1117)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { mode = CameraMode.SINGLE }) { Text(if (mode == CameraMode.SINGLE) "● Single" else "Single", color = Color.White) }
                TextButton(onClick = { mode = CameraMode.MULTI }) { Text(if (mode == CameraMode.MULTI) "● Multi" else "Multi", color = Color.White) }
                TextButton(onClick = { torch = !torch }) { Text(if (torch) "Torch on" else "Torch off", color = Color.White) }
            }
            if (mode == CameraMode.MULTI) {
                Text("$count scanned", color = Color.White)
                recent.forEach { Text(it, color = Color(0xFFE8EDF4)) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onDismiss) { Text(if (mode == CameraMode.MULTI) "Done" else "Close") }
            }
        }
    }
}
