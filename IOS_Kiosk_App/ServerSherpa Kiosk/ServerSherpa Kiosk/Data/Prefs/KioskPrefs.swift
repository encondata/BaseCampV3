import Foundation
import Observation

enum CameraPosition: String {
    case back, front
}

/// Clear Setup memory (Android `SetupClearRecord`), under `ss.kiosk.setupClear` with the web
/// kiosk's and Android's JSON shape: all three fields are always written.
struct SetupClearRecord: Codable, Equatable, Sendable {
    /// The portal's Clear Setup id this kiosk applied.
    var id: String
    /// The portal has the acknowledgment: a beat carried it and the reply stopped asking.
    var acked: Bool
    /// Kiosk Setup's "An administrator cleared…" banner is up; it goes when setup completes.
    var notice: Bool

    init(id: String, acked: Bool = false, notice: Bool = false) {
        self.id = id
        self.acked = acked
        self.notice = notice
    }

    enum CodingKeys: String, CodingKey { case id, acked, notice }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        acked = try c.decodeIfPresent(Bool.self, forKey: .acked) ?? false
        notice = try c.decodeIfPresent(Bool.self, forKey: .notice) ?? false
    }
}

/// Every kiosk-local value the web kiosk kept in localStorage. Keys keep the
/// web's `ss.kiosk.*` names. Each property is stored (so Observation tracks
/// it), loaded in `init`, and written back to `defaults` in its `didSet`.
@MainActor @Observable
final class KioskPrefs {
    @ObservationIgnored private let defaults: UserDefaults

    private enum Key {
        static let setupState = "ss.kiosk.setupState"
        static let setupSelection = "ss.kiosk.setup"
        static let appearance = "ss.kiosk.appearance"
        static let sound = "ss.kiosk.sound"
        static let devMode = "ss.kiosk.devMode"
        static let apiUrl = "ss.kiosk.apiUrl"
        static let portalUrl = "ss.kiosk.portalUrl"
        static let name = "ss.kiosk.name"
        static let cameraPosition = "ss.kiosk.cameraPosition"
        static let labels = "ss.kiosk.labels"
        static let biometric = "ss.kiosk.biometric"
        static let setupClear = "ss.kiosk.setupClear"
    }

    nonisolated static let printerStopsKey = "ss.kiosk.printerStops"

    var setupState: SetupState { didSet { defaults.set(setupState.rawValue, forKey: Key.setupState) } }
    var setupSelection: KioskSetupSelection? {
        didSet {
            if let setupSelection, let data = try? KioskJSON.encoder.encode(setupSelection), let s = String(data: data, encoding: .utf8) {
                defaults.set(s, forKey: Key.setupSelection)
            } else {
                defaults.removeObject(forKey: Key.setupSelection)
            }
        }
    }
    /// Who this kiosk is enrolled for biometric sign-in; nil removes it. Unreadable JSON reads as nil.
    var biometric: BiometricEnrollment? {
        didSet {
            if let biometric, let data = try? KioskJSON.encoder.encode(biometric), let s = String(data: data, encoding: .utf8) {
                defaults.set(s, forKey: Key.biometric)
            } else {
                defaults.removeObject(forKey: Key.biometric)
            }
        }
    }
    var appearance: Appearance { didSet { defaults.set(appearance.toJSON(), forKey: Key.appearance) } }
    var sound: SoundSettings { didSet { defaults.set(sound.toJSON(), forKey: Key.sound) } }
    var devMode: Bool { didSet { defaults.set(devMode, forKey: Key.devMode) } }
    var apiUrl: String? { didSet { Self.store(apiUrl, Key.apiUrl, defaults) } }
    var portalUrl: String? { didSet { Self.store(portalUrl, Key.portalUrl, defaults) } }
    var kioskName: String? { didSet { Self.store(kioskName, Key.name, defaults) } }
    var cameraPosition: CameraPosition { didSet { defaults.set(cameraPosition.rawValue, forKey: Key.cameraPosition) } }
    /// The saved printer, offsets and peel/tear choice; defaults when nothing (or nothing
    /// readable) is saved. The label kind lives in `setupSelection`.
    private(set) var labels: LabelOptions {
        didSet {
            if let data = try? KioskJSON.encoder.encode(labels), let s = String(data: data, encoding: .utf8) {
                defaults.set(s, forKey: Key.labels)
            }
        }
    }
    /// The last Clear Setup applied here; written only through the Clear Setup functions below.
    /// Unreadable JSON reads as nil.
    private(set) var setupClear: SetupClearRecord? {
        didSet {
            if let setupClear, let data = try? KioskJSON.encoder.encode(setupClear), let s = String(data: data, encoding: .utf8) {
                defaults.set(s, forKey: Key.setupClear)
            } else {
                defaults.removeObject(forKey: Key.setupClear)
            }
        }
    }
    private var checkpoints: [String: String] {
        didSet { for (k, v) in checkpoints where oldValue[k] != v { defaults.set(v, forKey: k) } }
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
        setupState = SetupState.fromWire(defaults.string(forKey: Key.setupState))
        setupSelection = defaults.string(forKey: Key.setupSelection)
            .flatMap { $0.data(using: .utf8) }
            .flatMap { try? KioskJSON.decoder.decode(KioskSetupSelection.self, from: $0) }
        biometric = defaults.string(forKey: Key.biometric)
            .flatMap { $0.data(using: .utf8) }
            .flatMap { try? KioskJSON.decoder.decode(BiometricEnrollment.self, from: $0) }
        setupClear = defaults.string(forKey: Key.setupClear)
            .flatMap { $0.data(using: .utf8) }
            .flatMap { try? KioskJSON.decoder.decode(SetupClearRecord.self, from: $0) }
        appearance = parseAppearance(defaults.string(forKey: Key.appearance))
        sound = parseSoundSettings(defaults.string(forKey: Key.sound))
        devMode = defaults.bool(forKey: Key.devMode)
        apiUrl = defaults.string(forKey: Key.apiUrl)
        portalUrl = defaults.string(forKey: Key.portalUrl)
        kioskName = defaults.string(forKey: Key.name)
        cameraPosition = defaults.string(forKey: Key.cameraPosition).flatMap(CameraPosition.init(rawValue:)) ?? .back
        labels = defaults.string(forKey: Key.labels)
            .flatMap { $0.data(using: .utf8) }
            .flatMap { try? KioskJSON.decoder.decode(LabelOptions.self, from: $0) } ?? LabelOptions()
        var cps: [String: String] = [:]
        for id in CheckpointId.allCases {
            if let v = defaults.string(forKey: id.storageKey) { cps[id.storageKey] = v }
        }
        checkpoints = cps
    }

    // MARK: Clear Setup

    /// Applies a Clear Setup id not applied before: drops the saved setup, marks setup
    /// incomplete and raises the notice, in one main-actor step, so nothing ever sees half of
    /// it. True only the first time for an id.
    @discardableResult
    func applySetupClear(_ id: String) -> Bool {
        guard setupClear?.id != id else { return false }
        setupSelection = nil
        setupState = .incomplete
        setupClear = SetupClearRecord(id: id, acked: false, notice: true)
        return true
    }

    /// The applied id the next beat should acknowledge, or nil.
    func pendingSetupClearAck() -> String? {
        guard let r = setupClear, !r.acked else { return nil }
        return r.id
    }

    /// The ack has landed only when THIS beat carried it (`sentAck`) and its reply stopped
    /// asking for it (`replyId` is nil or a newer id).
    func settleSetupClearAck(sentAck: String?, replyId: String?) {
        guard var r = setupClear, !r.acked, sentAck == r.id, replyId != r.id else { return }
        r.acked = true
        setupClear = r
    }

    /// Kiosk Setup completed: the "An administrator cleared…" banner goes away.
    func dismissSetupClearNotice() {
        guard var r = setupClear, r.notice else { return }
        r.notice = false
        setupClear = r
    }

    /// The stored key, or the id's default when unset or blank.
    func checkpoint(_ id: CheckpointId) -> String {
        guard let v = checkpoints[id.storageKey], !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return id.fallback }
        return v
    }

    func setCheckpoint(_ id: CheckpointId, _ key: String) {
        checkpoints[id.storageKey] = key
    }

    /// Where `PrinterGuard` keeps the printers stopped after a cut font install (D8).
    var printerStops: PrinterStopsStore { PrinterStopsStore(defaults: defaults) }

    /// Reads and writes in one step, so two setters never overwrite each other's field.
    func updateLabels(_ change: (inout LabelOptions) -> Void) {
        var next = labels
        change(&next)
        labels = next
    }

    private static func store(_ value: String?, _ key: String, _ defaults: UserDefaults) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

/// The printers `PrinterGuard` stopped after a cut font install (D8), under
/// `ss.kiosk.printerStops`: such a printer is still waiting for the rest of the font after the app
/// is relaunched, so the stop must outlive the launch. A pending `~JX` clear isn't kept (D16 keeps
/// it in memory). UserDefaults is thread-safe, so the guard writes it from its own actor, in the
/// order its marks change.
struct PrinterStopsStore: @unchecked Sendable {
    static let key = KioskPrefs.printerStopsKey
    let defaults: UserDefaults

    /// The stopped printers; none when nothing (or nothing readable) is saved.
    func load() -> Set<PrinterIdentity> {
        guard let data = defaults.string(forKey: Self.key)?.data(using: .utf8),
              let stops = try? KioskJSON.decoder.decode([PrinterIdentity].self, from: data) else { return [] }
        return Set(stops)
    }

    /// Saves `stops` (none removes the key).
    func save(_ stops: Set<PrinterIdentity>) {
        guard !stops.isEmpty else {
            defaults.removeObject(forKey: Self.key)
            return
        }
        let sorted = stops.sorted { $0.sortKey < $1.sortKey }
        if let data = try? KioskJSON.encoder.encode(sorted), let text = String(data: data, encoding: .utf8) {
            defaults.set(text, forKey: Self.key)
        }
    }
}
