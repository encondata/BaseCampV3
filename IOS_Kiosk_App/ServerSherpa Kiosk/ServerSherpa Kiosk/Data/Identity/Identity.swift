import Foundation
import Observation

let NAME_MAX = 80

struct KioskIdentity: Equatable, Sendable {
    var serial: String
    var name: String
}

func newSerial() -> String { "kiosk-ios-" + UUID().uuidString.lowercased() }

func defaultName(_ serial: String) -> String { "Kiosk \(serial.suffix(4).uppercased())" }

/// Who this kiosk is: a serial generated once (kept in the Keychain), and a friendly name.
@MainActor @Observable
final class Identity {
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let secrets: SecretStore

    init(prefs: KioskPrefs, secrets: SecretStore) {
        self.prefs = prefs
        self.secrets = secrets
    }

    /// Generates and stores the serial the first time it is asked for.
    var current: KioskIdentity {
        let serial: String
        if let stored = secrets.get("kiosk.serial") {
            serial = stored
        } else {
            serial = newSerial()
            secrets.set("kiosk.serial", serial)
        }
        let stored = prefs.kioskName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return KioskIdentity(serial: serial, name: stored.isEmpty ? defaultName(serial) : stored)
    }

    /// Trims and stores; false when blank or too long.
    func setName(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= NAME_MAX else { return false }
        prefs.kioskName = trimmed
        return true
    }
}
