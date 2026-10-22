package com.serversherpa.kiosk.ui.screens.rolodex

import com.serversherpa.kiosk.core.model.RolodexJob
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The "Previous jobs" rows' words: the "Type · Work type · Site" line and "Added Oct 3, 2026". */
class WorkerJobsTest {
    private fun job(type: String? = "Move", workType: String? = "Lead", site: String? = "NAP11 Las Vegas") =
        RolodexJob("i1", "NAP11 Hall Migration", type_label = type, work_type_label = workType, site_worked_name = site)

    @Test fun theLineSkipsWhatIsMissing() {
        assertEquals("Move · Lead · NAP11 Las Vegas", jobLine(job()))
        assertEquals("Move · NAP11 Las Vegas", jobLine(job(workType = null)))
        assertEquals("Move · Lead", jobLine(job(site = " ")))
        assertEquals("Lead", jobLine(job(type = null, site = null)))
        assertNull(jobLine(job(type = "", workType = null, site = null)))
    }

    @Test fun addedIsTheDayInTheDevicesZoneWithAShortMonth() {
        val chicago = ZoneId.of("America/Chicago")
        assertEquals("Added Oct 3, 2026", jobAddedText("2026-10-03T15:00:00Z", chicago, Locale.US))
        // 2 AM UTC on the 3rd is still the 2nd in Chicago
        assertEquals("Added Oct 2, 2026", jobAddedText("2026-10-03T02:00:00Z", chicago, Locale.US))
        assertEquals("Added Oct 3, 2026", jobAddedText("2026-10-03T02:00:00+00:00", ZoneId.of("UTC"), Locale.US))
        assertEquals("Added Mar 2, 2026", jobAddedText("2026-03-02T15:00:00.123456Z", chicago, Locale.US))
        // the device's locale writes the date its own way
        assertEquals("Added 3 Oct 2026", jobAddedText("2026-10-03T15:00:00Z", chicago, Locale.UK))
    }

    @Test fun noDateMeansNoAddedLine() {
        assertNull(jobAddedText(null))
        assertNull(jobAddedText(""))
        assertNull(jobAddedText("last week"))
    }
}
