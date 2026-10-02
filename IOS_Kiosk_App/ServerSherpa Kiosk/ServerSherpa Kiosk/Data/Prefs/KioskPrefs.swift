import Foundation
import Observation

enum CameraPosition: String {
    case back, front
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
    }

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
    var appearance: Appearance { didSet { defaults.set(appearance.toJSON(), forKey: Key.appearance) } }
    var sound: SoundSettings { didSet { defaults.set(sound.toJSON(), forKey: Key.sound) } }
    var devMode: Bool { didSet { defaults.set(devMode, forKey: Key.devMode) } }
    var apiUrl: String? { didSet { Self.store(apiUrl, Key.apiUrl, defaults) } }
    var portalUrl: String? { didSet { Self.store(portalUrl, Key.portalUrl, defaults) } }
    var kioskName: String? { didSet { Self.store(kioskName, Key.name, defaults) } }
    var cameraPosition: CameraPosition { didSet { defaults.set(cameraPosition.rawValue, forKey: Key.cameraPosition) } }
    private var checkpoints: [String: String] {
        didSet { for (k, v) in checkpoints where oldValue[k] != v { defaults.set(v, forKey: k) } }
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
        setupState = SetupState.fromWire(defaults.string(forKey: Key.setupState))
        setupSelection = defaults.string(forKey: Key.setupSelection)
            .flatMap { $0.data(using: .utf8) }
            .flatMap { try? KioskJSON.decoder.decode(KioskSetupSelection.self, from: $0) }
        appearance = parseAppearance(defaults.string(forKey: Key.appearance))
        sound = parseSoundSettings(defaults.string(forKey: Key.sound))
        devMode = defaults.bool(forKey: Key.devMode)
        apiUrl = defaults.string(forKey: Key.apiUrl)
        portalUrl = defaults.string(forKey: Key.portalUrl)
        kioskName = defaults.string(forKey: Key.name)
        cameraPosition = defaults.string(forKey: Key.cameraPosition).flatMap(CameraPosition.init(rawValue:)) ?? .back
        var cps: [String: String] = [:]
        for id in CheckpointId.allCases {
            if let v = defaults.string(forKey: id.storageKey) { cps[id.storageKey] = v }
        }
        checkpoints = cps
    }

    /// The stored key, or the id's default when unset or blank.
    func checkpoint(_ id: CheckpointId) -> String {
        guard let v = checkpoints[id.storageKey], !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return id.fallback }
        return v
    }

    func setCheckpoint(_ id: CheckpointId, _ key: String) {
        checkpoints[id.storageKey] = key
    }

    private static func store(_ value: String?, _ key: String, _ defaults: UserDefaults) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}
