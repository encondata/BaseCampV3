import SwiftUI

/// A sheet's or card's content above its buttons, for every sheet, cover or card with action
/// buttons. Jimmy's rule: "make sure that we never hide buttons behind a scroll." The actions are
/// never inside the scroll: while everything fits they sit right under the content; when it
/// doesn't (very large text, an iPhone in landscape) only the content scrolls, and the actions
/// stay pinned below it, on screen.
///
/// The block takes the height it needs and no more, and that height is its ideal, so a sheet with
/// `.presentationSizing(.form.fitted(...))` or a centered card sizes to it. A sheet taller than the
/// block puts it at the top itself (`.frame(maxHeight: .infinity, alignment: .top)`).
///
/// `padding` goes around the two as one block (the content's top and sides, the actions' sides
/// and bottom), as it would around a single column.
struct PinnedActions<Content: View, Actions: View>: View {
    let padding: EdgeInsets
    private let content: Content
    private let actions: Actions
    /// The content's natural height, measured inside the scroll view (where text is never squeezed).
    @State private var contentHeight: CGFloat?

    init(padding: EdgeInsets, @ViewBuilder content: () -> Content, @ViewBuilder actions: () -> Actions) {
        self.padding = padding
        self.content = content()
        self.actions = actions()
    }

    init(padding: CGFloat, @ViewBuilder content: () -> Content, @ViewBuilder actions: () -> Actions) {
        self.init(padding: EdgeInsets(top: padding, leading: padding, bottom: padding, trailing: padding),
                  content: content, actions: actions)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                content
                    .padding(EdgeInsets(top: padding.top, leading: padding.leading, bottom: 0, trailing: padding.trailing))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            // As tall as the content (its ideal too, which a fitted sheet asks for) and no taller,
            // so the actions follow it; shorter when space runs out, and then it scrolls.
            .frame(idealHeight: contentHeight, maxHeight: contentHeight ?? .infinity)
            actions
                .padding(EdgeInsets(top: 0, leading: padding.leading, bottom: padding.bottom, trailing: padding.trailing))
                // Sized first and never squeezed: the scroll view gets what's left.
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
        }
    }
}
