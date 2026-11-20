import SwiftUI

/// kiosk/src/pages/Troubleshooting.tsx: the bundled hardware guides, one card each.
struct TroubleshootingView: View {
    @Binding var path: [Route]
    @Environment(\.kioskPalette) private var palette
    private let topics = TroubleshootingContent.topics()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Troubleshooting", title: "Troubleshooting")
                ForEach(topics) { topic in
                    SetupCard(selected: false, action: { path.append(.troubleshootingTopic(topic.id)) }) {
                        Text(topic.title).font(KioskType.titleLarge).foregroundStyle(palette.text)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(topic.blurb).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                            .fixedSize(horizontal: false, vertical: true).padding(.top, 4)
                    }
                    .accessibilityIdentifier("topic-\(topic.id)")
                    .padding(.bottom, 10)
                }
            }
            .padding(16)
        }
        .background(palette.paper2)
    }
}
