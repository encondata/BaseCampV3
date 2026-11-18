package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
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
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.UpdateNotice
import com.serversherpa.kiosk.ui.components.UpdateProgress
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Settings › This Kiosk › App updates (direct build only): what the last check found, the offer
 * with its notes and Update, and Check for updates — the visible control for the automatic check.
 * Checking needs a signed-in kiosk (the Devices site takes the kiosk's token).
 */
@Composable
fun AppUpdatesRow(updates: AppUpdates, signedIn: Boolean) {
    val c = LocalKioskColors.current
    val state by updates.state.collectAsStateWithLifecycle()
    val s = state
    val body = MaterialTheme.typography.bodyMedium
    Column(Modifier.testTag("app-updates")) {
        SettingsRow("App updates", "New builds come from the Devices site.") {
            when (s) {
                UpdateState.Idle -> Text("Not checked yet", style = body, color = c.textDark)
                UpdateState.Checking -> Text("Checking…", style = body, color = c.textDark)
                is UpdateState.UpToDate -> Text("Up to date · checked ${checkedTime(s.checkedAtMillis)}", style = body, color = c.textDark)
                is UpdateState.Failed -> {
                    Text(s.message, style = body, color = ChipTone.RED.text)
                    Text("Checked ${checkedTime(s.checkedAtMillis)}", style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                }
                is UpdateState.Unavailable -> Text(s.message, style = body, color = c.textDark)
                is UpdateState.Blocked -> Text(s.message, style = body, color = c.textDark)
                is UpdateState.Available -> {
                    val size = s.offer.size?.let { " (${megabytes(it)})" } ?: ""
                    Text("${s.offer.versionName} is available$size", style = body, color = c.textDark)
                    s.offer.notes?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp).testTag("update-notes"))
                    }
                    UpdateNotice(s.notice)
                    SolidButton("Update", onClick = updates::update, modifier = Modifier.padding(top = 8.dp).testTag("update-now"))
                }
                is UpdateState.Downloading, is UpdateState.Installing -> UpdateProgress(s)
            }
            val busy = s is UpdateState.Checking || s is UpdateState.Downloading || s is UpdateState.Installing
            MiniButton("Check for updates", onClick = updates::check, enabled = signedIn && !busy, modifier = Modifier.padding(top = 8.dp).testTag("check-updates"))
            if (!signedIn) Text("Sign in to check for updates.", style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

private val CHECKED_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

/** 24-hour HH:mm in the device's zone, read at each call so a zone change shows. */
private fun checkedTime(millis: Long): String = CHECKED_TIME.format(Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()))

/** One decimal, in megabytes of 1,000,000 bytes: 12_400_000 → "12.4 MB". */
private fun megabytes(bytes: Long): String = String.format(Locale.US, "%.1f MB", bytes / 1_000_000.0)
