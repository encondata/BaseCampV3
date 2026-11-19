import SwiftUI

/// The web kiosk's move-password form: one secret field with the eye toggle and,
/// on a device with a camera, the QR button (Android `MoveScanButton`), Sign in,
/// and the way back to email & password.
struct MovePasswordForm: View {
    @Bindable var vm: LoginViewModel
    let f: CGFloat
    /// Opens the camera (QR only); nil hides the button.
    var onScan: (() -> Void)? = nil
    let onBack: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LoginFieldLabel(text: "MOVE PASSWORD", f: f)
            LoginTextField(placeholder: "••••••••", text: $vm.movePassword, reveal: $vm.showMovePassword,
                           invalid: vm.moveError != nil, f: f, focus: $focused,
                           trailing: onScan.map { AnyView(MoveScanButton(enabled: !vm.busy, f: f, action: $0)) })
                .textContentType(.password)
                .submitLabel(.go)
                .onSubmit(submit)
                .padding(.top, 10 * f)
            LoginErrorText(text: vm.moveError, f: f).padding(.top, 12 * f)
            LoginSubmitButton(busy: vm.busy, f: f, action: submit)
                .padding(.top, 24 * f)
            LoginQuietLink(title: "Back to email & password", f: f, action: onBack)
                .frame(maxWidth: .infinity)
                .padding(.top, 12 * f)
        }
        .onAppear { focused = true }
    }

    private func submit() {
        Task { await vm.submitMove() }
    }
}

/// The QR glyph inside the move field: orange, slate while a sign-in runs.
private struct MoveScanButton: View {
    let enabled: Bool
    let f: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VectorIconView(icon: LoginIcons.qrCode, tint: enabled ? LoginTokens.orange : LoginTokens.slate, size: 28 * f)
                .frame(width: 48, height: 48)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel("Scan the move password's QR code")
        .accessibilityIdentifier("login-move-scan")
    }
}
