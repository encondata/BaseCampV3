import SwiftUI

/// The wide layout: Time, Value, Asset, Make / Model, Status.
struct ScanTable: View {
    let rows: [OutboxRow]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                ForEach(["Time", "Value", "Asset", "Make / Model", "Status"], id: \.self) { title in
                    Text(title.uppercased()).font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
                }
            }
            .padding(.bottom, 6)
            ForEach(rows, id: \.clientScanId) { row in
                Divider().overlay(palette.paperLine).gridCellUnsizedAxes(.horizontal)
                GridRow {
                    Text(scanTime(row.scannedAt)).font(KioskType.labelMedium).foregroundStyle(palette.textMute)
                    Text(row.shownValue).font(KioskType.labelMedium).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(assetLine(row)).font(KioskType.bodyMedium)
                        .foregroundStyle(row.asset == nil ? ChipTone.red.text : palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(row.asset?.makeModel ?? "").font(KioskType.bodyMedium).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .leading, spacing: 4) {
                        KioskChip(text: statusLabel(row), tone: statusTone(row.status), dot: false)
                        if let err = failureText(row) {
                            Text(err).font(KioskType.labelSmall).foregroundStyle(ChipTone.red.text)
                        }
                    }
                }
                .padding(.vertical, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
