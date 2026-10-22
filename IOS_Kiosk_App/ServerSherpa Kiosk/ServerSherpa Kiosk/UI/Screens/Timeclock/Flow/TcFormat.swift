import Foundation

// kiosk/src/timeclock/format.ts, plus the confirm card's and All Set's name helpers.

/// "5m" under an hour, otherwise hours and two-digit minutes ("7h 24m", "8h 00m").
/// Minutes, because that is what the API counts in.
func formatWorked(_ minutes: Double) -> String {
    let total = max(0, Int(minutes.rounded()))
    let hours = total / 60
    if hours == 0 { return "\(total)m" }
    return "\(hours)h " + String(format: "%02dm", total % 60)
}

private func formatter(_ template: String, timeZone: TimeZone, locale: Locale) -> DateFormatter {
    let f = DateFormatter()
    f.locale = locale
    f.timeZone = timeZone
    f.setLocalizedDateFormatFromTemplate(template)
    return f
}

/// A time as the locale's short clock time ("8:02 AM").
func formatClock(_ date: Date, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
    formatter("jmm", timeZone: timeZone, locale: locale).string(from: date)
}

/// The header's date ("Tue, Oct 20, 2026").
func formatHeaderDate(_ date: Date, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
    formatter("EEEMMMdyyyy", timeZone: timeZone, locale: locale).string(from: date)
}

/// A punch on Clock Out's table: its clock time, prefixed "yesterday" when it
/// falls on the previous local day ("yesterday 10:00 PM"), or its short date
/// when older ("Oct 18 10:00 PM"), so an overnight span reads right. A value
/// that does not parse is shown as it came.
func formatPunch(_ iso: String, now: Date = Date(), timeZone: TimeZone = .current, locale: Locale = .current) -> String {
    guard let at = parseInstant(iso) else { return iso }
    let time = formatClock(at, timeZone: timeZone, locale: locale)
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = timeZone
    let day = cal.startOfDay(for: at)
    let today = cal.startOfDay(for: now)
    if day >= today { return time }
    if let yesterday = cal.date(byAdding: .day, value: -1, to: today), day == yesterday { return "yesterday \(time)" }
    return "\(formatter("MMMd", timeZone: timeZone, locale: locale).string(from: at)) \(time)"
}

/// The confirm card's initials when there is no photo: first and last word.
func initialsOf(_ name: String) -> String {
    let words = name.split(whereSeparator: \.isWhitespace)
    guard let first = words.first else { return "?" }
    let last = words.count > 1 ? words.last.map { String($0.prefix(1)) } ?? "" : ""
    return (String(first.prefix(1)) + last).uppercased()
}

/// The confirm card's lines under the name: the job title and "Employee ID …",
/// each only when set, so a person without them gets no empty lines.
func tcPersonMeta(_ person: KioskTimeclockPerson) -> [String] {
    var lines: [String] = []
    if let title = person.jobTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { lines.append(title) }
    if let id = person.externalId?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty { lines.append("Employee ID \(id)") }
    return lines
}

/// All Set's "Have a great day, {first name}!": the preferred name, then the
/// first name, then the display name's first word.
func tcFirstName(_ person: KioskTimeclockPerson?) -> String {
    guard let person else { return "" }
    func clean(_ s: String?) -> String? {
        let t = s?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? nil : t
    }
    return clean(person.preferredName) ?? clean(person.firstName)
        ?? person.displayName.split(separator: " ").first.map(String.init) ?? ""
}
