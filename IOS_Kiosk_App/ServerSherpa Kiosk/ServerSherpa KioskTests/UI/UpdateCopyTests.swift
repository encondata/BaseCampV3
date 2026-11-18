import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Settings › App updates: the status line, Last checked (24-hour) and the download size.
struct UpdateCopyTests {
    private let utc = TimeZone(identifier: "UTC")!
    private let installed = InstalledApp(bundleId: "com.serversherpa.kiosk", versionName: "1.0", build: "1", profile: .adhoc)

    private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    @Test func lastCheckedIsTwentyFourHour() {
        #expect(lastCheckedLine(at("2026-11-18T14:05:00Z"), timeZone: utc) == "Last checked 14:05")
        #expect(lastCheckedLine(at("2026-11-18T21:30:00Z"), timeZone: utc) == "Last checked 21:30")
        #expect(lastCheckedLine(at("2026-11-18T09:07:00Z"), timeZone: utc) == "Last checked 09:07")
    }

    @Test func lastCheckedNeverSaysAmOrPm() {
        let line = lastCheckedLine(at("2026-11-18T21:30:00Z"), timeZone: utc) ?? ""
        #expect(!line.contains("AM") && !line.contains("PM"))
    }

    @Test func lastCheckedFollowsTheTimeZone() {
        let chicago = TimeZone(identifier: "America/Chicago")!
        #expect(lastCheckedLine(at("2026-11-18T21:30:00Z"), timeZone: chicago) == "Last checked 15:30")
    }

    @Test func noCheckYetHasNoLastCheckedLine() {
        #expect(lastCheckedLine(nil, timeZone: utc) == nil)
    }

    @Test func statusLines() {
        #expect(updateStatusLine(.idle, installed: installed) == "Not checked yet.")
        #expect(updateStatusLine(.checking, installed: installed) == "Checking…")
        #expect(updateStatusLine(.done(.upToDate), installed: installed) == "Up to date — 1.0 (1).")
        let url = URL(string: "itms-services://?action=download-manifest&url=x")!
        #expect(updateStatusLine(.done(.available(version: "1.2.0", build: "7", notes: nil, size: nil, installUrl: url)),
                                 installed: installed) == "Update available — 1.2.0")
        #expect(updateStatusLine(.failed("x"), installed: installed) == "Couldn't check for updates. x")
    }

    @Test func registerFirstAndWaitingSayAnUpdateIsThere() {
        #expect(updateStatusLine(.done(.registerFirst(message: "Add this iPhone on devices.example.com first.")),
                                 installed: installed) == "Update available")
        #expect(updateStatusLine(.done(.waiting(message: "The update isn't ready yet. Check again later.")),
                                 installed: installed) == "Update not ready")
    }

    @Test func sizeLineUsesFileSizes() {
        #expect(sizeLine(nil) == nil)
        let expected = ByteCountFormatter.string(fromByteCount: 48_200_000, countStyle: .file)
        #expect(sizeLine(48_200_000) == expected)
        #expect(sizeLine(48_200_000)?.contains("48.2") == true)
    }
}
