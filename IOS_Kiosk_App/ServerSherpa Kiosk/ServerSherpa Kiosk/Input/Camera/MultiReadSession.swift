import Foundation

/// Multi-read mode: each distinct barcode is published once per sheet open.
final class MultiReadSession {
    private var seen = Set<String>()
    private var order: [String] = []

    var count: Int { seen.count }
    /// Newest first, at most five.
    var recent: [String] { Array(order.reversed().prefix(5)) }

    func offer(_ value: String) -> Bool {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty || !seen.insert(v).inserted { return false }
        order.append(v)
        return true
    }
}
