import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

/// The screen's pure pieces: when an answer is scrolled into view, and the shared status chip.
@MainActor
struct AssetLookupScreenTests {
    /// An answer is brought into view when its first line is under the box row stuck at the top,
    /// or less than a line from the bottom (a phone on its side, the on-screen keyboard up);
    /// otherwise the page stays where it is.
    @Test func anAnswerOutOfSightIsRevealed() {
        #expect(!lookupNeedsReveal(top: 200, viewport: 600, pinned: 72), "at rest, under the header and the row")
        #expect(!lookupNeedsReveal(top: 72, viewport: 116, pinned: 72), "just under the stuck row, a line showing")
        #expect(lookupNeedsReveal(top: 40, viewport: 600, pinned: 72), "hidden under the stuck row")
        #expect(lookupNeedsReveal(top: -40, viewport: 600, pinned: 72), "scrolled past")
        #expect(lookupNeedsReveal(top: 120, viewport: 150, pinned: 72), "less than a line showing")
        #expect(lookupNeedsReveal(top: 300, viewport: 90, pinned: 72), "below the fold")
    }

    /// The box row is brought fully on screen when the header above it pushes its bottom past the
    /// visible area (a phone on its side with the keyboard up); stuck at the top it always fits.
    @Test func aCutOffBoxRowIsBroughtIn() {
        #expect(!lookupRowCutOff(rowTop: 111, rowHeight: 72, viewport: 600))
        #expect(!lookupRowCutOff(rowTop: 0, rowHeight: 72, viewport: 100), "stuck at the top")
        #expect(lookupRowCutOff(rowTop: 111, rowHeight: 72, viewport: 100), "half under the keyboard")
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
