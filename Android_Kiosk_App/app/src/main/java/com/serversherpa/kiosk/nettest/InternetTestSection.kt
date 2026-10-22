package com.serversherpa.kiosk.nettest

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.math.BigDecimal
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.launch

/**
 * Internet Test in Settings › Developer (design 4.1): the switch, when it turns
 * itself off, and while it is on, the Internet and Local network dials. The
 * Developer panel shows it only with Developer mode on, and the Developer tab
 * itself needs the developer role.
 */
@Composable
fun InternetTestSection() {
    val internetTest = LocalAppContainer.current.internetTest
    val c = LocalKioskColors.current
    val scope = rememberCoroutineScope()
    val s by internetTest.settings.collectAsStateWithLifecycle()
    // The same rule as InternetTest.turnsOffAtMs(), on the snapshot this screen shows.
    val offAt = s.takeIf { it.enabled }?.armedAtMs?.let(::turnsOffAtMs)
    SettingsRow(
        "Internet Test",
        "Slows this app's own traffic to test bad networks. Off: the app uses its normal connections, untouched. " +
            "Turns itself off after 2 hours, or when you sign out or setup is cleared.",
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Switch(
                    checked = s.enabled,
                    onCheckedChange = { on -> scope.launch { internetTest.setEnabled(on) } },
                    modifier = Modifier.semantics { contentDescription = "Internet Test" },
                )
                if (offAt != null) Text("Turns off at ${clockTime(offAt)}", style = MaterialTheme.typography.bodyMedium, color = c.textDark)
            }
            if (s.enabled) {
                for (dial in Dial.entries) {
                    DialCard(
                        dial = dial,
                        setting = s.dial(dial),
                        onChoose = { preset -> scope.launch { internetTest.choosePreset(dial, preset) } },
                        onCustom = { profile -> scope.launch { internetTest.setCustom(dial, profile) } },
                    )
                }
            }
        }
    }
}

/** One dial's card: its title and caption, its preset chips, then the summary or the Custom boxes. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DialCard(dial: Dial, setting: DialSetting, onChoose: (Preset) -> Unit, onCustom: (LinkProfile) -> Unit) {
    val c = LocalKioskColors.current
    val selected = setting.selectedPreset(dial)
    Column(
        Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.paper)
            .border(1.dp, c.paperLine, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 10.dp)
            .testTag("net-test-dial-${dial.key}"),
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text(dial.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.textDark, modifier = Modifier.alignByBaseline())
            Text(
                dial.caption, style = MaterialTheme.typography.bodySmall, color = c.textMute, textAlign = TextAlign.End,
                modifier = Modifier.alignByBaseline().weight(1f).padding(start = 8.dp),
            )
        }
        FlowRow(
            Modifier.padding(vertical = 8.dp).selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (preset in dial.presets) PresetChip(preset.label, preset == selected) { onChoose(preset) }
        }
        when (selected) {
            Preset.CUSTOM -> CustomGrid(dial, setting.custom, onCustom)
            else -> Summary(selected.profile?.let(::summaryLines) ?: listOf("Not conditioned"))
        }
    }
}

/** A preset as a pill: accent-filled while it is the dial's choice. */
@Composable
private fun PresetChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = LocalKioskColors.current
    val shape = RoundedCornerShape(999.dp)
    Box(
        Modifier.clip(shape).background(if (selected) c.accent else c.paper2).border(1.dp, if (selected) c.accent else c.paperLine, shape)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 32.dp).padding(horizontal = 10.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label, style = MaterialTheme.typography.bodySmall, color = if (selected) c.ink else c.textDark,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

/** The chosen preset's values, one mono line per direction (plus DNS when it has one). */
@Composable
private fun Summary(lines: List<String>) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.paper2).padding(horizontal = 8.dp, vertical = 6.dp)) {
        for (line in lines) Text(line, style = MaterialTheme.typography.bodySmall, fontFamily = FragmentMono, color = c.textDark)
    }
}

/**
 * Custom's six boxes: Speed, Delay and Drop for Download and Upload. Each edit
 * saves all six through [onSave] (the controller clamps them), and the boxes
 * keep the text as typed, so nothing is reformatted under the cursor. A fresh
 * grid starts from the saved values.
 */
@Composable
private fun CustomGrid(dial: Dial, saved: LinkProfile, onSave: (LinkProfile) -> Unit) {
    val texts = remember(dial) { mutableStateListOf(*CustomBox.entries.map { it.textOf(saved) }.toTypedArray()) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.width(LABEL_WIDTH))
            for (heading in listOf("Download", "Upload")) GridLabel(heading, Modifier.weight(1f))
        }
        for (row in CustomBox.entries.chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                GridLabel(row.first().row, Modifier.width(LABEL_WIDTH))
                for (box in row) {
                    NumberBox(
                        text = texts[box.ordinal],
                        decimal = box.decimal,
                        modifier = Modifier.weight(1f).testTag("net-test-${dial.key}-${box.tag}"),
                    ) { typed ->
                        val clean = if (box.decimal) decimalOnly(typed) else digitsOnly(typed)
                        if (clean != texts[box.ordinal]) {
                            texts[box.ordinal] = clean
                            onSave(profileOf(texts, dnsDelayMs = saved.dnsDelayMs))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GridLabel(text: String, modifier: Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = LocalKioskColors.current.textMute, modifier = modifier)
}

/** `.box`: a small mono number field, outlined in the accent while it has focus. */
@Composable
private fun NumberBox(text: String, decimal: Boolean, modifier: Modifier, onChange: (String) -> Unit) {
    val c = LocalKioskColors.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    BasicTextField(
        value = text,
        onValueChange = onChange,
        modifier = modifier,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FragmentMono, color = c.textDark),
        keyboardOptions = KeyboardOptions(keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number),
        cursorBrush = SolidColor(c.accent),
        interactionSource = interaction,
        decorationBox = { field ->
            Box(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(7.dp)).background(c.paper)
                    .border(1.dp, if (focused) c.accent else c.paperLine, RoundedCornerShape(7.dp))
                    .heightIn(min = 36.dp).padding(horizontal = 8.dp, vertical = 6.dp),
                contentAlignment = Alignment.CenterStart,
            ) { field() }
        },
    )
}

/** The six Custom boxes in grid order (row by row, Download then Upload). */
private enum class CustomBox(val tag: String, val row: String, val decimal: Boolean) {
    DOWN_SPEED("down-speed", "Speed (kbps)", false),
    UP_SPEED("up-speed", "Speed (kbps)", false),
    DOWN_DELAY("down-delay", "Delay (ms)", false),
    UP_DELAY("up-delay", "Delay (ms)", false),
    DOWN_DROP("down-drop", "Drop (%)", true),
    UP_DROP("up-drop", "Drop (%)", true);

    /** The box's text for a saved profile: blank for no speed limit, drops without trailing zeros. */
    fun textOf(p: LinkProfile): String = when (this) {
        DOWN_SPEED -> p.downKbps?.toString().orEmpty()
        UP_SPEED -> p.upKbps?.toString().orEmpty()
        DOWN_DELAY -> p.downDelayMs.toString()
        UP_DELAY -> p.upDelayMs.toString()
        DOWN_DROP -> dropText(p.downDropPct)
        UP_DROP -> dropText(p.upDropPct)
    }
}

/**
 * The profile the six box texts describe, before clamping. A blank speed is no
 * limit, and a blank delay or drop is 0. A number too long for an Int is read as
 * the largest one, which the controller's clamp then caps.
 */
private fun profileOf(texts: List<String>, dnsDelayMs: Int): LinkProfile {
    fun whole(text: String): Int? = if (text.isEmpty()) null else text.toIntOrNull() ?: Int.MAX_VALUE
    fun pct(text: String): Double = text.toDoubleOrNull() ?: 0.0
    return LinkProfile(
        downKbps = whole(texts[CustomBox.DOWN_SPEED.ordinal]),
        upKbps = whole(texts[CustomBox.UP_SPEED.ordinal]),
        downDelayMs = whole(texts[CustomBox.DOWN_DELAY.ordinal]) ?: 0,
        upDelayMs = whole(texts[CustomBox.UP_DELAY.ordinal]) ?: 0,
        downDropPct = pct(texts[CustomBox.DOWN_DROP.ordinal]),
        upDropPct = pct(texts[CustomBox.UP_DROP.ordinal]),
        dnsDelayMs = dnsDelayMs,
    )
}

/** Only the ASCII digits of [text]. */
internal fun digitsOnly(text: String): String = text.filter { it in '0'..'9' }

/** The ASCII digits of [text] and its first decimal point; every other character is dropped. */
internal fun decimalOnly(text: String): String {
    var point = false
    return buildString {
        for (ch in text) {
            when {
                ch in '0'..'9' -> append(ch)
                ch == '.' && !point -> { point = true; append(ch) }
            }
        }
    }
}

/**
 * A preset's summary: `↓ {speed} · {delay} ms · {drop}% drop`, the same for ↑,
 * and a DNS line when the profile delays lookups.
 */
internal fun summaryLines(p: LinkProfile): List<String> = buildList {
    add("↓ ${speedText(p.downKbps)} · ${p.downDelayMs} ms · ${dropText(p.downDropPct)}% drop")
    add("↑ ${speedText(p.upKbps)} · ${p.upDelayMs} ms · ${dropText(p.upDropPct)}% drop")
    if (p.dnsDelayMs > 0) add("DNS +${p.dnsDelayMs} ms")
}

/** `{n} kbps` under 1,000, otherwise Mbps without trailing zeros; `no limit` for none. */
internal fun speedText(kbps: Int?): String = when {
    kbps == null -> "no limit"
    kbps < 1_000 -> "$kbps kbps"
    else -> "${BigDecimal(kbps).movePointLeft(3).stripTrailingZeros().toPlainString()} Mbps"
}

/** A drop percent without trailing zeros: "0.05", "10", "0". */
internal fun dropText(pct: Double): String = BigDecimal.valueOf(pct).stripTrailingZeros().toPlainString()

/** [ms] as "3:45 PM" in the device's zone. */
internal fun clockTime(ms: Long): String =
    DateTimeFormatter.ofPattern("h:mm a").format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))

/** The dial's chosen preset; an id the dial doesn't offer reads as Off. */
internal fun DialSetting.selectedPreset(dial: Dial): Preset = dial.presets.firstOrNull { it.id == preset } ?: Preset.OFF

private val Dial.title: String
    get() = when (this) {
        Dial.INTERNET -> "Internet"
        Dial.LOCAL -> "Local network"
    }

private val Dial.caption: String
    get() = when (this) {
        Dial.INTERNET -> "portal: sync, uploads, heartbeat"
        Dial.LOCAL -> "network Zebra printers"
    }

/** The dial's name in test tags: "internet" or "local". */
private val Dial.key: String get() = name.lowercase()

/** The Custom grid's label column, wide enough for "Speed (kbps)". */
private val LABEL_WIDTH = 92.dp
