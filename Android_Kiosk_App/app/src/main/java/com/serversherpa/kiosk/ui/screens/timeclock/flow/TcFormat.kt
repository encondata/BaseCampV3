package com.serversherpa.kiosk.ui.screens.timeclock.flow

import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.max

/*
 * kiosk/src/timeclock/format.ts: worked time, punch times, the header date and the device zone.
 * The zone and locale are parameters (defaulting to the device's) so tests can pin them.
 */

/** "5m" under an hour, otherwise hours and two-digit minutes ("7h 24m", "8h 00m"). */
fun formatWorked(minutes: Double): String {
    val total = max(0L, Math.round(minutes))
    val hours = total / 60
    if (hours == 0L) return "${total}m"
    return "${hours}h ${(total % 60).toString().padStart(2, '0')}m"
}

fun formatWorked(minutes: Int): String = formatWorked(minutes.toDouble())

private fun clockFormat(locale: Locale) = DateTimeFormatter.ofPattern("h:mm a", locale)

/** A punch time as a short clock time ("8:02 AM"). An unreadable timestamp is shown as is. */
fun formatClock(iso: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    try { clockFormat(locale).format(Instant.parse(iso).atZone(zone)) } catch (e: Exception) { iso }

/** A punch on Clock Out's table: its clock time, prefixed "yesterday" when it falls on the
 *  previous local day ("yesterday 10:00 PM"), or its short date when older ("Oct 18 10:00 PM"),
 *  so an overnight span reads right. */
fun formatPunch(
    iso: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault(),
): String {
    val at = try { Instant.parse(iso).atZone(zone) } catch (e: Exception) { return iso }
    val time = clockFormat(locale).format(at)
    val day = at.toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    if (!day.isBefore(today)) return time
    if (day == today.minusDays(1)) return "yesterday $time"
    return "${DateTimeFormatter.ofPattern("MMM d", locale).format(at)} $time"
}

/** The header's date ("Tue, Oct 20, 2026"). */
fun formatHeaderDate(now: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    DateTimeFormatter.ofPattern("EEE, MMM d, yyyy", locale).format(now.atZone(zone))

/** The device's IANA zone ("America/Chicago"), sent as `tz` with every status read and punch:
 *  the portal reads "today" in it when the kiosk's site has no zone. */
fun deviceZone(): String = ZoneId.systemDefault().id

/** All Set's name: the preferred name, else the first name, else the display name's first word. */
fun firstNameOf(person: KioskTimeclockPerson?): String {
    if (person == null) return ""
    return person.preferred_name?.trim()?.takeIf { it.isNotEmpty() }
        ?: person.first_name.trim().takeIf { it.isNotEmpty() }
        ?: person.display_name.split(' ').firstOrNull().orEmpty()
}

/** The confirm card's initials: the first letters of the first and last words ("?" for none). */
fun initialsOf(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return "?"
    return (words.first().take(1) + (if (words.size > 1) words.last().take(1) else "")).uppercase()
}

