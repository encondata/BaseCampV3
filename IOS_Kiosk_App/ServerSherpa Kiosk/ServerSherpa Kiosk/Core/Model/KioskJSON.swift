import Foundation

/// Shared coders. No key strategy: every model spells its wire names in `CodingKeys`.
/// Decoding ignores unknown keys and nil optionals are omitted on encode.
enum KioskJSON {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    static let decoder = JSONDecoder()
}
