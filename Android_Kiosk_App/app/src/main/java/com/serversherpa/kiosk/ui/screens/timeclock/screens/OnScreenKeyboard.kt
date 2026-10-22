package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

private val LETTERS = listOf("QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM")
private val SYMBOLS = listOf("1234567890", "-'.,&@")

private val KeyFace = Color.White
private val ModFace = Color(0xFFE2E8F0)
private val KeyEdge = Color(0xFFCBD5E1)
private val SearchEdge = Color(0xFFC2410C)
private val Tray = Color(0xFFE2E8F0).copy(alpha = .7f)

/**
 * The Enter Your Name keyboard (kiosk/src/timeclock/OnScreenKeyboard.tsx): QWERTY rows, Shift and
 * Backspace around the bottom letter row, then 123 · Space · Search. 123 swaps the letters for
 * digits and the punctuation names carry (hyphen, apostrophe, period, comma, ampersand, at).
 *
 * Letters come out capitalized at the start of the box and after a space, lower case otherwise;
 * Shift capitalizes the next letter once. The caps always read as capitals. The keys never take
 * focus, so a hardware reader's keystrokes keep landing in the flow.
 */
@Composable
fun OnScreenKeyboard(
    /** The box's current text (decides the automatic capital). */
    value: String,
    onKey: (String) -> Unit,
    onBackspace: () -> Unit,
    onSearch: () -> Unit,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val s = LocalTcSizes.current
    var shift by rememberSaveable { mutableStateOf(false) }
    var symbols by rememberSaveable { mutableStateOf(false) }
    val autoCap = value.isEmpty() || value.endsWith(" ")
    val gap = s.dp(5f, 1f, 10f)
    val keyHeight = s.dp(56f, 8f, 84f)
    val keyText = s.sp(20f, 3.4f, 32f)
    val modText = s.sp(17f, 2.6f, 26f)

    @Composable
    fun RowScope.Key(
        label: String? = null, icon: ImageVector? = null, name: String? = null, weight: Float = 1f, max: Dp? = 84.dp,
        face: Color = KeyFace, ink: Color = TcColors.Ink, edge: Color = KeyEdge, small: Boolean = false, pressed: Boolean? = null,
        onPress: () -> Unit,
    ) {
        val shape = RoundedCornerShape(12.dp)
        Box(
            Modifier.weight(weight).then(if (max != null) Modifier.widthIn(max = max) else Modifier).heightIn(min = keyHeight)
                .alpha(if (enabled) 1f else .5f)
                .drawBehind { drawRoundRect(edge, topLeft = Offset(0f, 2.dp.toPx()), size = size, cornerRadius = CornerRadius(12.dp.toPx())) }
                .clip(shape).background(if (pressed == true) TcColors.Ink else face)
                .clickable(enabled = enabled, role = Role.Button, onClick = onPress)
                .semantics {
                    if (name != null) contentDescription = name
                    if (pressed != null) selected = pressed
                },
            contentAlignment = Alignment.Center,
        ) {
            val tint = if (pressed == true) Color.White else ink
            if (icon != null) Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(26.dp))
            if (label != null) Text(label, style = tcText(if (small) modText else keyText, FontWeight.SemiBold, tint))
        }
    }

    @Composable
    fun KeyRow(content: @Composable RowScope.() -> Unit) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap, Alignment.CenterHorizontally), content = content)
    }

    fun letter(ch: Char) {
        onKey(if (shift || autoCap) ch.toString() else ch.lowercase())
        shift = false
    }

    Column(
        modifier.clip(RoundedCornerShape(20.dp)).background(Tray).padding(s.dp(10f, 1.8f, 18f)),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (symbols) {
            KeyRow { for (ch in SYMBOLS[0]) Key(ch.toString()) { onKey(ch.toString()) } }
            KeyRow {
                for (ch in SYMBOLS[1]) Key(ch.toString()) { onKey(ch.toString()) }
                Key(icon = TcBackspaceIcon, name = "Backspace", weight = 1.4f, max = 120.dp, face = ModFace, onPress = onBackspace)
            }
        } else {
            KeyRow { for (ch in LETTERS[0]) Key(ch.toString()) { letter(ch) } }
            KeyRow { for (ch in LETTERS[1]) Key(ch.toString()) { letter(ch) } }
            KeyRow {
                Key(icon = TcShiftIcon, name = "Shift", weight = 1.4f, max = 120.dp, face = ModFace, pressed = shift) { shift = !shift }
                for (ch in LETTERS[2]) Key(ch.toString()) { letter(ch) }
                Key(icon = TcBackspaceIcon, name = "Backspace", weight = 1.4f, max = 120.dp, face = ModFace, onPress = onBackspace)
            }
        }
        KeyRow {
            if (symbols) Key("ABC", name = "Letters", weight = 1.6f, max = 150.dp, face = ModFace, small = true) { symbols = false }
            else Key("123", name = "Numbers", weight = 1.6f, max = 150.dp, face = ModFace, small = true) { symbols = true }
            Key("Space", weight = 5f, max = null, small = true) { onKey(" ") }
            Key("Search", weight = 2f, max = 200.dp, face = TcColors.Amber, ink = Color.White, edge = SearchEdge, small = true, onPress = onSearch)
        }
    }
}

