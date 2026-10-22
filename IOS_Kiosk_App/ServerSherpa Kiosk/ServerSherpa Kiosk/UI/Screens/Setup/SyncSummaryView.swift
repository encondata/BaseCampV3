import SwiftUI

/// Android `SyncSummary.kt`: the text of the Kiosk Setup summary's sync section.
enum SyncSummary {
    /// One row of the running sync: the part's name, its state and the text shown for both.
    struct PartLine: Equatable {
        let label: String
        let state: PartState
        let text: String
    }

    /// What the section shows for a sync status.
    enum Content: Equatable {
        case idle
        case running([PartLine])
        /// The local-data line and, when a label download failed, its warning.
        case done(line: String, warning: String?)
        case error(String)

        /// The button beside the line; none while the sync runs.
        var button: String? {
            switch self {
            case .idle: "Sync now"
            case .running: nil
            case .done: "Sync again"
            case .error: "Try again"
            }
        }
    }

    static let idleText = "No move data on this kiosk yet."
    static let runningTitle = "Downloading move data…"

    @MainActor static func content(_ s: SyncStatus) -> Content {
        switch s.phase {
        case .idle: .idle
        case .running: .running(partLines(s))
        case .done: .done(line: localDataLine(s), warning: labelsWarning(s))
        case .error: .error("Couldn't download move data (\(s.error ?? "unknown_error")).")
        }
    }

    private static func partLabel(_ name: String) -> String {
        name == "templates" ? "Label templates" : name.prefix(1).uppercased() + name.dropFirst()
    }

    /// The six downloads in display order, each with its state ("Assets · done (10)").
    static func partLines(_ status: SyncStatus) -> [PartLine] {
        status.parts.map { p in
            let label = partLabel(p.name)
            let state = switch p.state {
            case .waiting: "waiting"
            case .running: "downloading…"
            case .done: p.count.map { "done (\($0))" } ?? "done"
            case .failed: "failed"
            }
            return PartLine(label: label, state: p.state, text: "\(label) · \(state)")
        }
    }

    private static func doneCount(_ s: SyncStatus, _ name: String) -> Int? {
        s.parts.first { $0.name == name && $0.state == .done }?.count
    }

    /// "Local data: 10 assets · … · 4 label templates · 2 fonts · synced 2:14 PM". Label counts
    /// appear only for a part that finished: never-synced or failed ones are left out.
    @MainActor static func localDataLine(_ s: SyncStatus) -> String {
        func n(_ count: Int?, _ one: String, _ many: String) -> String {
            let c = count ?? 0
            return "\(c) \(c == 1 ? one : many)"
        }
        var line = "Local data: \(n(s.assets, "asset", "assets")) · \(n(s.people, "person", "people")) · \(n(s.containers, "container", "containers")) · \(n(s.trucks, "truck", "trucks"))"
        if let t = doneCount(s, "templates") { line += " · \(t) label \(t == 1 ? "template" : "templates")" }
        if let f = doneCount(s, "fonts") { line += " · \(f) \(f == 1 ? "font" : "fonts")" }
        if let at = s.syncedAt { line += " · synced \(Sync.formatSyncedAt(at))" }
        return line
    }

    /// The soft-failure warning for the label downloads, or nil when none failed.
    static func labelsWarning(_ s: SyncStatus) -> String? {
        guard s.labelsError != nil else { return nil }
        let templates = s.parts.contains { $0.name == "templates" && $0.state == .failed }
        let fonts = s.parts.contains { $0.name == "fonts" && $0.state == .failed }
        let what = switch (templates, fonts) {
        case (true, true): "Label templates and fonts"
        case (true, false): "Label templates"
        case (false, true): "Fonts"
        case (false, false): "Label data"
        }
        return "\(what) couldn't be downloaded. Labels may be out of date."
    }
}

/// The Kiosk Setup summary's sync line: idle prompt, per-part progress while running, counts when done.
struct SyncSummaryView: View {
    let status: SyncStatus
    let onSync: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let content = SyncSummary.content(status)
        switch content {
        case .running(let lines):
            VStack(alignment: .leading, spacing: 2) {
                Text(SyncSummary.runningTitle).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                ForEach(lines, id: \.label) { line in
                    Text(line.text).font(KioskType.labelSmall).foregroundStyle(color(line.state))
                }
            }
            .padding(.top, 12)
        case .idle, .done, .error:
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    switch content {
                    case .done(let line, _):
                        Text(line).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    case .error(let message):
                        KioskToast(text: message, error: true)
                    default:
                        Text(SyncSummary.idleText).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                    }
                    if let title = content.button { SecondaryButton(title, action: onSync) }
                }
                if case .done(_, let warning?) = content {
                    Text(warning).font(KioskType.bodySmall).foregroundStyle(ChipTone.amber.text)
                }
            }
            .padding(.top, 12)
        }
    }

    private func color(_ state: PartState) -> Color {
        switch state {
        case .failed: ChipTone.red.text
        case .done: ChipTone.green.text
        case .waiting, .running: palette.textMute
        }
    }
}
