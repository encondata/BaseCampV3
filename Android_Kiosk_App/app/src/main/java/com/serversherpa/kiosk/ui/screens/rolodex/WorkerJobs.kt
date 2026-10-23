package com.serversherpa.kiosk.ui.screens.rolodex

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
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
import java.time.format.FormatStyle
import java.time.format.DateTimeParseException
import java.util.Locale

/**
 * The worker page's "Previous jobs" card, below the details: one row per initiative the worker was
 * added to, newest first as the API sends them (the latest 50), or "No jobs yet.". A row is the
 * initiative's name (wrapping, never cut), "Type · Work type · Site", the date they were added, and
 * the initiative's status chip in its own color, as the list rows carry theirs (at most 120 dp, a
 * long custom status ellipsized, so the name keeps its room). When the worker has more jobs than
 * were sent ([total]), a last line says so ([jobsShownText]).
 */
@Composable
internal fun PreviousJobs(jobs: List<RolodexJob>, total: Int = jobs.size) {
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
        jobsShownText(jobs.size, total)?.let {
            Spacer(Modifier.fillMaxWidth().height(1.dp).background(c.paperLine))
            Text(
                it, style = MaterialTheme.typography.bodySmall, color = c.textMute,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp).testTag("worker-jobs-shown"),
            )
        }
    }
}

/** "Showing the latest 50 of 73 jobs.": only when the worker has more jobs ([total]) than the
 *  [shown] ones the page lists; null otherwise (an API from before the total sends none). */
internal fun jobsShownText(shown: Int, total: Int): String? =
    if (total > shown) "Showing the latest $shown of $total jobs." else null

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
            if (job.status_label.isNotBlank()) {
                ColorChip(job.status_label, hexColor(job.status_color), Modifier.padding(start = 10.dp).widthIn(max = 120.dp).testTag("worker-job-status"))
            }
        }
    }
}

/** "Move · Lead · NAP11 Las Vegas": the job's type, the worker's work type and the site worked, skipping any that's missing; null with none. */
internal fun jobLine(job: RolodexJob): String? =
    listOf(job.type_label, job.work_type_label, job.site_worked_name)
        .mapNotNull { it?.takeIf(String::isNotBlank) }.joinToString(" · ").ifEmpty { null }

/**
 * "Added Oct 3, 2026": the day the worker was added to the job in [zone] (the device's by default),
 * as [locale] (the device's by default) writes a date with a short month name: the locale's own
 * pattern for year, short month and day (`yMMMd`), so it never turns numeric ("03.10.26") as some
 * locales' medium style does. Null when [addedAt] isn't a timestamp.
 */
internal fun jobAddedText(addedAt: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
    if (addedAt.isNullOrBlank()) return null
    val at = try { OffsetDateTime.parse(addedAt) } catch (e: DateTimeParseException) { return null }
    // A locale whose pattern holds a letter java.time doesn't take (a non-Gregorian calendar's)
    // falls back to its medium style rather than failing the page.
    val format = try {
        DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "yMMMd"), locale)
    } catch (e: IllegalArgumentException) {
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)
    }
    return "Added " + format.format(at.atZoneSameInstant(zone))
}
