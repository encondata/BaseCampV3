import Foundation

/// The label generator (Resources/labelgen.js, built from kiosk/src/labelgen, the same bytes the
/// Android kiosk runs). `call` runs one surface function: `fn` with its arguments as one JSON
/// object, answering the function's JSON (a result or `{"error": ...}`).
protocol LabelEngine: Sendable {
    func call(_ fn: String, _ argsJson: String) async throws -> String

    /// False when this device can't run the generator at all.
    func isSupported() async -> Bool
}

/// Why a generator call failed (Android's `LabelEngine*Exception`s and `require`).
enum LabelEngineError: Error, Equatable, CustomStringConvertible {
    /// This device can't run the generator: the bundle is missing or broken, its surface version
    /// isn't this app's, or JavaScriptCore wouldn't make a context.
    case unsupported
    /// The script threw, or answered something other than text.
    case evaluationFailed(String)
    /// The call `fn` took too long; its context was abandoned so the next call starts fresh.
    case timeout(String)
    /// `fn` is not one of the surface's functions; nothing ran.
    case notAllowed(String)

    var description: String {
        switch self {
        case .unsupported: "label generation isn't supported on this device"
        case .evaluationFailed(let message): "the label generator failed: \(message)"
        case .timeout(let fn): "the label generator took too long (\(fn))"
        case .notAllowed(let fn): "not a label generator function: \(fn)"
        }
    }

    /// For `askingAgainOnTimeout` and `prepareForPrinter`.
    static func isTimeout(_ error: Error) -> Bool {
        if case .timeout = error as? LabelEngineError { return true }
        return false
    }

    /// For `prepareForPrinter` and the label build.
    static func isUnsupported(_ error: Error) -> Bool {
        (error as? LabelEngineError) == .unsupported
    }
}

/// The generator's surface, as Android's `LabelScripts` and `LabelGenerator` define it.
enum LabelScripts {
    /// The surface's functions (kiosk/src/labelgen/index.ts); nothing else is ever called.
    static let functions: Set<String> = ["buildPlan", "renderLabels", "sampleLabel", "applyPrintSettings", "withPrintMode", "alignmentTestZpl"]

    /// The surface version this app speaks (`labelgen.version`).
    static let version = "1"
    static let versionScript = "String(globalThis.labelgen && labelgen.version)"

    /// The bundle's resource name in the app (`labelgen.js`).
    static let bundleName = "labelgen"
    static let bundleExtension = "js"

    /// Generous for the build (a plan of a large move on a slow device), short for the print
    /// helpers (milliseconds of work: a print never waits long on a stuck generator).
    static func defaultTimeoutSeconds(_ fn: String) -> Double {
        switch fn {
        case "buildPlan": 120
        case "renderLabels": 60
        default: 5
        }
    }
}
