import SwiftUI

/// Small line icons drawn the same way as the launcher tiles (FeatureIcons):
/// path data traced from Android `ui/components/KioskIcons.kt`, stroked in the caller's tint.
enum KioskIcons {
    /// A camera seen head-on: body, the lens, and the shutter bump on top.
    static let camera = VectorIcon(viewport: 24, lineWidth: 1.8, strokes: [
        "M4 8h3.2l1.6-2.6h6.4L16.8 8H20a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
        "M12 10.6a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6z",
    ])
}

/// The camera affordance for a scan box: tap the lens, the full-screen scanner opens.
struct CameraFieldButton: View {
    var enabled: Bool = true
    let action: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Button(action: action) {
            VectorIconView(icon: KioskIcons.camera, tint: palette.accent, size: 24)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .accessibilityLabel("Scan with the camera")
    }
}
