import Foundation

enum BuiltinSound: String, CaseIterable, Sendable {
    case chime, beep
    case doubleBeep = "double_beep"
    case buzz, bonk

    var label: String {
        switch self {
        case .chime: "Chime"
        case .beep: "Beep"
        case .doubleBeep: "Double beep"
        case .buzz: "Buzz"
        case .bonk: "Bonk"
        }
    }
}

enum SoundChoice: Equatable, Sendable {
    case none
    case builtin(BuiltinSound)
}

/// good / not-found / duplicate choices and a 0–1 volume — kiosk-local.
struct SoundSettings: Equatable, Sendable {
    var good: SoundChoice
    var notFound: SoundChoice
    var duplicate: SoundChoice
    var volume: Double
}

let DEFAULT_SOUND_SETTINGS = SoundSettings(
    good: .builtin(.chime),
    notFound: .builtin(.buzz),
    duplicate: .builtin(.doubleBeep),
    volume: 0.8
)

private func choiceOf(_ v: Any?) -> SoundChoice? {
    // "kind" or "id" may hold an object/array (older build, corrupted document);
    // anything that is not a string falls back to the default for that choice only.
    guard let obj = v as? [String: Any], let kind = obj["kind"] as? String else { return nil }
    switch kind {
    case "none": return SoundChoice.none
    case "builtin": return (obj["id"] as? String).flatMap(BuiltinSound.init(rawValue:)).map { .builtin($0) }
    default: return nil   // "upload" is a web-only kind
    }
}

func parseSoundSettings(_ raw: String?) -> SoundSettings {
    guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let obj = (try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed])) as? [String: Any]
    else { return DEFAULT_SOUND_SETTINGS }
    return SoundSettings(
        good: choiceOf(obj["good"]) ?? DEFAULT_SOUND_SETTINGS.good,
        notFound: choiceOf(obj["not_found"]) ?? DEFAULT_SOUND_SETTINGS.notFound,
        duplicate: choiceOf(obj["duplicate"]) ?? DEFAULT_SOUND_SETTINGS.duplicate,
        volume: jsonNumber(obj["volume"]).map { min(max($0, 0), 1) } ?? DEFAULT_SOUND_SETTINGS.volume
    )
}

extension SoundSettings {
    /// Same keys and `kind` values as Android's (and the web's) stored document.
    func toJSON() -> String {
        func obj(_ c: SoundChoice) -> [String: Any] {
            switch c {
            case .none: ["kind": "none"]
            case .builtin(let s): ["kind": "builtin", "id": s.rawValue]
            }
        }
        let doc: [String: Any] = ["good": obj(good), "not_found": obj(notFound), "duplicate": obj(duplicate), "volume": volume]
        let data = (try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
