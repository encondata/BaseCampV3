package com.serversherpa.kiosk.ui.screens.rolodex

import com.serversherpa.kiosk.core.model.RolodexJob
import java.time.ZoneId
import java.util.Locale
import java.util.TimeZone
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The "Previous jobs" rows' words: the "Type · Work type · Site" line, "Added Oct 3, 2026" and the
 * "Showing the latest 50 of N jobs." line. Robolectric, for Android's own date patterns; the
 * device's zone and locale are pinned so nothing depends on the machine running the tests.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WorkerJobsTest {
    private val zone = TimeZone.getDefault()
    private val locale = Locale.getDefault()

    @Before fun pin() {
        TimeZone.setDefault(TimeZone.getTimeZone("America/Chicago"))
        Locale.setDefault(Locale.US)
    }

    @After fun unpin() {
        TimeZone.setDefault(zone)
        Locale.setDefault(locale)
    }

    private fun job(type: String? = "Move", workType: String? = "Lead", site: String? = "NAP11 Las Vegas") =
        RolodexJob("i1", "NAP11 Hall Migration", type_label = type, work_type_label = workType, site_worked_name = site)

    @Test fun theLineSkipsWhatIsMissing() {
        assertEquals("Move · Lead · NAP11 Las Vegas", jobLine(job()))
        assertEquals("Move · NAP11 Las Vegas", jobLine(job(workType = null)))
        assertEquals("Move · Lead", jobLine(job(site = " ")))
        assertEquals("Lead", jobLine(job(type = null, site = null)))
        assertNull(jobLine(job(type = "", workType = null, site = null)))
    }

    @Test fun addedIsTheDayInTheZoneWithAShortMonth() {
        val chicago = ZoneId.of("America/Chicago")
        assertEquals("Added Oct 3, 2026", jobAddedText("2026-10-03T15:00:00Z", chicago, Locale.US))
        // 2 AM UTC on the 3rd is still the 2nd in Chicago
        assertEquals("Added Oct 2, 2026", jobAddedText("2026-10-03T02:00:00Z", chicago, Locale.US))
        assertEquals("Added Oct 3, 2026", jobAddedText("2026-10-03T02:00:00+00:00", ZoneId.of("UTC"), Locale.US))
        assertEquals("Added Mar 2, 2026", jobAddedText("2026-03-02T15:00:00.123456Z", chicago, Locale.US))
        // the device's locale writes the date its own way
        assertEquals("Added 3 Oct 2026", jobAddedText("2026-10-03T15:00:00Z", chicago, Locale.UK))
    }

    /** A locale whose medium date style is numeric ("03.10.2026" in German) still gets a month name. */
    @Test fun theMonthIsAlwaysANameNeverANumber() {
        val chicago = ZoneId.of("America/Chicago")
        for ((locale, month) in listOf(Locale.GERMANY to "Okt", Locale("fi", "FI") to "loka", Locale("nl", "NL") to "okt", Locale.JAPAN to "10月")) {
            val text = jobAddedText("2026-10-03T15:00:00Z", chicago, locale)!!
            assertTrue("$locale: $text", text.contains(month))
            assertTrue("$locale reads numeric: $text", !Regex("""\d{1,2}[./-]\d{1,2}[./-]\d{2,4}""").containsMatchIn(text))
        }
    }

    /** With no zone or locale given, the device's are used (pinned here to Chicago, US English). */
    @Test fun theDevicesZoneAndLocaleAreTheDefault() {
        assertEquals("Added Oct 2, 2026", jobAddedText("2026-10-03T02:00:00Z"))
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        Locale.setDefault(Locale.UK)
        assertEquals("Added 3 Oct 2026", jobAddedText("2026-10-03T02:00:00Z"))
    }

    @Test fun noDateMeansNoAddedLine() {
        assertNull(jobAddedText(null))
        assertNull(jobAddedText(""))
        assertNull(jobAddedText("last week"))
    }

    /** Only a worker with more jobs than the page lists gets the line; an API from before the total
     *  (0) never does. */
    @Test fun theShownLineCountsOnlyWhenJobsWereLeftOut() {
        assertEquals("Showing the latest 50 of 73 jobs.", jobsShownText(50, 73))
        assertNull(jobsShownText(50, 50))
        assertNull(jobsShownText(3, 3))
        assertNull(jobsShownText(2, 0))
        assertNull(jobsShownText(0, 0))
    }
}
