import SwiftUI
import UIKit

/// The always-focused box: a barcode scanner is a keyboard, so whatever it
/// types lands here and its Enter submits. It takes focus when it appears and
/// takes it back when focus drifts to nothing (a tap on empty space, the app
/// coming back) — never from another field or control that took it.
/// `keepFocus: false` lets a screen pause that (the camera sheet is up).
struct ScanInput<Trailing: View>: View {
    let placeholder: String
    var enabled: Bool = true
    var keepFocus: Bool = true
    /// `false` leaves the typed text in the box after Enter (Timeclock keeps a name and its matches on screen).
    var clearOnSubmit: Bool = true
    /// A screen that keeps the text bumps this to empty the box itself.
    var resetToken: Int = 0
    /// The box's text when the screen holds it (Asset Lookup puts a missed value back); nil keeps
    /// it inside the box.
    var text: Binding<String>?
    /// With `text`: bump this to select the whole text, so the next scanner burst replaces it
    /// rather than appending to it (the web's `focusInput(true)`).
    var selectToken: Int = 0
    let onSubmit: (String) -> Void
    /// Reports every change of the box's text (RFID Enroll previews the padded tag from it).
    var onTextChange: ((String) -> Void)?
    @ViewBuilder let trailing: () -> Trailing

    @State private var ownText = ""
    @FocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.kioskPalette) private var palette

    init(placeholder: String, enabled: Bool = true, keepFocus: Bool = true, clearOnSubmit: Bool = true, resetToken: Int = 0,
         text: Binding<String>? = nil, selectToken: Int = 0,
         onSubmit: @escaping (String) -> Void, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.placeholder = placeholder
        self.enabled = enabled
        self.keepFocus = keepFocus
        self.clearOnSubmit = clearOnSubmit
        self.resetToken = resetToken
        self.text = text
        self.selectToken = selectToken
        self.onSubmit = onSubmit
        self.trailing = trailing
    }

    private var wantsFocus: Bool { enabled && keepFocus }
    private var boxText: Binding<String> { text ?? $ownText }

    func onTextChange(_ handler: @escaping (String) -> Void) -> Self {
        var copy = self
        copy.onTextChange = handler
        return copy
    }

    var body: some View {
        HStack(spacing: 4) {
            TextField(placeholder, text: boxText)
                .font(KioskType.bodyLarge)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.done)
                .disabled(!enabled)
                .onChange(of: boxText.wrappedValue) { _, new in onTextChange?(new) }
                .onChange(of: resetToken) { _, _ in boxText.wrappedValue = "" }
                .onChange(of: selectToken) { _, _ in
                    guard wantsFocus else { return }
                    focused = true
                    // UIKit's select-all on the focused field, once the new text is in it. (A SwiftUI
                    // selection binding goes stale when the text changes under it, and traps.)
                    DispatchQueue.main.async { if focused { FirstResponder.selectAll() } }
                }
                .onSubmit {
                    let value = boxText.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                    if clearOnSubmit { boxText.wrappedValue = "" }
                    if !value.isEmpty { onSubmit(value) }
                    if wantsFocus { focused = true }
                }
                .accessibilityIdentifier("scan-input")
            trailing()
        }
        .padding(.leading, 14).padding(.trailing, 4)
        .frame(minHeight: 52)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(focused ? palette.accent : palette.paperLine, lineWidth: focused ? 2 : 1))
        .task(id: wantsFocus) {
            guard wantsFocus else { return }
            try? await Task.sleep(for: .milliseconds(50))
            focused = true
        }
        .task(id: "\(wantsFocus)-\(focused)") {
            // While the box wants focus and lacks it, re-check twice a second (the first check comes
            // after the tap that moved focus lands); canceled when focus returns or the view goes away.
            guard wantsFocus, !focused else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                if Task.isCancelled { return }
                if shouldReclaimFocus(wantsFocus: wantsFocus, isFocused: focused, somethingElseHasFocus: FirstResponder.exists()) {
                    focused = true
                    return
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, wantsFocus { focused = true }
        }
    }
}

/// Reclaim focus only when the box wants it, lacks it, and no other field or control holds it.
func shouldReclaimFocus(wantsFocus: Bool, isFocused: Bool, somethingElseHasFocus: Bool) -> Bool {
    wantsFocus && !isFocused && !somethingElseHasFocus
}

extension ScanInput where Trailing == EmptyView {
    init(placeholder: String, enabled: Bool = true, keepFocus: Bool = true, clearOnSubmit: Bool = true, resetToken: Int = 0,
         onSubmit: @escaping (String) -> Void) {
        self.init(placeholder: placeholder, enabled: enabled, keepFocus: keepFocus, clearOnSubmit: clearOnSubmit,
                  resetToken: resetToken, onSubmit: onSubmit) { EmptyView() }
    }
}

/// Whether any view holds the keyboard focus (UIKit's first responder).
@MainActor
enum FirstResponder {
    private static weak var found: UIResponder?

    static func exists() -> Bool {
        found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.ss_captureFirstResponder), to: nil, from: nil, for: nil)
        return found != nil
    }

    fileprivate static func capture(_ responder: UIResponder) { found = responder }

    /// Selects all of the focused field's text, so the next typing replaces it.
    static func selectAll() {
        UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil)
    }
}

extension UIResponder {
    @objc fileprivate func ss_captureFirstResponder() { FirstResponder.capture(self) }
}
