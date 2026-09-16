package com.serversherpa.kiosk.ui.screens.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

@Composable
fun KioskSetupScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val vm = kioskViewModel { KioskSetupViewModel(container.api, container.prefs, container.identity, container.sync) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val selection by vm.selection.collectAsStateWithLifecycle()
    val setupState by vm.setupState.collectAsStateWithLifecycle()
    val sync by container.sync.status.collectAsStateWithLifecycle()

    Column {
        PageHeader("Kiosk · Setup", "Kiosk setup")
        // Nothing until the stored setup has been read, so an already-configured
        // kiosk never flashes step 1 of the wizard on the way to its summary.
        val wizardOpen = ui.wizardOpen ?: return@Column
        val sel = selection
        if (!wizardOpen && sel != null) {
            Text(buildString { append("This kiosk is set up for "); append(sel.initiativeName); append(" at "); append(sel.siteName); append(" ("); append(sel.siteRole); append(") · scan type "); append(sel.scanLabel) },
                style = MaterialTheme.typography.bodyLarge)
            Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (sync.phase) {
                    SyncPhase.IDLE -> { Text("No move data on this kiosk yet."); MiniButton("Sync now", { vm.resync() }) }
                    SyncPhase.RUNNING -> Text("Downloading move data…")
                    SyncPhase.DONE -> {
                        Text("Local data: ${sync.assets ?: 0} assets · ${sync.people ?: 0} people · ${sync.containers ?: 0} containers · ${sync.trucks ?: 0} trucks" + (sync.syncedAt?.let { " · synced ${Sync.formatSyncedAt(it)}" } ?: ""), modifier = Modifier.weight(1f))
                        MiniButton("Sync again", { vm.resync() })
                    }
                    SyncPhase.ERROR -> { KioskToast("Couldn't download move data (${sync.error ?: "unknown_error"}).", error = true); MiniButton("Try again", { vm.resync() }) }
                }
            }
            Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MiniButton("Change setup", { vm.openWizard(true) })
                SolidButton("Go to home", { nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } } })
            }
            return@Column
        }
        Text(when (ui.step) { 1 -> "STEP 1 OF 3 · MOVE"; 2 -> "STEP 2 OF 3 · SITE"; else -> "STEP 3 OF 3 · SCAN TYPE" }, fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute)
        if (ui.loadError) { KioskToast("Couldn't load setup options.", error = true); MiniButton("Retry", { vm.load() }); return@Column }
        val opts = ui.options
        if (opts == null) { Text("Loading moves…", color = c.textMute); return@Column }
        when (ui.step) {
            1 -> {
                Text("Which move?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                for (i in opts.initiatives) SetupCard(selected = i.id == ui.initiativeId, onClick = { vm.selectMove(i.id) }, modifier = Modifier.padding(bottom = 10.dp)) {
                    Text(i.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    KioskChip(i.status_label, if (i.status == "in_progress") ChipTone.GREEN else ChipTone.SLATE, dot = false)
                    i.client_name?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                    formatMoveDates(i)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                    Text("${i.source_site?.name ?: "—"} → ${i.destination_site?.name ?: "—"}", style = MaterialTheme.typography.bodySmall, color = c.textMute)
                }
                if (opts.initiatives.isEmpty()) Text("No active moves. Ask a coordinator to plan one.", color = c.textMute)
                if (sel != null && setupState.isComplete) MiniButton("Cancel", { vm.cancelWizard() })
            }
            2 -> {
                Text("Which site is this kiosk at?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                val choices = vm.siteChoices()
                for ((site, role) in choices) SetupCard(selected = site.id == ui.siteId, onClick = { vm.selectSite(site.id) }, modifier = Modifier.padding(bottom = 10.dp)) {
                    Text(role.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute)
                    Text(site.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                }
                if (choices.isEmpty()) Text("This move has no sites yet. Ask a coordinator to add them.", color = c.textMute)
                MiniButton("Back", { vm.back() })
            }
            else -> {
                Text("Which scan type?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                for (s in opts.scan_types) {
                    val saving = ui.submitting && ui.scanStatus == s.key
                    SetupCard(selected = s.key == ui.scanStatus, enabled = !ui.submitting, onClick = { vm.finish(s.key) }, modifier = Modifier.padding(bottom = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            androidx.compose.foundation.layout.Box(Modifier.size(14.dp).background(parseCssColor(s.color), CircleShape))
                            Text(if (saving) "Saving…" else s.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                ui.submitError?.let { KioskToast("Couldn't save the kiosk setup ($it). Try again.", error = true) }
                MiniButton("Back", { vm.back() }, enabled = !ui.submitting)
            }
        }
    }
}

/** "#abc" / "#aabbcc" → Color; anything else → slate. */
fun parseCssColor(css: String): Color {
    val v = css.trim().removePrefix("#")
    val hex = when (v.length) { 3 -> v.map { "$it$it" }.joinToString(""); 6 -> v; else -> return Color(0xFF8A97AA) }
    return runCatching { Color(0xFF000000L or hex.toLong(16)) }.getOrDefault(Color(0xFF8A97AA))
}
