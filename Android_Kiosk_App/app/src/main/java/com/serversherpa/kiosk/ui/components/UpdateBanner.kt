package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.data.update.AppUpdates
import com.serversherpa.kiosk.data.update.UpdateState
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlin.math.roundToInt

/**
 * Home's "Update available" box, at the top of the page so its buttons are never below a scroll.
 * It shows while [AppUpdates.homeBannerVisible] is on (never on the Play build) and draws the
 * offer, the download or the installer hand-off from [AppUpdates.state].
 */
@Composable
fun UpdateBanner(updates: AppUpdates) {
    val visible by updates.homeBannerVisible.collectAsStateWithLifecycle()
    val state by updates.state.collectAsStateWithLifecycle()
    val s = state
    if (!visible) return
    if (s !is UpdateState.Available && s !is UpdateState.Downloading && s !is UpdateState.Installing && s !is UpdateState.Blocked) return
    val c = LocalKioskColors.current
    val tone = ChipTone.BLUE
    Column(
        Modifier.fillMaxWidth().padding(vertical = 6.dp).background(tone.bg, RoundedCornerShape(10.dp)).padding(12.dp).testTag("update-banner"),
    ) {
        when (s) {
            is UpdateState.Available -> {
                Text("Update available — ${s.offer.versionName}", style = MaterialTheme.typography.titleMedium, color = c.textDark)
                UpdateNotice(s.notice)
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SolidButton("Update", onClick = updates::update, modifier = Modifier.testTag("update-now"))
                    MiniButton("Later", onClick = updates::later, modifier = Modifier.testTag("update-later"))
                }
            }
            is UpdateState.Blocked -> {
                Text("Update available", style = MaterialTheme.typography.titleMedium, color = c.textDark)
                Text(s.message, style = MaterialTheme.typography.bodyMedium, color = c.textDark, modifier = Modifier.padding(top = 4.dp))
                MiniButton("Later", onClick = updates::later, modifier = Modifier.padding(top = 8.dp).testTag("update-later"))
            }
            else -> UpdateProgress(s)
        }
    }
}

/** A message about the last install (canceled, blocked, didn't finish), in the red tone. */
@Composable
internal fun UpdateNotice(notice: String?) {
    if (notice == null) return
    Text(notice, style = MaterialTheme.typography.bodyMedium, color = ChipTone.RED.text, modifier = Modifier.padding(top = 4.dp))
}

/** The download (with its progress bar) or the installer hand-off; nothing for any other state.
 *  Home's banner and Settings › App updates show the same lines. */
@Composable
internal fun UpdateProgress(state: UpdateState) {
    val c = LocalKioskColors.current
    when (state) {
        is UpdateState.Downloading -> {
            val name = state.offer.versionName
            val fraction = state.fraction
            Text(
                if (fraction == null) "Downloading $name…" else "Downloading $name — ${(fraction * 100).roundToInt()}%",
                style = MaterialTheme.typography.bodyMedium, color = c.textDark,
            )
            val bar = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("update-progress")
            if (fraction == null) LinearProgressIndicator(color = c.accent, trackColor = c.paperLine, modifier = bar)
            else LinearProgressIndicator(progress = { fraction }, color = c.accent, trackColor = c.paperLine, modifier = bar)
        }
        is UpdateState.Installing -> Text("Opening the installer…", style = MaterialTheme.typography.bodyMedium, color = c.textDark)
        else -> {}
    }
}
