import Foundation

enum RegistrationState: String, Sendable {
    case ok, soon, expired, none

    var label: String {
        switch self {
        case .ok: "Registered"
        case .soon: "Expires soon"
        case .expired: "Expired"
        case .none: "Unregistered"
        }
    }

    /// Unknown wire values are `nil` (Android maps them to `none`; callers use `?? .none`).
    static func fromWire(_ s: String?) -> RegistrationState? {
        s.flatMap(RegistrationState.init(rawValue:))
    }
}

/// portal/src/lib/devices.ts tokenExpiryState: ok > 7 d, soon <= 7 d, expired past, none null.
let SOON_MS: Int64 = 7 * 24 * 60 * 60 * 1000

func tokenExpiryState(_ iso: String?, nowMs: Int64) -> RegistrationState {
    guard let iso, !iso.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let date = parseInstant(iso) else { return .none }
    let t = Int64((date.timeIntervalSince1970 * 1000).rounded())
    if t <= nowMs { return .expired }
    return t - nowMs <= SOON_MS ? .soon : .ok
}

/// ISO-8601 instants with or without fractional seconds (Kotlin `Instant.parse` accepts both).
private func parseInstant(_ s: String) -> Date? {
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let d = plain.date(from: s) { return d }
    let frac = ISO8601DateFormatter()
    frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return frac.date(from: s)
}
