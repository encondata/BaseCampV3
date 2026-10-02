import SwiftUI

/// The portal's `.chip.c-*`.
struct KioskChip: View {
    let text: String
    let tone: ChipTone
    var dot: Bool = true

    var body: some View {
        HStack(spacing: 6) {
            if dot { Circle().fill(tone.text).frame(width: 6, height: 6) }
            Text(text).font(KioskType.labelMedium).foregroundStyle(tone.text).lineLimit(1)
        }
        .padding(.horizontal, 9).padding(.vertical, 3)
        .background(tone.bg, in: Capsule())
        .overlay(Capsule().stroke(tone.border, lineWidth: 1))
    }
}
