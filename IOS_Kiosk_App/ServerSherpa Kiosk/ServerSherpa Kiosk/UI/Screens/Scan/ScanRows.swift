import SwiftUI

func statusTone(_ s: OutboxStatus) -> ChipTone {
    switch s {
    case .accepted: .green
    case .queued, .sending, .retrying: .amber
    case .failed, .nomatch: .red
    }
}

/// "A-1 · Rack", or "No match" when nothing on the roster matched.
func assetLine(_ row: OutboxRow) -> String {
    guard let a = row.asset else { return "No match" }
    return [a.assetId.isEmpty ? nil : a.assetId, a.name].compactMap { $0 }.joined(separator: " · ")
}

/// A failed row's reason, shown under its pill.
func failureText(_ row: OutboxRow) -> String? { row.status == .failed ? row.lastError : nil }

/// The narrow layout: one stacked entry per scan.
struct ScanRows: View {
    let rows: [OutboxRow]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(rows, id: \.clientScanId) { row in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(scanTime(row.scannedAt)).font(KioskType.labelMedium).foregroundStyle(palette.textMute)
                        Text(row.shownValue).font(KioskType.labelMedium).foregroundStyle(palette.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        KioskChip(text: statusLabel(row), tone: statusTone(row.status), dot: false)
                    }
                    let line = [assetLine(row), row.asset.flatMap { $0.makeModel.isEmpty ? nil : $0.makeModel }]
                        .compactMap { $0 }.joined(separator: " · ")
                    Text(line).font(KioskType.bodySmall)
                        .foregroundStyle(row.asset == nil ? ChipTone.red.text : palette.text)
                    if let err = failureText(row) {
                        Text(err).font(KioskType.labelSmall).foregroundStyle(ChipTone.red.text)
                    }
                }
                .padding(.vertical, 8)
                Divider().overlay(palette.paperLine)
            }
        }
    }
}
