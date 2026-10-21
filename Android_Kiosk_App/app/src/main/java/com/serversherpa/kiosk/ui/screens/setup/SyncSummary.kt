package com.serversherpa.kiosk.ui.screens.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.data.sync.PartState
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.data.sync.SyncStatus
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** One row of the running sync: the part's name, its state and the text shown for both. */
data class PartLine(val label: String, val state: PartState, val text: String)

private fun partLabel(name: String) = when (name) {
    "templates" -> "Label templates"
    else -> name.replaceFirstChar { it.uppercase() }
}

/** The six downloads in display order, each with its state ("Assets · done (10)"). */
fun partLines(status: SyncStatus): List<PartLine> = status.parts.map { p ->
    val label = partLabel(p.name)
    val state = when (p.state) {
        PartState.WAITING -> "waiting"
        PartState.RUNNING -> "downloading…"
        PartState.DONE -> if (p.count != null) "done (${p.count})" else "done"
        PartState.FAILED -> "failed"
    }
    PartLine(label, p.state, "$label · $state")
}

private fun SyncStatus.doneCount(name: String): Int? = parts.firstOrNull { it.name == name && it.state == PartState.DONE }?.count

/** "Local data: 10 assets · … · 4 label templates · 2 fonts · synced 2:14 PM". Label counts
 *  appear only for a part that finished: never-synced or failed ones are left out. */
fun localDataLine(s: SyncStatus): String = buildString {
    fun n(count: Int?, one: String, many: String) = (count ?: 0).let { "$it ${if (it == 1) one else many}" }
    append("Local data: ${n(s.assets, "asset", "assets")} · ${n(s.people, "person", "people")} · ${n(s.containers, "container", "containers")} · ${n(s.trucks, "truck", "trucks")}")
    s.doneCount("templates")?.let { append(" · $it label ${if (it == 1) "template" else "templates"}") }
    s.doneCount("fonts")?.let { append(" · $it ${if (it == 1) "font" else "fonts"}") }
    s.syncedAt?.let { append(" · synced ${Sync.formatSyncedAt(it)}") }
}

/** The soft-failure warning for the label downloads, or null when none failed. */
fun labelsWarning(s: SyncStatus): String? {
    if (s.labelsError == null) return null
    val templates = s.parts.any { it.name == "templates" && it.state == PartState.FAILED }
    val fonts = s.parts.any { it.name == "fonts" && it.state == PartState.FAILED }
    val what = when {
        templates && fonts -> "Label templates and fonts"
        templates -> "Label templates"
        fonts -> "Fonts"
        else -> "Label data"
    }
    return "$what couldn't be downloaded. Labels may be out of date."
}

/** The Kiosk Setup summary's sync line: idle prompt, per-part progress while running, counts when done. */
@Composable
fun SyncSection(sync: SyncStatus, onSync: () -> Unit) {
    val c = LocalKioskColors.current
    when (sync.phase) {
        SyncPhase.RUNNING -> Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Downloading move data…")
            for (line in partLines(sync)) Text(
                line.text, fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall,
                color = when (line.state) { PartState.FAILED -> ChipTone.RED.text; PartState.DONE -> ChipTone.GREEN.text; else -> c.textMute },
            )
        }
        else -> Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (sync.phase) {
                    SyncPhase.IDLE -> { Text("No move data on this kiosk yet."); MiniButton("Sync now", onSync) }
                    SyncPhase.DONE -> { Text(localDataLine(sync), modifier = Modifier.weight(1f)); MiniButton("Sync again", onSync) }
                    else -> { KioskToast("Couldn't download move data (${sync.error ?: "unknown_error"}).", error = true); MiniButton("Try again", onSync) }
                }
            }
            if (sync.phase == SyncPhase.DONE) labelsWarning(sync)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ChipTone.AMBER.text) }
        }
    }
}
