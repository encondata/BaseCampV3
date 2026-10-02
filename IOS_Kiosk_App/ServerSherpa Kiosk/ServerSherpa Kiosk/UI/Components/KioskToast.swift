import Observation
import SwiftUI

/// `.tc-toast` (status) and `.form-error` (alert) lines, inline in a page.
struct KioskToast: View {
    let text: String?
    var error: Bool = false
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        if let text {
            let tone: ChipTone = error ? .red : .green
            Text(text)
                .font(KioskType.bodyMedium)
                .foregroundStyle(error ? tone.text : palette.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(tone.bg, in: RoundedRectangle(cornerRadius: 10))
                .padding(.vertical, 6)
        }
    }
}

/// A transient status line shown over the page; each message hides after 3 s.
@MainActor @Observable
final class ToastCenter {
    struct Message: Equatable {
        let id: Int
        let text: String
        let error: Bool
    }

    private(set) var message: Message?
    @ObservationIgnored private var nextId = 0
    @ObservationIgnored private var hide: Task<Void, Never>?

    func show(_ text: String, error: Bool = false) {
        nextId += 1
        let mine = Message(id: nextId, text: text, error: error)
        message = mine
        hide?.cancel()
        hide = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled, self.message?.id == mine.id else { return }
            self.message = nil
        }
    }

    func dismiss() {
        hide?.cancel()
        message = nil
    }
}

/// Where `ToastCenter` messages appear: bottom of the page, above the footer.
struct ToastHost: View {
    @Environment(ToastCenter.self) private var toasts

    var body: some View {
        if let message = toasts.message {
            KioskToast(text: message.text, error: message.error)
                .frame(maxWidth: 560)
                .padding(.horizontal, 16)
                .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                .transition(.opacity)
                .onTapGesture { toasts.dismiss() }
                .id(message.id)
        }
    }
}
