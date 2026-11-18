import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

/// The screen's pure pieces: when an answer is scrolled into view, and the shared status chip.
@MainActor
struct AssetLookupScreenTests {
    /// An answer is brought into view when its first line is above the visible area or less than
    /// a line from its bottom (a phone on its side, the on-screen keyboard up); otherwise the page
    /// stays where it is.
    @Test func anAnswerOutOfSightIsRevealed() {
        #expect(!lookupNeedsReveal(top: 120, viewport: 600))
        #expect(!lookupNeedsReveal(top: 0, viewport: 44))
        #expect(lookupNeedsReveal(top: 120, viewport: 150), "less than a line showing")
        #expect(lookupNeedsReveal(top: 300, viewport: 90), "below the fold")
        #expect(lookupNeedsReveal(top: -40, viewport: 600), "scrolled past")
    }

    private func width(_ chip: ColorChip, dark: Bool = false) -> CGFloat {
        let renderer = ImageRenderer(content: chip.environment(\.kioskPalette, dark ? .dark : .light))
        return renderer.uiImage?.size.width ?? 0
    }

    /// Android caps the chip at 160 dp and ends a longer label in "…"; a short one keeps its own width.
    @Test func aChipIsAtMost160PointsWide() {
        let long = width(ColorChip(text: "A status label far longer than any chip should ever be allowed to get", color: .red))
        #expect(long > 100 && long <= ColorChip.maxWidth + 0.5, "\(long)")
        let short = width(ColorChip(text: "Packed", color: .red))
        #expect(short > 20 && short < 100, "\(short)")
        #expect(width(ColorChip(text: "Packed", color: nil, dot: true)) > short, "the dot adds room")
    }

    /// On light paper the words are the status color darkened (Android's 40% toward black); on
    /// dark paper they're the page's text color.
    @Test func theInkDarkensOnLightPaperOnly() {
        let env = EnvironmentValues()
        let tint = Color(hex: 0x22AA55)
        let light = ColorChip.ink(tint, dark: false, text: .white).resolve(in: env)
        let base = tint.resolve(in: env)
        #expect(light.red < base.red && light.green < base.green * 0.8 && light.blue < base.blue)
        #expect(ColorChip.ink(tint, dark: true, text: .white).resolve(in: env) == Color.white.resolve(in: env))
    }
}
