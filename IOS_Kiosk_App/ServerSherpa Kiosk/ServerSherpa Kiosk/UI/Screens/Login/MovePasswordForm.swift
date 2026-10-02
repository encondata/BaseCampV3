import SwiftUI

/// The web kiosk's move-password form: one secret field with the eye toggle,
/// Sign in, and the way back to email & password.
struct MovePasswordForm: View {
    @Bindable var vm: LoginViewModel
    let f: CGFloat
    let onBack: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LoginFieldLabel(text: "MOVE PASSWORD", f: f)
            LoginTextField(placeholder: "••••••••", text: $vm.movePassword, reveal: $vm.showMovePassword,
                           invalid: vm.moveError != nil, f: f, focus: $focused)
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
