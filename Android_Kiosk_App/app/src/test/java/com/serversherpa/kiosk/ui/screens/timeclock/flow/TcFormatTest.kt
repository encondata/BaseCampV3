package com.serversherpa.kiosk.ui.screens.timeclock.flow

import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** kiosk/src/timeclock/format.test.ts. Times are built in a fixed zone and locale so the
 *  expected strings don't depend on the machine running the suite. */
class TcFormatTest {
    private val zone = ZoneId.of("America/Chicago")
    private val us = Locale.US

    private fun local(y: Int, mo: Int, d: Int, h: Int, mi: Int) = LocalDateTime.of(y, mo, d, h, mi).atZone(zone)
    private fun iso(y: Int, mo: Int, d: Int, h: Int, mi: Int) = local(y, mo, d, h, mi).toInstant().toString()

    @Test fun formatsWorkedMinutes() {
        assertEquals("0m", formatWorked(0))
        assertEquals("5m", formatWorked(5))
        assertEquals("59m", formatWorked(59))
        assertEquals("1h 00m", formatWorked(60))
        assertEquals("7h 24m", formatWorked(444))
        assertEquals("8h 00m", formatWorked(480))
    }

    @Test fun neverShowsNegativeOrFractionalMinutes() {
        assertEquals("0m", formatWorked(-3))
        assertEquals("5m", formatWorked(4.6))
    }

    @Test fun formatsAClockTimeAsAShortTime() {
        assertEquals("8:02 AM", formatClock(iso(2026, 10, 20, 8, 2), zone, us))
        assertEquals("10:00 PM", formatClock(iso(2026, 10, 20, 22, 0), zone, us))
    }

    @Test fun aPunchTodayIsJustItsClockTime() {
        val now = local(2026, 10, 20, 15, 0).toInstant()
        val at = iso(2026, 10, 20, 0, 5)
        assertEquals(formatClock(at, zone, us), formatPunch(at, now, zone, us))
    }

    @Test fun aPunchOnThePreviousLocalDaySaysYesterday() {
        val now = local(2026, 10, 20, 6, 30).toInstant()
        val at = iso(2026, 10, 19, 22, 0)
        assertEquals("yesterday 10:00 PM", formatPunch(at, now, zone, us))
        // across a month boundary too
        val first = local(2026, 11, 1, 7, 0).toInstant()
        val late = iso(2026, 10, 31, 23, 15)
        assertEquals("yesterday 11:15 PM", formatPunch(late, first, zone, us))
    }

    @Test fun anOlderPunchCarriesItsShortDate() {
        val now = local(2026, 10, 20, 6, 30).toInstant()
        val at = iso(2026, 10, 18, 22, 0)
        assertEquals("Oct 18 10:00 PM", formatPunch(at, now, zone, us))
    }

    @Test fun aBadTimestampIsShownAsIsRatherThanThrowing() {
        assertEquals("nope", formatClock("nope", zone, us))
        assertEquals("nope", formatPunch("nope", local(2026, 10, 20, 6, 30).toInstant(), zone, us))
    }

    @Test fun theHeaderDateReadsLikeTheWeb() {
        assertEquals("Tue, Oct 20, 2026", formatHeaderDate(local(2026, 10, 20, 8, 0).toInstant(), zone, us))
    }

    @Test fun theDeviceZoneIsTheSystemDefault() {
        assertEquals(ZoneId.systemDefault().id, deviceZone())
        assertTrue(deviceZone().isNotBlank())
    }
}
