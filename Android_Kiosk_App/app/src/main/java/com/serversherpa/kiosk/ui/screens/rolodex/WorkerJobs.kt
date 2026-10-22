package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.model.RolodexJob
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The worker page's "Previous jobs" card, below the details: one row per initiative the worker was
 * added to, newest first as the API sends them, or "No jobs yet.". A row is the initiative's name
 * (wrapping, never cut), "Type · Work type · Site", the date they were added, and the initiative's
 * status chip in its own color, as the list rows carry theirs.
 */
@Composable
internal fun PreviousJobs(jobs: List<RolodexJob>) {
    val c = LocalKioskColors.current
    InfoCard("Previous jobs") {
        if (jobs.isEmpty()) {
            Spacer(Modifier.fillMaxWidth().height(1.dp).background(c.paperLine))
            Text(
                "No jobs yet.", style = MaterialTheme.typography.bodyMedium, color = c.textMute,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
        jobs.forEach { JobRow(it) }
    }
}

@Composable
private fun JobRow(job: RolodexJob) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().testTag("worker-job-${job.initiative_id}")) {
        Spacer(Modifier.fillMaxWidth().height(1.dp).background(c.paperLine))
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(job.initiative_name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.textDark)
                jobLine(job)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 2.dp)) }
                jobAddedText(job.added_at)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 2.dp)) }
            }
            if (job.status_label.isNotBlank()) ColorChip(job.status_label, hexColor(job.status_color), Modifier.padding(start = 10.dp))
        }
    }
}

/** "Move · Lead · NAP11 Las Vegas": the job's type, the worker's work type and the site worked, skipping any that's missing; null with none. */
internal fun jobLine(job: RolodexJob): String? =
    listOf(job.type_label, job.work_type_label, job.site_worked_name)
        .mapNotNull { it?.takeIf(String::isNotBlank) }.joinToString(" · ").ifEmpty { null }

/**
 * "Added Oct 3, 2026": the day the worker was added to the job in [zone], as [locale] writes a date
 * with a short month (the device's by default). Null when [addedAt] isn't a timestamp.
 */
internal fun jobAddedText(addedAt: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
    if (addedAt.isNullOrBlank()) return null
    val at = try { OffsetDateTime.parse(addedAt) } catch (e: DateTimeParseException) { return null }
    return "Added " + DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale).format(at.atZoneSameInstant(zone))
}
