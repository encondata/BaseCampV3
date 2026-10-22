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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.station.TIMECLOCK_STATION
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
    val vm = kioskViewModel {
        KioskSetupViewModel(
            container.api, container.prefs, container.identity, container.sync,
            stationKeys = container.stationKeys,
            signInBeat = { container.heartbeat.signInNow() },
            signOut = { container.logout() },
        )
    }
    // A move-password session is locked to its move: no "No move" for it (KioskSetup.tsx).
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val moveLocked = (auth as? AuthState.Authed)?.kioskMove != null
    val ui by vm.state.collectAsStateWithLifecycle()
    val selection by vm.selection.collectAsStateWithLifecycle()
    val setupState by vm.setupState.collectAsStateWithLifecycle()
    val sync by container.sync.status.collectAsStateWithLifecycle()
    val setupClear by container.prefs.setupClear.collectAsStateWithLifecycle(initialValue = null)

    Column {
        PageHeader("Kiosk · Setup", "Kiosk setup")
        // Raised when a Clear Setup from the portal is applied; dismissed when setup completes.
        if (setupClear?.notice == true) KioskToast("An administrator cleared this kiosk's setup. Run Kiosk Setup to continue.")
        // Nothing until the stored setup has been read, so an already-configured
        // kiosk never flashes step 1 of the wizard on the way to its summary.
        val wizardOpen = ui.wizardOpen ?: return@Column
        val sel = selection
        if (!wizardOpen && sel != null) {
            if (sel.stationType == TIMECLOCK_STATION) {
                // A Time Clock station downloads no move data.
                Text(buildString { append("This kiosk is a Time Clock station for "); append(sel.initiativeId?.let { sel.initiativeName } ?: "no move"); append(" at "); append(sel.siteId?.let { sel.siteName } ?: "no site"); append(".") },
                    style = MaterialTheme.typography.bodyLarge)
            } else {
                Text(buildString { append("This kiosk is set up for "); append(sel.initiativeName); append(" at "); append(sel.siteName); append(" ("); append(sel.siteRole); append(") · scan type "); append(sel.scanLabel) },
                    style = MaterialTheme.typography.bodyLarge)
                SyncSection(sync, onSync = { vm.resync() })
            }
            Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MiniButton("Change setup", { vm.openWizard(true) })
                SolidButton("Go to home", { nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } } })
            }
            return@Column
        }
        Text(stepLabel(ui.step, ui.kind), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute)
        val canCancel = sel != null && setupState.isComplete
        if (ui.step == 0) {
            Text("What is this kiosk?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
            for ((kind, title, blurb) in KIND_CHOICES) {
                SetupCard(selected = kind == ui.kind, onClick = { vm.selectKind(kind) }, modifier = Modifier.padding(bottom = 10.dp).testTag("setup-kind-${kind.name}")) {
                    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(blurb, style = MaterialTheme.typography.bodySmall, color = c.textMute)
                }
            }
            if (canCancel) MiniButton("Cancel", { vm.cancelWizard() })
            return@Column
        }
        if (ui.loadError) { KioskToast("Couldn't load setup options.", error = true); MiniButton("Retry", { vm.load() }); return@Column }
        val opts = ui.options
        if (opts == null) { Text("Loading moves…", color = c.textMute); return@Column }
        val timeclock = ui.kind == SetupKind.TIMECLOCK
        when (ui.step) {
            1 -> {
                Text("Which move?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                if (timeclock && !moveLocked) SetupCard(selected = ui.noMove, onClick = { vm.selectNoMove() }, modifier = Modifier.padding(bottom = 10.dp).testTag("setup-no-move")) {
                    Text("No move", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text("Punches are filed under no move and sorted out later in the portal.", style = MaterialTheme.typography.bodySmall, color = c.textMute)
                }
                for (i in opts.initiatives) SetupCard(selected = i.id == ui.initiativeId, onClick = { vm.selectMove(i.id) }, modifier = Modifier.padding(bottom = 10.dp)) {
                    Text(i.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    KioskChip(i.status_label, if (i.status == "in_progress") ChipTone.GREEN else ChipTone.SLATE, dot = false)
                    i.client_name?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                    formatMoveDates(i)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                    Text("${i.source_site?.name ?: "—"} → ${i.destination_site?.name ?: "—"}", style = MaterialTheme.typography.bodySmall, color = c.textMute)
                }
                if (opts.initiatives.isEmpty()) Text("No active moves. Ask a coordinator to plan one.", color = c.textMute)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MiniButton("Back", { vm.back() })
                    if (canCancel) MiniButton("Cancel", { vm.cancelWizard() })
                }
            }
            2 -> {
                Text("Which site is this kiosk at?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                val choices = vm.siteChoices()
                val anySite = timeclock && ui.noMove
                // No site only without a move: a move's station always stands at one of its sites.
                if (anySite) SetupCard(selected = ui.noSite, enabled = !ui.submitting, onClick = { vm.selectNoSite() }, modifier = Modifier.padding(bottom = 10.dp).testTag("setup-no-site")) {
                    Text(if (ui.submitting && ui.noSite) "Saving…" else "No site", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                }
                for ((site, role) in choices) SetupCard(selected = site.id == ui.siteId, enabled = !ui.submitting, onClick = { vm.selectSite(site.id) }, modifier = Modifier.padding(bottom = 10.dp)) {
                    if (role.isNotEmpty()) Text(role.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute)
                    Text(if (ui.submitting && site.id == ui.siteId) "Saving…" else site.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                }
                if (choices.isEmpty() && !anySite) Text("This move has no sites yet. Ask a coordinator to add them.", color = c.textMute)
                // A Time Clock station saves straight from this step.
                if (timeclock) ui.submitError?.let { KioskToast("Couldn't save the kiosk setup ($it). Try again.", error = true) }
                if (timeclock) ui.keyError?.let { KioskToast("The kiosk setup was saved, but the station key didn't arrive ($it). Try again.", error = true) }
                MiniButton("Back", { vm.back() }, enabled = !ui.submitting)
            }
            3 -> {
                Text("Which scan type?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                for (s in opts.scan_types) {
                    SetupCard(selected = s.key == ui.scanStatus, onClick = { vm.selectScanType(s.key) }, modifier = Modifier.padding(bottom = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            androidx.compose.foundation.layout.Box(Modifier.size(14.dp).background(parseCssColor(s.color), CircleShape))
                            Text(s.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                MiniButton("Back", { vm.back() })
            }
            else -> {
                Text("What do labels print on?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                for ((kind, title, blurb) in LABEL_KIND_CHOICES) {
                    val saving = ui.submitting && ui.labelKind == kind
                    SetupCard(selected = kind == ui.labelKind, enabled = !ui.submitting, onClick = { vm.finish(kind) }, modifier = Modifier.padding(bottom = 10.dp)) {
                        Text(if (saving) "Saving…" else title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(blurb, style = MaterialTheme.typography.bodySmall, color = c.textMute)
                    }
                }
                ui.submitError?.let { KioskToast("Couldn't save the kiosk setup ($it). Try again.", error = true) }
                MiniButton("Back", { vm.back() }, enabled = !ui.submitting)
            }
        }
    }
}

/** The first step's cards: what kind of kiosk, its title and its one-line description. */
private val KIND_CHOICES = listOf(
    Triple(SetupKind.REGULAR, "Regular kiosk", "Scan, enroll and print with a signed-in crew."),
    Triple(SetupKind.TIMECLOCK, "Time Clock", "Crews clock in and out here; it stays ready on its own."),
)

/** "STEP 2 OF 5 · MOVE" for a regular kiosk, "STEP 2 OF 3 · MOVE" for a Time Clock station. */
internal fun stepLabel(step: Int, kind: SetupKind?): String {
    val names = listOf("KIOSK TYPE", "MOVE", "SITE", "SCAN TYPE", "LABELS")
    val total = when (kind) { SetupKind.TIMECLOCK -> 3; SetupKind.REGULAR -> 5; null -> null }
    val name = names[step.coerceIn(0, names.lastIndex)]
    return if (total == null) "STEP ${step + 1} · $name" else "STEP ${step + 1} OF $total · $name"
}

/** The last step's cards: the label kind, its title and its one-line description. */
private val LABEL_KIND_CHOICES = listOf(
    Triple("top", "Top", "Labels for the top of the device."),
    Triple("front", "Front", "Labels for the front of the device."),
)

/** "#abc" / "#aabbcc" → Color; anything else → slate. */
fun parseCssColor(css: String): Color {
    val v = css.trim().removePrefix("#")
    val hex = when (v.length) { 3 -> v.map { "$it$it" }.joinToString(""); 6 -> v; else -> return Color(0xFF8A97AA) }
    return runCatching { Color(0xFF000000L or hex.toLong(16)) }.getOrDefault(Color(0xFF8A97AA))
}
