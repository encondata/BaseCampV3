package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.core.model.RolodexRow
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.lineIcon
import com.serversherpa.kiosk.ui.screens.timeclock.screens.TcSearchIcon
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.launch

private val RefreshIcon = lineIcon("refresh", listOf("M19.5 12a7.5 7.5 0 1 1-2.2-5.3", "M19.5 4.5v3.8h-3.8"))

/** `#rrggbb` (as the API sends status and level colors) to a Color; null for anything else. */
internal fun hexColor(value: String?): Color? {
    val v = value?.trim()?.removePrefix("#") ?: return null
    if (v.length != 6 || v.any { it.lowercaseChar() !in "0123456789abcdef" }) return null
    return Color(0xFF000000L or v.toLong(16))
}

/** A pill in the status's own color (statuses can be customized in the portal); slate without one. */
@Composable
internal fun ColorChip(text: String, color: Color?, modifier: Modifier = Modifier) {
    val c = LocalKioskColors.current
    val base = color ?: ChipTone.SLATE.text
    // The status colors are bright: on light paper the words take a darker shade to stay legible.
    val ink = if (c.isDark) base else lerp(base, Color.Black, 0.4f)
    Text(
        text, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = ink, maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier.background(base.copy(alpha = 0.14f), RoundedCornerShape(999.dp))
            .border(1.dp, base.copy(alpha = 0.4f), RoundedCornerShape(999.dp)).padding(horizontal = 9.dp, vertical = 2.dp),
    )
}

/**
 * The A–Z list (mockup 2-list-chosen): header with the count and "+ New", the offline banner, a
 * search field, the filter chips with their counts, then the letter sections with a jump strip on
 * the right edge. [onNew] opens the New worker flow; "+ New" is off without it, offline, before a
 * list has loaded, and while the Edit form is open ([RolodexUi.canStartNewWorker]).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun RolodexList(
    ui: RolodexUi,
    query: String,
    onQuery: (String) -> Unit,
    onFilter: (String) -> Unit,
    onSelect: (String) -> Unit,
    onRefresh: () -> Unit,
    onNew: (() -> Unit)?,
    listState: LazyListState,
    modifier: Modifier = Modifier,
) {
    val c = LocalKioskColors.current
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val count = ui.rows.size
            val title = if (ui.loading && count == 0) "Workers" else if (count == 1) "1 worker" else "$count workers"
            Box(Modifier.weight(1f)) { PageHeader("Rolodex", title) }
            IconButton(onClick = onRefresh, enabled = !ui.loading, modifier = Modifier.testTag("rolodex-refresh").semantics { contentDescription = "Refresh" }) {
                Icon(RefreshIcon, contentDescription = null, tint = if (ui.loading) c.textMute else c.textDark)
            }
            SolidButton("+ New", onClick = { onNew?.invoke() }, enabled = onNew != null && ui.canStartNewWorker, modifier = Modifier.testTag("rolodex-new"))
        }
        val cachedAt = ui.cachedAt
        if (ui.offline && cachedAt != null) {
            Text(
                offlineBannerText(cachedAt), style = MaterialTheme.typography.bodyMedium, color = c.textDark,
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).background(ChipTone.AMBER.bg, RoundedCornerShape(10.dp))
                    .border(1.dp, ChipTone.AMBER.border, RoundedCornerShape(10.dp)).padding(12.dp).testTag("rolodex-offline"),
            )
        }
        if (ui.listError != null) {
            KioskToast(ui.listError, error = true)
            MiniButton("Try again", onClick = onRefresh, enabled = !ui.loading, modifier = Modifier.padding(bottom = 8.dp))
        }
        OutlinedTextField(
            value = query, onValueChange = onQuery, singleLine = true,
            placeholder = { Text("Search by name, job or company…", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = { Icon(TcSearchIcon, contentDescription = null, tint = c.textMute, modifier = Modifier.size(20.dp)) },
            trailingIcon = if (query.isEmpty()) null else {
                { IconButton(onClick = { onQuery("") }, modifier = Modifier.semantics { contentDescription = "Clear search" }) { Text("×", fontSize = 20.sp, color = c.textMute) } }
            },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
            modifier = Modifier.fillMaxWidth().testTag("rolodex-search"),
        )
        FilterChips(ui, onFilter, Modifier.padding(vertical = 10.dp))
        Row(Modifier.weight(1f).fillMaxWidth()) {
            Box(
                Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(14.dp)).background(c.paper)
                    .border(1.dp, c.paperLine, RoundedCornerShape(14.dp)),
            ) {
                val empty = when {
                    ui.sections.isNotEmpty() -> null
                    ui.loading -> "Loading workers…"
                    ui.rows.isEmpty() -> if (ui.listError != null) "" else "No workers yet."
                    else -> "No workers match."
                }
                if (empty != null) {
                    Text(empty, style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.padding(16.dp))
                } else {
                    LazyColumn(state = listState, modifier = Modifier.fillMaxSize().testTag("rolodex-list")) {
                        for ((letter, rows) in ui.sections) {
                            stickyHeader(key = "section-$letter") { SectionHeader(letter) }
                            items(rows, key = { it.person_id }) { row ->
                                // An open Edit form holds the selection: a stray tap can't throw away what was typed.
                                WorkerRow(row, selected = row.person_id == ui.selectedId, enabled = ui.editing == null, onClick = { onSelect(row.person_id) })
                            }
                        }
                    }
                }
            }
            if (ui.sections.size > 1) JumpStrip(ui.sections, listState, Modifier.width(24.dp).fillMaxHeight())
        }
    }
}

@Composable
private fun FilterChips(ui: RolodexUi, onFilter: (String) -> Unit, modifier: Modifier) {
    val c = LocalKioskColors.current
    val pill = RoundedCornerShape(999.dp)
    Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((key, label) in ui.filters) {
            val on = key == ui.filter
            Row(
                Modifier.clip(pill).background(if (on) c.ink else c.paper).border(1.dp, if (on) c.ink else c.paperLine, pill)
                    .clickable { onFilter(key) }.heightIn(min = 44.dp).padding(horizontal = 14.dp).testTag("filter-$key"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, style = MaterialTheme.typography.bodyMedium, color = if (on) c.snow else c.textDark)
                Text(
                    " ${ui.counts[key] ?: 0}", fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium,
                    color = if (on) c.snow.copy(alpha = 0.7f) else c.textMute,
                )
            }
        }
    }
}

@Composable
private fun SectionHeader(letter: String) {
    val c = LocalKioskColors.current
    Text(
        letter, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute,
        modifier = Modifier.fillMaxWidth().background(c.paper2).padding(horizontal = 14.dp, vertical = 6.dp).testTag("section-$letter"),
    )
}

/** One worker: 44 dp photo or initials, name, "job title · company", status chip in the status color. */
@Composable
private fun WorkerRow(row: RolodexRow, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalKioskColors.current
    val accent = c.accent
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .background(if (selected) accent.copy(alpha = 0.12f) else c.paper)
                .drawBehind { if (selected) drawRect(accent, Offset.Zero, Size(3.dp.toPx(), size.height)) }
                .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp, vertical = 9.dp)
                .testTag("rolodex-row-${row.person_id}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WorkerAvatar(row, 44.dp)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(row.display_name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark, maxLines = 1, overflow = TextOverflow.Ellipsis)
                workLine(row.job_title, row.company?.name)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (row.status_label.isNotBlank()) ColorChip(row.status_label, hexColor(row.status_color))
        }
        Spacer(Modifier.fillMaxWidth().height(1.dp).background(c.paperLine))
    }
}

/** "Rigger · Summit Crew", either half alone, or null with neither. */
internal fun workLine(jobTitle: String?, company: String?): String? =
    listOfNotNull(jobTitle?.takeIf { it.isNotBlank() }, company?.takeIf { it.isNotBlank() }).joinToString(" · ").ifEmpty { null }

/**
 * The right-edge letters: tap one, or slide along them, to jump to its section. Only the letters
 * on the list show; they shrink to fit a short window.
 */
@Composable
private fun JumpStrip(sections: List<Pair<String, List<RolodexRow>>>, listState: LazyListState, modifier: Modifier) {
    val c = LocalKioskColors.current
    val scope = rememberCoroutineScope()
    val letters = sections.map { it.first }
    // Each section is its header plus its rows in the LazyColumn.
    val headerAt = remember(sections) {
        var i = 0
        sections.associate { (letter, rows) -> (letter to i).also { i += 1 + rows.size } }
    }
    var last by remember { mutableStateOf<String?>(null) }
    fun jump(letter: String?) {
        if (letter == null || letter == last) return
        last = letter
        headerAt[letter]?.let { scope.launch { listState.scrollToItem(it) } }
    }
    BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        val slot: Dp = minOf(18.dp, maxHeight / letters.size)
        Column(
            // Keyed on the header positions: a search that keeps the same letters still moves them.
            Modifier.pointerInput(headerAt) {
                fun at(y: Float) = letters[((y / size.height) * letters.size).toInt().coerceIn(0, letters.size - 1)]
                awaitEachGesture {
                    val down = awaitFirstDown()
                    last = null
                    jump(at(down.position.y))
                    down.consume()
                    do {
                        val event = awaitPointerEvent()
                        event.changes.forEach { if (it.pressed) { jump(at(it.position.y)); it.consume() } }
                    } while (event.changes.any { it.pressed })
                }
            }.testTag("rolodex-jump"),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            for (letter in letters) {
                Box(Modifier.width(24.dp).height(slot), contentAlignment = Alignment.Center) {
                    Text(letter, fontFamily = FragmentMono, fontSize = minOf(11f, slot.value * 0.7f).sp, fontWeight = FontWeight.SemiBold, color = c.accent)
                }
            }
        }
    }
}
