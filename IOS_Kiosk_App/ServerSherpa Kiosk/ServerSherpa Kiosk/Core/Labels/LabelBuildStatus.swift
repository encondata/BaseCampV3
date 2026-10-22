import Foundation

/// A label's outcome codes (kiosk/src/labelgen/plan.ts): `ok`, or why there is no label.
let OUTCOME_OK = "ok"
let NO_TEMPLATE_AT_DPI = "no_template_at_dpi"
let TEMPLATE_FAILED = "template_failed"
let TEMPLATE_UNSUPPORTED = "template_unsupported"

enum LabelBuildPhase: Equatable, Sendable { case idle, running, done, unsupportedDevice, error }

/// What a build is waiting for before it can make labels: a saved printer (its DPI picks the
/// template), or a sync that brings the move's label data (none since the version 2 upgrade).
enum LabelBuildNeed: Equatable, Sendable { case printer, sync }

/// The on-device label build. `total` is how many labels this build renders (only assets whose
/// inputs changed) and `done` how many of them are finished. `ready` counts the move's assets
/// whose current label prints; `problems` counts the others by outcome code, in first-seen order. `notes` are the
/// template pick's notes (a template only at another DPI). `templateId`, `fonts` and
/// `availableDpis` come from the plan for Printer Setup's checks. `error` says why a build failed.
struct LabelBuildStatus: Equatable, Sendable {
    var phase: LabelBuildPhase = .idle
    var done: Int = 0
    var total: Int = 0
    var ready: Int = 0
    var problems: [OutcomeCount] = []
    var notes: [String] = []
    var needs: LabelBuildNeed? = nil
    var templateId: String? = nil
    var fonts: [String] = []
    var availableDpis: [Int] = []
    var error: String? = nil

    /// 0...1 for a progress bar; a finished build with nothing to render is complete.
    var progress: Float {
        if total > 0 { return Float(min(max(done, 0), total)) / Float(total) }
        return phase == .done ? 1 : 0
    }
}

/// The latest build's template pick for `kind` at `dpi`: Printer Setup's DPI and font checks read
/// it, and its alignment label takes the template's size (`widthIn` x `heightIn` inches). `synced`
/// is false when the kiosk had no label data to plan with (never synced, or not since the version 2
/// upgrade); nothing was picked then. `failed` is true when the plan itself failed (the build is
/// an error); nothing was picked then either.
struct LabelPick: Equatable, Sendable {
    var kind: LabelKind
    var dpi: Int
    var synced: Bool
    var templateId: String? = nil
    var templateName: String? = nil
    var notes: [String] = []
    var fonts: [String] = []
    var availableDpis: [Int] = []
    var widthIn: Double? = nil
    var heightIn: Double? = nil
    var failed: Bool = false
}

/// How many labels have one outcome code. A list of these keeps Android's LinkedHashMap order:
/// the order the codes were first seen, which the ready summary joins in.
struct OutcomeCount: Equatable, Sendable {
    var code: String
    var count: Int
}

struct LabelTally: Equatable, Sendable {
    var ready: Int
    var problems: [OutcomeCount]
}

/// Ready labels and the rest counted by outcome, each code in the order it was first seen.
func tallyOutcomes<S: Sequence>(_ outcomes: S) -> LabelTally where S.Element == String {
    var ready = 0
    var problems: [OutcomeCount] = []
    var index: [String: Int] = [:]
    for o in outcomes {
        if o == OUTCOME_OK {
            ready += 1
        } else if let i = index[o] {
            problems[i].count += 1
        } else {
            index[o] = problems.count
            problems.append(OutcomeCount(code: o, count: 1))
        }
    }
    return LabelTally(ready: ready, problems: problems)
}
