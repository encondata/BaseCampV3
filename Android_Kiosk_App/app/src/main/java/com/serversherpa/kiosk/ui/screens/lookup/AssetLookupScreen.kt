package com.serversherpa.kiosk.ui.screens.lookup

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.lookup.LOOKUP_CAP
import com.serversherpa.kiosk.core.lookup.SCAN_LIMIT
import com.serversherpa.kiosk.core.lookup.matchLabel
import com.serversherpa.kiosk.core.lookup.placementText
import com.serversherpa.kiosk.core.lookup.scanWhenText
import com.serversherpa.kiosk.core.model.AssetScanRow
import com.serversherpa.kiosk.core.model.KioskAssetDetail
import com.serversherpa.kiosk.core.model.KioskAssetEnd
import com.serversherpa.kiosk.core.model.KioskLookupResult
import com.serversherpa.kiosk.core.model.headerLine
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.lookup.AssetLookupRepository
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.rfid.RfidOwner
import com.serversherpa.kiosk.ui.components.CameraFieldButton
import com.serversherpa.kiosk.ui.components.ColorChip
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.hexColor
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.scan.RfidReadPanel
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.time.ZoneId

private const val BLANK = "—"

/**
 * Asset Lookup (port of kiosk/src/pages/AssetLookup.tsx): one box for an asset tag, serial,
 * RFID or name, from typing, DataWedge, the camera or a one-tag sled sweep. Read-only: the
 * view model takes no Outbox. The web's wide tables are stacked rows here so the screen fits
 * the MC2200 at 320 dp; long values wrap rather than clip.
 *
 * Until Kiosk Setup is complete (only a developer gets here then) the box and Search are off
 * and scanner and sled reads are not passed on, as the web blocks a lookup without setup.
 */
@OptIn(ExperimentalFoundationApi::class)   // BringIntoViewRequester
@Composable
fun AssetLookupScreen(@Suppress("UNUSED_PARAMETER") nav: NavController) {
    val container = LocalAppContainer.current
    val vm = kioskViewModel {
        AssetLookupViewModel(
            AssetLookupRepository(container.api, container.db), container.identity,
            { (container.auth.state.value as? AuthState.Authed)?.isAdmin == true },
            { container.auth.can("scans", "view") },
        )
    }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    val setupState by container.prefs.setupState.collectAsStateWithLifecycle(initialValue = SetupState.INCOMPLETE)
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val rfidSession by container.rfid.session.collectAsStateWithLifecycle()
    val ready = setupState.isComplete && setup != null
    val readyNow by rememberUpdatedState(ready)
    // The server refuses the scans route without it too; recomputed when the session changes.
    val canScans = remember(auth) { container.auth.can("scans", "view") }
    var camera by remember { mutableStateOf(false) }
    // On a phone the list stacks above the card, so a picked row's card opens off screen:
    // the list stays (as on the web) and the card is scrolled into view.
    val cardInView = remember { BringIntoViewRequester() }
    val picked = ui.detail?.takeIf { ui.list != null }
    LaunchedEffect(picked) { if (picked != null) cardInView.bringIntoView() }

    // Both collectors run on Main (Compose's dispatcher), so the view model is only ever
    // called from the main thread, never from the sled's own threads.
    LaunchedEffect(Unit) { container.scanBus.events.collect { if (readyNow) vm.onScan(it.value) } }
    LaunchedEffect(Unit) {
        container.rfid.burstsFor(RfidOwner.LOOKUP).collect { epcs ->
            if (readyNow) vm.onSweep(epcs)
            // A lookup sends nothing anywhere: under a "skip tags already sent" sweep policy the
            // controller would otherwise drop a second sweep of the same tag on this screen.
            container.rfid.forgetQueued(epcs)
        }
    }
    // The sled's trigger is this screen's RFID input while it is open (as on Scanning). Its
    // own owner key: Scanning's late dispose can't disarm it, and only its own sweeps land here.
    DisposableEffect(ready) {
        if (ready) container.rfid.arm(RfidOwner.LOOKUP)
        onDispose { if (ready) container.rfid.disarm(RfidOwner.LOOKUP) }
    }

    // A full-screen dialog: it floats over this page rather than replacing it.
    if (camera) CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false })

    Column {
        PageHeader("Kiosk · Asset Lookup", "Asset Lookup", setup?.headerLine() ?: "Finish Kiosk Setup first.")
        // While the sled reads, its live panel (with Stop, for a latched or toggled read) takes
        // the box's place, as on Scanning. A lookup sends nothing, so there's no "already sent".
        val burst = rfidSession
        if (burst != null) {
            RfidReadPanel(session = burst, showSkipped = false, onStop = { container.rfid.stopBurst() })
        } else {
            ScanInput(
                ui.value, vm::onValueChange, onSubmit = { if (ready) vm.onScan(it) },
                placeholder = "Scan or type an asset tag, serial, RFID, or name",
                enabled = ready, keepFocus = !camera,
                trailingIcon = if (container.hasCamera) ({ CameraFieldButton(ready) { camera = true } }) else null,
            )
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SolidButton("Search", onClick = { if (ready) vm.lookup() }, enabled = ready, modifier = Modifier.weight(1f))
            MiniButton("Clear", { vm.clear() })
        }
        if (ui.offline) OfflineLine()
        ui.miss?.let { KioskToast("No asset matches $it.", error = true) }
        KioskToast(ui.error, error = true)
        KioskToast(ui.notice)
        ui.list?.let { MatchList(it, vm::pick) }
        ui.detail?.let { DetailCard(it, ui.scans, ui.offline, canScans, Modifier.bringIntoViewRequester(cardInView)) }
    }
}

@Composable
private fun OfflineLine() {
    Text(
        "Offline — showing this move's devices only.", style = MaterialTheme.typography.bodyMedium,
        color = LocalKioskColors.current.textDark,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).background(ChipTone.AMBER.bg, RoundedCornerShape(10.dp))
            .border(1.dp, ChipTone.AMBER.border, RoundedCornerShape(10.dp)).padding(12.dp),
    )
}

/** The matches as stacked rows: tap one to open it. "Matched on" only when a match isn't by name. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MatchList(list: KioskLookupResult, onPick: (String) -> Unit) {
    val c = LocalKioskColors.current
    val matches = list.matches.take(LOOKUP_CAP)
    val showMatched = matches.any { m -> m.matched.any { it != "name" } }
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        HorizontalDivider(color = c.paperLine)
        for (m in matches) {
            Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { onPick(m.id) }.padding(vertical = 8.dp)) {
                Text(
                    m.name?.takeIf { it.isNotBlank() } ?: "Unnamed asset", style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold, color = c.accent,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Fact("Asset tag", m.asset_tag.ifBlank { BLANK })
                    Fact("Serial", m.serial_number?.takeIf { it.isNotBlank() } ?: BLANK)
                    if (showMatched) Fact("Matched on", m.matched.joinToString(", ") { matchLabel(it) }, mono = false)
                }
            }
            HorizontalDivider(color = c.paperLine)
        }
        if (list.truncated) Hint("Refine your search")
    }
}

/** The details card: identity, each route's two ends, and for admins Moves and Scan history. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DetailCard(detail: KioskAssetDetail, scans: ScanHistory, offline: Boolean, canScans: Boolean, modifier: Modifier = Modifier) {
    val c = LocalKioskColors.current
    val full = detail.full
    Column(
        modifier.fillMaxWidth().padding(top = 12.dp).background(c.paper, RoundedCornerShape(14.dp))
            .border(1.dp, c.paperLine, RoundedCornerShape(14.dp)).padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(
                    detail.name?.takeIf { it.isNotBlank() } ?: "Unnamed asset",
                    style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
                )
                if (detail.make_model.isNotBlank()) Text(detail.make_model, style = MaterialTheme.typography.bodyMedium, color = c.textMute)
            }
            // No "Status" word: the chip speaks for itself. Offline the status has no color: plain.
            if (full != null) {
                Column(Modifier.padding(start = 8.dp)) {
                    if (full.status_label.isNotBlank()) ColorChip(full.status_label, hexColor(full.status_color), Modifier.widthIn(max = 160.dp))
                    else Text(BLANK, color = c.textMute)
                }
            }
        }
        FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Fact("Asset tag", detail.asset_tag.ifBlank { BLANK })
            Fact("Serial", detail.serial_number?.takeIf { it.isNotBlank() } ?: BLANK)
            Fact("RFID", detail.rfid?.takeIf { it.isNotBlank() }?.let { displayRfid(it) } ?: BLANK)
            if (full != null) Fact("Current location", placementText(full).ifBlank { BLANK }, mono = false)
        }
        val manyRoutes = detail.routes.size >= 2
        for (route in detail.routes) {
            Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
                if (manyRoutes) SectionTitle(route.initiative_name)
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    RouteEnd("Source", route.source)
                    RouteEnd("Destination", route.destination)
                }
            }
        }
        if (full != null) {
            Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
                Label("Moves")
                if (full.moves.isEmpty()) Value(BLANK, mono = false)
                for (m in full.moves) {
                    FlowRow(
                        Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(m.initiative_name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.align(Alignment.CenterVertically))
                        if (m.status_label.isNotBlank()) ColorChip(m.status_label, hexColor(m.status_color), Modifier.align(Alignment.CenterVertically))
                    }
                }
            }
            if (canScans && (offline || full.moves.isNotEmpty())) {
                Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
                    SectionTitle("Scan history")
                    when {
                        offline -> Hint("Scan history needs a connection.")
                        scans is ScanHistory.Loading -> Hint("Loading…")
                        scans is ScanHistory.Failed -> Hint("Could not load scan history.")
                        scans is ScanHistory.Rows -> HistoryRows(scans.rows)
                        else -> {}
                    }
                }
            }
        }
    }
}

/** One end of a route: Site, Rack, then RU — or Position when there is no RU. No Pod. */
@Composable
private fun RouteEnd(title: String, end: KioskAssetEnd) {
    val asPosition = end.ru.isNullOrBlank() && !end.position.isNullOrBlank()
    Column(Modifier.padding(top = 4.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        Fact("Site", end.site_name?.takeIf { it.isNotBlank() } ?: BLANK, mono = false)
        Fact("Rack", end.rack?.takeIf { it.isNotBlank() } ?: BLANK)
        if (asPosition) Fact("Position", end.position!!)
        else Fact("RU", end.ru?.takeIf { it.isNotBlank() } ?: BLANK)
    }
}

/** The web's history table as stacked rows, same fields and order. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HistoryRows(rows: List<AssetScanRow>) {
    val c = LocalKioskColors.current
    if (rows.isEmpty()) { Hint("No scans recorded for this asset."); return }
    val zone = remember { ZoneId.systemDefault() }
    HorizontalDivider(color = c.paperLine, modifier = Modifier.padding(top = 6.dp))
    for (s in rows) {
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val label = s.status_label
                if (!label.isNullOrBlank()) ColorChip(label, hexColor(s.status_color), Modifier.align(Alignment.CenterVertically))
                else Text(BLANK, color = c.textMute, modifier = Modifier.align(Alignment.CenterVertically))
                if (s.off_move) KioskChip("Off move", ChipTone.AMBER, dot = false)
                Text(scanWhenText(s.scanned_at, zone), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, modifier = Modifier.align(Alignment.CenterVertically))
                if (s.scan_type_label.isNotBlank()) ColorChip(s.scan_type_label, hexColor(s.scan_type_color), Modifier.align(Alignment.CenterVertically))
                else Text(BLANK, color = c.textMute, modifier = Modifier.align(Alignment.CenterVertically))
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Fact("Device", s.device_id.ifBlank { BLANK })
                Fact("Operator", s.operator_name?.takeIf { it.isNotBlank() } ?: BLANK, mono = false)
                Fact("Site", s.site_name?.takeIf { it.isNotBlank() } ?: BLANK, mono = false)
            }
        }
        HorizontalDivider(color = c.paperLine)
    }
    if (rows.size >= SCAN_LIMIT) Hint("Latest $SCAN_LIMIT scans shown.")
}

/** A label over its value (the web's dt/dd). The value wraps; nothing is cut off. */
@Composable
private fun Fact(label: String, value: String, mono: Boolean = true) {
    Column(Modifier.padding(top = 6.dp)) {
        Label(label)
        Value(value, mono)
    }
}

@Composable
private fun Label(text: String) =
    Text(text, fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = LocalKioskColors.current.textMute)

@Composable
private fun Value(text: String, mono: Boolean) =
    Text(text, fontFamily = if (mono) FragmentMono else null, style = MaterialTheme.typography.bodyMedium)

@Composable
private fun SectionTitle(text: String) =
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 2.dp))

@Composable
private fun Hint(text: String) =
    Text(text, style = MaterialTheme.typography.bodySmall, color = LocalKioskColors.current.textMute, modifier = Modifier.padding(top = 6.dp))
