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
