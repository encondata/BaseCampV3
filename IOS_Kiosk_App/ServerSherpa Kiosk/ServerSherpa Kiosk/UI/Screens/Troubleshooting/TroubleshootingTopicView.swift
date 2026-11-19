import SwiftUI

// MARK: - What the page shows (pure, tested)

let TOPIC_UNAVAILABLE = "This topic isn't available."

enum TroubleshootingTopicState: Equatable {
    case loaded(TroubleshootingContent.Topic, [WikiBlock])
    /// No such topic, or its document won't load.
    case unavailable
}

func troubleshootingTopicState(_ topicId: String, bundle: Bundle = .main) -> TroubleshootingTopicState {
    guard let topic = TroubleshootingContent.topics(bundle: bundle).first(where: { $0.id == topicId }),
          let doc = TroubleshootingContent.doc(for: topic, bundle: bundle) else { return .unavailable }
    return .loaded(topic, wikiDocBlocks(doc))
}

/// Back to Troubleshooting: to the list if it is underneath, else the list in this page's place.
func backToTroubleshooting(_ path: [Route]) -> [Route] {
    if let i = path.lastIndex(of: .troubleshooting) { return Array(path[...i]) }
    return path.dropLast() + [.troubleshooting]
}

// MARK: - The screen

/// kiosk/src/pages/TroubleshootingTopic.tsx: one guide from its bundled wiki document. An
/// unknown topic, or a document that won't load, says so and offers the way back to the list.
struct TroubleshootingTopicView: View {
    @Binding var path: [Route]
    @Environment(\.kioskPalette) private var palette
    /// Read once from the bundle (a small local file).
    private let state: TroubleshootingTopicState

    init(topicId: String, path: Binding<[Route]>) {
        _path = path
        state = troubleshootingTopicState(topicId)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                switch state {
                case .loaded(let topic, let blocks):
                    PageHeader(eyebrow: "Kiosk · Troubleshooting", title: topic.title)
                    WikiDocView(blocks: blocks)
                case .unavailable:
                    PageHeader(eyebrow: "Kiosk · Troubleshooting", title: "Troubleshooting")
                    PlaceholderCard(text: TOPIC_UNAVAILABLE, actionText: "Back to Troubleshooting") {
                        path = backToTroubleshooting(path)
                    }
                }
            }
            .padding(16)
        }
        .background(palette.paper2)
    }
}
