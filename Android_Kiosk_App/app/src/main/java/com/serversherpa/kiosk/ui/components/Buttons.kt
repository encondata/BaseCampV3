package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.btn-solid` — the one primary action on a screen. */
@Composable
fun SolidButton(text: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val c = LocalKioskColors.current
    Button(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.ink)) { Text(text) }
}

/** A status tone for [TintedButton]: text, fill and outline. Light uses the portal's tones for
 *  light paper (styles/directory.css), dark the brighter ones (portal-theme.css), so the text
 *  stays readable in both themes. */
data class TintColors(val text: Color, val bg: Color, val border: Color)

enum class ButtonTint(private val light: TintColors, private val dark: TintColors) {
    GREEN(
        TintColors(Color(0xFF178A4C), Color(0x1A178A4C), Color(0x47178A4C)),
        TintColors(Color(0xFF3DDC84), Color(0x1F3DDC84), Color(0x403DDC84)),
    ),
    RED(
        TintColors(Color(0xFFC03540), Color(0x1AE5484D), Color(0x4DE5484D)),
        TintColors(Color(0xFFFF5D6C), Color(0x1FFF5D6C), Color(0x40FF5D6C)),
    );

    fun colors(isDark: Boolean): TintColors = if (isDark) dark else light
}

/** A [MiniButton] in a status color: a tinted fill, outline and text. */
@Composable
fun TintedButton(text: String, onClick: () -> Unit, tint: ButtonTint, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val t = tint.colors(LocalKioskColors.current.isDark)
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 48.dp),
        border = BorderStroke(1.dp, if (enabled) t.border else t.border.copy(alpha = t.border.alpha * 0.5f)),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = t.bg, contentColor = t.text,
            disabledContainerColor = t.bg.copy(alpha = t.bg.alpha * 0.5f), disabledContentColor = t.text.copy(alpha = 0.38f),
        ),
    ) { Text(text) }
}

/** `.mini-btn` — a secondary, outlined action. */
@Composable
fun MiniButton(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    /** Overrides the outline — the shell paints the kiosk's registration state here. */
    borderColor: Color? = null,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 48.dp),
        border = borderColor?.let { BorderStroke(2.dp, it) } ?: ButtonDefaults.outlinedButtonBorder,
    ) { Text(text) }
}

/** `.link` — an inline text action. */
@Composable
fun LinkButton(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = modifier.heightIn(min = 48.dp)) { Text(text, color = LocalKioskColors.current.accent) }
}
