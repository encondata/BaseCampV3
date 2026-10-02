import Foundation

/// `kiosk_setup_complete` — kiosk-local; default incomplete.
enum SetupState: String, Sendable {
    case incomplete, complete, failed

    var label: String {
        switch self {
        case .incomplete: "Incomplete"
        case .complete: "Complete"
        case .failed: "Failed"
        }
    }

    var isComplete: Bool { self == .complete }

    static func fromWire(_ s: String?) -> SetupState {
        s.flatMap(SetupState.init(rawValue:)) ?? .incomplete
    }
}
