import Foundation
@testable import ServerSherpa_Kiosk

/// What the fake throws from a failing `renderLabels` call (Android's `IllegalStateException`).
struct FakeEngineDied: Error, CustomStringConvertible {
    var description: String { "isolate died" }
}

/// Port of Android's `FakeLabelEngine`: a generator stand-in that reads the same JSON args the
/// bundle does. One job per asset of the assets body, a fingerprint of the asset's text, the
/// templates, kind and DPI, and a label naming them. An asset whose payload has `"outcome"` gets
/// that outcome and no ZPL. Main-actor state: tests set it up and read it between awaits.
@MainActor final class FakeLabelEngine: LabelEngine {
    struct Call {
        var fn: String
        var args: [String: Any]

        func string(_ key: String) -> String { args[key] as? String ?? "" }
        var assetIds: [String] { args["assetIds"] as? [String] ?? [] }
    }

    var supported = true
    private(set) var calls: [Call] = []
    /// Throws from the n-th renderLabels call (1-based, counted over the fake's life).
    var failRender: Int?
    /// Replaces buildPlan's answer.
    var planAnswer: (() -> String)?
    var renderAnswer: (() -> String)?
    /// Thrown from every renderLabels call when set.
    var renderError: Error?
    /// Rewrites each renderLabels answer's result objects (missing or odd results).
    var mutateResults: (([[String: Any]]) -> [[String: Any]])?
    var onRender: () async -> Void = {}
    /// When set, the next renderLabels call waits (cancellably) until it is cleared; it clears
    /// itself when that call ends either way.
    var gate = false
    /// Set when a call reached the gate.
    private(set) var atGate = false
    private(set) var gatePassed = 0
    private(set) var lastPlan: String?
    var unsupportedOnCall = false
    private(set) var renders = 0

    nonisolated init() {}

    // The engine's members are nonisolated (it is Sendable); the work hops to the main actor.
    nonisolated func isSupported() async -> Bool { await supportedNow() }

    nonisolated func call(_ fn: String, _ argsJson: String) async throws -> String { try await answer(fn, argsJson) }

    private func supportedNow() -> Bool { supported }

    private func answer(_ fn: String, _ argsJson: String) async throws -> String {
        if unsupportedOnCall { throw LabelEngineError.unsupported }
        let args = Self.object(argsJson)
        calls.append(Call(fn: fn, args: args))
        let body = Self.object(args["assetsJson"] as? String ?? "{}")
        let templates = args["templatesJson"] as? String ?? ""
        let kind = args["kind"] as? String ?? ""
        let dpi = args["dpi"] as? Int ?? 0
        let hasData = body["label_context"] is [String: Any] && body["assets"] is [Any]
        let rows = hasData ? (body["assets"] as? [[String: Any]] ?? []) : []
        func id(_ row: [String: Any]) -> String { row["id"] as? String ?? "" }
        func fp(_ row: [String: Any]) -> String { "\(Self.text(row).hashValue):\(templates.hashValue):\(kind):\(dpi)" }

        switch fn {
        case "buildPlan":
            let answer = planAnswer?() ?? Self.text([
                "templateId": "t1", "templateFamily": "vegas", "notes": ["a pick note"], "fonts": ["ROBOTO.TTF"],
                "availableDpis": [Int](), "hasAssetData": hasData,
                "jobs": rows.map { ["assetId": id($0), "fingerprint": fp($0)] },
            ])
            lastPlan = answer
            return answer
        case "renderLabels":
            renders += 1
            await onRender()
            if gate {
                atGate = true
                do {
                    while gate { try await Task.sleep(for: .milliseconds(5)) }
                } catch {
                    gate = false
                    throw error
                }
                gatePassed += 1
            }
            if renders == failRender { throw FakeEngineDied() }
            if let renderError { throw renderError }
            if let renderAnswer { return renderAnswer() }
            let ids = args["assetIds"] as? [String] ?? []
            var byId: [String: [String: Any]] = [:]
            for r in rows { byId[id(r)] = r }
            let results: [[String: Any]] = ids.compactMap { byId[$0] }.map { r in
                let outcome = r["outcome"] as? String
                return [
                    "assetId": id(r),
                    "zpl": outcome == nil ? "^XA^FD\(id(r)) \(kind) \(dpi)^FS^XZ" as Any : NSNull(),
                    "outcome": outcome ?? "ok",
                    "fingerprint": fp(r),
                ]
            }
            return Self.text(["results": mutateResults?(results) ?? results])
        default:
            throw LabelGenException("unexpected \(fn)")
        }
    }

    func count(_ fn: String) -> Int { calls.filter { $0.fn == fn }.count }
    func renderedIds() -> [String] { calls.filter { $0.fn == "renderLabels" }.flatMap(\.assetIds) }
    func clearCalls() { calls.removeAll() }

    static func object(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])) as? [String: Any] ?? [:]
    }

    static func text(_ value: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
