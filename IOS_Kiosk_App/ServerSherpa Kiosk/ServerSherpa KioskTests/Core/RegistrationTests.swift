import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct RegistrationTests {
    private let now: Int64 = 1_700_000_000_000

    private func iso(_ ms: Int64) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    @Test func thresholds() {
        #expect(tokenExpiryState(nil, nowMs: now) == .none)
        #expect(tokenExpiryState("garbage", nowMs: now) == .none)
        #expect(tokenExpiryState(iso(now - 1), nowMs: now) == .expired)
        #expect(tokenExpiryState(iso(now + SOON_MS), nowMs: now) == .soon)
        #expect(tokenExpiryState(iso(now + SOON_MS + 1), nowMs: now) == .ok)
    }

    @Test func parsesWithoutFractionalSeconds() {
        #expect(tokenExpiryState("2023-11-14T22:13:20Z", nowMs: now) == .expired)
        #expect(tokenExpiryState("2023-11-14T22:13:21Z", nowMs: now) == .soon)
        #expect(tokenExpiryState("", nowMs: now) == .none)
    }

    @Test func labels() {
        #expect(RegistrationState.ok.label == "Registered")
        #expect((RegistrationState.fromWire("bogus") ?? .none).label == "Unregistered")
        #expect(RegistrationState.fromWire("bogus") == nil)
        #expect(RegistrationState.soon.label == "Expires soon")
        #expect(RegistrationState.expired.label == "Expired")
    }
}
