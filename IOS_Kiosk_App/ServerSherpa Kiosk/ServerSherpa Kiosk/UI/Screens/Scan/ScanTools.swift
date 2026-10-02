import SwiftUI

/// The receipt counts and the list actions: Retry failed, Clear sent, Discard failed.
struct ScanTools: View {
    let counts: OutboxCounts
    let onRetry: () -> Void
    let onClear: () -> Void
    let onDiscard: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Queued \(counts.queued) · Sent \(counts.accepted) · Failed \(counts.failed) · No match \(counts.nomatch)")
                .font(KioskType.labelMedium).foregroundStyle(palette.textMute)
            HStack(spacing: 8) {
                SecondaryButton("Retry failed", enabled: counts.failed > 0, action: onRetry)
                SecondaryButton("Clear sent", enabled: counts.accepted + counts.nomatch > 0, action: onClear)
                SecondaryButton("Discard failed", enabled: counts.failed > 0, action: onDiscard)
            }
        }
        .padding(.top, 8).padding(.bottom, 8)
    }
}
