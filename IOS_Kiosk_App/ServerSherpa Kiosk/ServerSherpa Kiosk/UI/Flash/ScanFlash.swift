import SwiftUI

/// Paints the whole window in the flash color, 85 % opaque, fading out over the flash's duration.
struct ScanFlash: View {
    @Environment(FlashController.self) private var controller

    var body: some View {
        if let current = controller.state {
            FlashLayer(state: current)
                .id(current.id)   // a newer flash starts its own fade from 0.85
        }
    }
}

private struct FlashLayer: View {
    let state: FlashController.FlashState
    @State private var opacity = 0.85

    var body: some View {
        state.color.opacity(opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onAppear {
                withAnimation(.linear(duration: Double(state.ms) / 1000)) { opacity = 0 }
            }
    }
}
