import SwiftUI

/// A feature that has no screen yet (and, until their tasks land, the routes still being built).
struct FeaturePlaceholderScreen: View {
    let feature: KioskFeature
    @Binding var path: [Route]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · \(feature.title)", title: feature.title, subtitle: "Coming soon. \(feature.blurb)")
                PlaceholderCard(text: "This feature is not available yet.", actionText: "Back to home") { path.removeAll() }
            }
            .padding(16)
        }
        .background(palette.paper2)
    }
}
