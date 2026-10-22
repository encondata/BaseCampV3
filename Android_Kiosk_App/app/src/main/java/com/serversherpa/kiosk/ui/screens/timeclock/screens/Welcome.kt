package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

const val PAUSED_TEXT = "This time clock is paused. Ask an administrator to sign in here or renew this kiosk on Kiosk Devices."
const val KEY_MISSING_TEXT = "This time clock is waiting for its station key. Check the connection, or ask an administrator to sign in here."

/**
 * Welcome (station only): the greeting and the two ways in. A reader scans at any time while it
 * shows; Scan Your QR Code opens the camera. In landscape the cards sit side by side.
 */
@Composable
fun Welcome(
    paused: Boolean,
    /** Paused because the station key never arrived (or was dropped), not a lapsed registration. */
    keyMissing: Boolean,
    message: String?,
    onScan: () -> Unit,
    onName: () -> Unit,
) {
    val s = LocalTcSizes.current
    Column(
        Modifier.widthIn(max = if (s.landscape) 1100.dp else 820.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
    ) {
        TcHero("Welcome!")
        TcLead("Please identify yourself to continue.")
        if (paused) TcNotice(if (keyMissing) KEY_MISSING_TEXT else PAUSED_TEXT)
        if (message != null) TcErrorText(message)
        Spacer(Modifier.height(s.dp(0f, 1f, 16f)))
        val scan: @Composable (Modifier) -> Unit = { m -> WelcomeCard(TcQrIcon, "Scan Your QR Code", "Scan your code with the reader", !paused, onScan, m.testTag("tc-card-scan")) }
        val name: @Composable (Modifier) -> Unit = { m -> WelcomeCard(TcKeyboardIcon, "Enter Your Name", "Type your name on screen", !paused, onName, m.testTag("tc-card-name")) }
        val gap = s.dp(14f, 2.4f, 28f)
        if (s.landscape) {
            Row(Modifier.widthIn(max = 1000.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                scan(Modifier.weight(1f)); name(Modifier.weight(1f))
            }
        } else {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(gap)) {
                scan(Modifier.fillMaxWidth()); name(Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun WelcomeCard(icon: ImageVector, title: String, sub: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val s = LocalTcSizes.current
    val shape = RoundedCornerShape(20.dp)
    Row(
        modifier.heightIn(min = s.dp(96f, 15f, 190f)).alpha(if (enabled) 1f else .5f)
            .shadow(6.dp, shape, ambientColor = TcColors.Ink.copy(alpha = .07f), spotColor = TcColors.Ink.copy(alpha = .07f))
            .clip(shape).background(Color.White.copy(alpha = .92f)).border(1.dp, TcColors.Line, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = s.dp(18f, 3.4f, 40f), vertical = s.dp(16f, 2.6f, 32f)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(s.dp(16f, 3f, 36f)),
    ) {
        Image(icon, contentDescription = null, modifier = Modifier.size(s.dp(52f, 9f, 104f)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = tcText(s.sp(22f, 4f, 44f), FontWeight.Bold, align = TextAlign.Start))
            Text(sub, style = tcText(s.sp(14f, 2.2f, 24f), color = TcColors.Muted, align = TextAlign.Start))
        }
        Icon(TcChevronIcon, contentDescription = null, tint = TcColors.Slate, modifier = Modifier.size(28.dp).padding(0.dp))
    }
}
