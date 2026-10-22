import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// kiosk/src/timeclock/format.test.ts, plus the confirm card's initials and All Set's first name.
struct TcFormatTests {
    private let chicago = TimeZone(identifier: "America/Chicago")!
    private let us = Locale(identifier: "en_US")

    /// A wall-clock time in Chicago, as the instant the API would send.
    private func local(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = chicago
        return cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }

    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    @Test func formatsWorkedMinutes() {
        #expect(formatWorked(0) == "0m")
        #expect(formatWorked(5) == "5m")
        #expect(formatWorked(59) == "59m")
        #expect(formatWorked(60) == "1h 00m")
        #expect(formatWorked(444) == "7h 24m")
        #expect(formatWorked(480) == "8h 00m")
    }

    @Test func neverShowsNegativeOrFractionalMinutes() {
        #expect(formatWorked(-3) == "0m")
        #expect(formatWorked(4.6) == "5m")
    }

    @Test func formatsAClockTimeAsAShortLocaleTime() {
        let at = local(2026, 10, 20, 8, 2)
        let text = formatClock(at, timeZone: chicago, locale: us)
        #expect(text.contains("8:02"))
        #expect(text.contains("AM"))
    }

    @Test func aPunchTodayIsJustItsClockTime() {
        let now = local(2026, 10, 20, 15, 0)
        let at = local(2026, 10, 20, 0, 5)
        #expect(formatPunch(iso(at), now: now, timeZone: chicago, locale: us) == formatClock(at, timeZone: chicago, locale: us))
    }

    @Test func aPunchOnThePreviousLocalDaySaysYesterday() {
        let now = local(2026, 10, 20, 6, 30)
        let at = local(2026, 10, 19, 22, 0)
        let text = formatPunch(iso(at), now: now, timeZone: chicago, locale: us)
        #expect(text == "yesterday \(formatClock(at, timeZone: chicago, locale: us))")
        #expect(text.hasPrefix("yesterday 10:00"))
        // across a month boundary too
        let first = local(2026, 11, 1, 7, 0)
        let late = local(2026, 10, 31, 23, 15)
        #expect(formatPunch(iso(late), now: first, timeZone: chicago, locale: us) == "yesterday \(formatClock(late, timeZone: chicago, locale: us))")
    }

    @Test func anOlderPunchCarriesItsShortDate() {
        let now = local(2026, 10, 20, 6, 30)
        let at = local(2026, 10, 18, 22, 0)
        let text = formatPunch(iso(at), now: now, timeZone: chicago, locale: us)
        #expect(text == "Oct 18 \(formatClock(at, timeZone: chicago, locale: us))")
    }

    @Test func theDayIsTheKiosksOwnZone() {
        // 03:30 UTC on the 20th is still the 19th in Chicago: "yesterday" from Chicago's 20th.
        let now = local(2026, 10, 20, 9, 0)
        let at = ISO8601DateFormatter().date(from: "2026-10-20T03:30:00Z")!
        #expect(formatPunch(iso(at), now: now, timeZone: chicago, locale: us).hasPrefix("yesterday 10:30"))
    }

    @Test func aPunchThatDoesNotParseIsShownAsIs() {
        #expect(formatPunch("garbage", now: Date(), timeZone: chicago, locale: us) == "garbage")
    }

    @Test func initials() {
        #expect(initialsOf("Jimmy Henderson") == "JH")
        #expect(initialsOf("  ") == "?")
        #expect(initialsOf("madonna") == "M")
        #expect(initialsOf("ann b cole") == "AC")
    }

    @Test func allSetsFirstNamePrefersThePreferredName() {
        #expect(tcFirstName(KioskTimeclockPerson(id: "p", displayName: "James Henderson", firstName: "James", preferredName: "Jimmy")) == "Jimmy")
        #expect(tcFirstName(KioskTimeclockPerson(id: "p", displayName: "James Henderson", firstName: "James", preferredName: "  ")) == "James")
        #expect(tcFirstName(KioskTimeclockPerson(id: "p", displayName: "Tina Timeclock")) == "Tina")
        #expect(tcFirstName(nil) == "")
    }
}
