import SwiftUI
import UIKit

/// The reader's input on Welcome and Enter Your Name: an invisible first responder
/// that takes a hardware keyboard's keystrokes (a Bluetooth badge or QR reader is a
/// keyboard) without ever raising the software keyboard, since Enter Your Name has
/// its own. It holds focus while `active`, takes it back when the app returns, and
/// never steals it from another field.
struct TcKeyCapture: UIViewRepresentable {
    let active: Bool
    let onInsert: (String) -> Void
    let onDelete: () -> Void

    func makeUIView(context: Context) -> TcKeyCaptureView {
        let view = TcKeyCaptureView()
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: TcKeyCaptureView, context: Context) {
        view.onInsert = onInsert
        view.onDelete = onDelete
        view.active = active
    }
}

final class TcKeyCaptureView: UIView, UIKeyInput {
    var onInsert: (String) -> Void = { _ in }
    var onDelete: () -> Void = {}
    var active = false { didSet { if active != oldValue || active { claim() } } }

    private var observer: NSObjectProtocol?

    override init(frame: CGRect) {
        super.init(frame: frame)
        inputAssistantItem.leadingBarButtonGroups = []
        inputAssistantItem.trailingBarButtonGroups = []
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.claim() }
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    // No software keyboard and no shortcuts bar: the flow draws its own keys.
    private let emptyInput = UIView(frame: .zero)
    override var inputView: UIView? { emptyInput }
    override var canBecomeFirstResponder: Bool { active }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        claim()
    }

    /// Takes focus when wanted and nothing else (a text field, a sheet's control) holds it.
    private func claim() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil else { return }
            if !self.active {
                if self.isFirstResponder { self.resignFirstResponder() }
                return
            }
            if !self.isFirstResponder && !FirstResponder.exists() { self.becomeFirstResponder() }
        }
    }

    // MARK: UIKeyInput

    var hasText: Bool { true }
    func insertText(_ text: String) { onInsert(text) }
    func deleteBackward() { onDelete() }

    // MARK: UITextInputTraits

    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
}
