package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.screens.scan.ScanTools
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

@Composable
fun TimeclockScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel { TimeclockViewModel(container.db, container.sync, container.api, container.prefs, container.identity, container.flash, container.sound) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    var camera by remember { mutableStateOf(false) }
    val empty = ui.loadStatus == LoadStatus.READY && ui.rosterSize == 0
    val disabled = ui.loadStatus != LoadStatus.READY || empty

    LaunchedEffect(Unit) { container.scanBus.events.collect { vm.onScan(it.value) } }

    if (camera) { CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false }); return }

    Column(Modifier.pointerInput(Unit) { awaitPointerEventScope { while (true) { awaitPointerEvent(); vm.bumpIdle() } } }) {
        PageHeader("Kiosk · Timeclock", "Timeclock", setup?.let { "${it.initiativeName} · ${it.siteName}" } ?: "Finish Kiosk Setup first.")
        if (ui.loadStatus == LoadStatus.ERROR) KioskToast("Couldn't read this kiosk's local data.", error = true)
        if (empty) Text("No people on this kiosk. Sync from Kiosk Setup.", color = c.textMute)
        KioskToast(ui.toast)
        val selected = ui.selected
        if (selected != null) {
            val status = ui.status
            val name = status?.person?.display_name ?: selected.displayName
            SetupCard(selected = true, onClick = {}) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Avatar(status?.person?.avatar_url, name, container)
                    Column {
                        Text(name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        when {
                            ui.statusPhase == LoadStatus.LOADING -> Text("Checking the portal…", color = c.textMute)
                            ui.statusPhase == LoadStatus.ERROR -> Text("Status unavailable", color = ChipTone.RED.text)
                            status != null && status.clocked_in && status.entry != null -> {
                                Text("Clocked in for ${formatMinutes(minutesSince(status.entry.started_at, ui.nowMs))}", color = ChipTone.GREEN.text)
                                Text(listOfNotNull("since ${clockTime(status.entry.started_at)}", status.entry.initiative_name, status.entry.site_name).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = c.textMute)
                            }
                            status != null -> {
                                Text("Not clocked in", color = c.textMute)
                                status.last_entry?.let { Text("Last clock-out ${clockTime(it.ended_at)}", style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                            }
                        }
                    }
                }
            }
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SolidButton(if (ui.punching) "Working…" else if (status?.clocked_in == true) "Clock out" else "Clock in", onClick = { vm.punch() }, enabled = ui.statusPhase == LoadStatus.READY && !ui.punching, modifier = Modifier.weight(1f))
                MiniButton("Cancel", { vm.toEntry() })
            }
            KioskToast(ui.error, error = true)
        } else {
            ScanInput(ui.value, vm::onChange, onSubmit = { vm.onEnter(it) }, placeholder = "Scan a badge or type a name", enabled = !disabled, keepFocus = !camera)
            ScanTools(container.hasCamera, { camera = true }, container.hasDataWedge) { DataWedge.softScan(context, true) }
            KioskToast(ui.error, error = true)
            for (p in ui.results) {
                Row(Modifier.fillMaxWidth().clickable { vm.select(p) }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(p.displayName, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    if (p.isWorker) KioskChip("worker", ChipTone.SLATE, dot = false)
                    if (p.hasAccount) KioskChip("account", ChipTone.SLATE, dot = false)
                    p.rfidTag?.let { Text(displayRfid(it), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute) }
                }
            }
        }
    }
}

/** The presigned avatar fetched with OkHttp (no image library); initials until it lands or if it fails. */
@Composable
private fun Avatar(url: String?, name: String, container: AppContainer) {
    val c = LocalKioskColors.current
    var bitmap by remember(url) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(url) {
        if (url == null) return@LaunchedEffect
        bitmap = withContext(Dispatchers.IO) {
            runCatching {
                container.httpClient.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    r.body?.bytes()?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
                }
            }.getOrNull()
        }
    }
    val bmp = bitmap
    if (bmp != null) Image(bmp, contentDescription = null, modifier = Modifier.size(64.dp).background(c.paper2, CircleShape))
    else Box(Modifier.size(64.dp).background(c.paper2, CircleShape), contentAlignment = Alignment.Center) { Text(initialsOf(name), style = MaterialTheme.typography.titleLarge, color = c.textMute) }
}
