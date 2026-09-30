import SwiftUI

/// The login element sheet's line icons (portal `loginIcons.tsx`); `s` shorthand
/// curves written out as `C` so `SvgPath` reads them.
enum LoginIcons {
    static let eye = VectorIcon(viewport: 24, lineWidth: 1.8, strokes: [
        "M2 12C2 12 5.5 5 12 5C18.5 5 22 12 22 12C22 12 18.5 19 12 19C5.5 19 2 12 2 12Z",
        svgCircle(12, 12, 3),
    ])
    static let eyeOff = VectorIcon(viewport: 24, lineWidth: 1.8, strokes: [
        "M3 3l18 18",
        "M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12C2 12 5.5 19 12 19c1.9 0 3.6-.6 5-1.5",
        "M9.9 9.9a3 3 0 0 0 4.2 4.2",
    ])
    static let link = VectorIcon(viewport: 24, lineWidth: 2, strokes: [
        svgCircle(17, 7, 3.5), svgCircle(7, 17, 3.5), "M9.5 14.5l5-5",
    ])
    static let arrow = VectorIcon(viewport: 24, lineWidth: 2.2, strokes: ["M5 12h14M13 6l6 6-6 6"])
}

/// Colors the form uses beyond `LoginTokens`.
enum LoginFormColors {
    static let label = Color(hex: 0x475569)
    static let placeholder = Color(hex: 0x94A3B8)
    static let error = Color(hex: 0xC93A3F)
    static let invalid = Color(hex: 0xE5484D)
}

/// "EMAIL", "PASSWORD": tracked caps over a field, with an optional trailing link.
struct LoginFieldLabel<Trailing: View>: View {
    let text: String
    let f: CGFloat
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text)
                .font(KioskType.sans(16 * f, .semibold))
                .tracking(0.3 * 16 * f)
                .foregroundStyle(LoginFormColors.label)
            Spacer(minLength: 8)
            trailing()
        }
    }
}

extension LoginFieldLabel where Trailing == EmptyView {
    init(text: String, f: CGFloat) {
        self.init(text: text, f: f) { EmptyView() }
    }
}

/// A 60-unit field: white, slate border, 8 pt corners; red outline when invalid.
/// With `reveal` it is a password field with the eye toggle.
struct LoginTextField: View {
    let placeholder: String
    @Binding var text: String
    var reveal: Binding<Bool>? = nil
    var invalid = false
    let f: CGFloat
    var focus: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if let reveal, !reveal.wrappedValue {
                    SecureField(placeholder, text: $text,
                                prompt: Text(placeholder).foregroundColor(LoginFormColors.placeholder))
                } else {
                    TextField(placeholder, text: $text,
                              prompt: Text(placeholder).foregroundColor(LoginFormColors.placeholder))
                }
            }
            .font(KioskType.sans(23 * f))
            .foregroundStyle(LoginTokens.ink)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused(focus)
            .frame(maxHeight: .infinity)
            if let reveal {
                Button { reveal.wrappedValue.toggle() } label: {
                    VectorIconView(icon: reveal.wrappedValue ? LoginIcons.eyeOff : LoginIcons.eye,
                                   tint: reveal.wrappedValue ? LoginTokens.orange : LoginFormColors.label,
                                   size: 28 * f)
                        .frame(width: 48, height: 48)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(reveal.wrappedValue ? "Hide password" : "Show password")
                .padding(.trailing, -6)
            }
        }
        .padding(.horizontal, 20 * f)
        .frame(height: 60 * f)
        .background(LoginTokens.field, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .stroke(invalid ? LoginFormColors.invalid : LoginTokens.line, lineWidth: invalid ? 1.5 : 1))
        .shadow(color: invalid ? LoginFormColors.invalid.opacity(0.13) : .clear, radius: 4)
    }
}

/// The navy "Sign in →" button (60+ pt), "Signing in…" while busy.
struct LoginSubmitButton: View {
    let busy: Bool
    let f: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14 * f) {
                Text(busy ? "Signing in…" : "Sign in")
                    .font(KioskType.sans(28 * f, .semibold))
                    .foregroundStyle(.white)
                if busy {
                    ProgressView().tint(.white)
                } else {
                    VectorIconView(icon: LoginIcons.arrow, tint: LoginTokens.orange, size: 34 * f)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 67 * f)
            .background(LoginTokens.ink, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

/// An underlined ink text action ("Forgot password?", "Contact support").
struct LoginUnderlinedLink: View {
    let title: String
    let size: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(KioskType.sans(size, .medium))
                .underline()
                .foregroundStyle(LoginTokens.ink)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A quiet slate text action (the kiosk's extra sign-in ways, Back).
struct LoginQuietLink: View {
    let title: String
    let f: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(KioskType.sans(16 * f, .medium))
                .foregroundStyle(LoginTokens.slate)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The inline error line under the fields.
struct LoginErrorText: View {
    let text: String?
    let f: CGFloat

    var body: some View {
        if let text {
            Text(text)
                .font(KioskType.sans(15 * f))
                .foregroundStyle(LoginFormColors.error)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

/// Read-only mode and broadcast banners from `/system/status` (the web kiosk's KioskBanners).
private struct LoginBanners: View {
    let status: SystemStatus?
    let f: CGFloat

    var body: some View {
        if let status {
            if status.readOnly {
                banner(status.readOnlyMessage.isEmpty ? "Read-only maintenance mode" : "Read-only maintenance mode — \(status.readOnlyMessage)",
                       text: Color(hex: 0x7A4B00), bg: Color(hex: 0xFFF4E0), border: Color(hex: 0xF2C880))
            }
            if let text = status.banner, !text.isEmpty {
                banner(text, text: Color(hex: 0x1668A7), bg: Color(hex: 0xE8F1FB), border: Color(hex: 0xB9D4EE))
            }
        }
    }

    private func banner(_ message: String, text: Color, bg: Color, border: Color) -> some View {
        Text(message)
            .font(KioskType.sans(14 * f, .medium))
            .foregroundStyle(text)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .padding(.horizontal, 14)
            .background(bg, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(border, lineWidth: 1))
            .padding(.bottom, 14 * f)
    }
}

/// The sign-in column: banners, eyebrow, title, subtitle, then the body for the
/// current view (email & password, pair with phone, move password).
struct LoginForm: View {
    @Bindable var vm: LoginViewModel
    let f: CGFloat
    let makePair: () -> PairViewModel
    @FocusState private var emailFocused: Bool
    @FocusState private var passwordFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LoginBanners(status: vm.status, f: f)
            eyebrow
            Text("Sign in")
                .font(KioskType.sans(62 * f, .heavy))
                .tracking(-0.025 * 62 * f)
                .foregroundStyle(LoginTokens.ink)
                .padding(.top, 6 * f)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle)
                .font(KioskType.sans(24 * f))
                .lineSpacing(5 * f)
                .foregroundStyle(LoginTokens.slate)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8 * f)
                .padding(.trailing, 90 * f)
            switch vm.view {
            case .password: passwordBody.padding(.top, 30 * f)
            case .pair: pairBody.padding(.top, 28 * f)
            case .move: MovePasswordForm(vm: vm, f: f, onBack: back).padding(.top, 40 * f)
            }
        }
    }

    private var subtitle: String {
        switch vm.view {
        case .password: "Use your account to access your migration workspace."
        case .pair: "Link this kiosk with your phone."
        case .move: "Sign in with a move password."
        }
    }

    private var eyebrow: some View {
        HStack(spacing: 14 * f) {
            Text("SERVERSHERPA PORTAL")
                .font(KioskType.sans(16 * f, .bold))
                .tracking(0.3 * 16 * f)
                .foregroundStyle(LoginTokens.orange)
                .fixedSize()
            Rectangle().fill(LoginTokens.orange).frame(height: 1.5)
        }
    }

    private var passwordBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            LoginFieldLabel(text: "EMAIL", f: f)
            LoginTextField(placeholder: "you@company.com", text: $vm.email, invalid: vm.emailInvalid, f: f,
                           focus: $emailFocused)
                .keyboardType(.emailAddress)
                .textContentType(.username)
                .submitLabel(.next)
                .onSubmit { passwordFocused = true }
                .padding(.top, 10 * f)
            LoginFieldLabel(text: "PASSWORD", f: f) {
                LoginUnderlinedLink(title: "Forgot password?", size: 20 * f) { vm.supportOpen = true }
            }
            .padding(.top, 20 * f)
            .frame(height: 44 + 10 * f, alignment: .bottom)
            LoginTextField(placeholder: "••••••••••••", text: $vm.password, reveal: $vm.showPassword,
                           invalid: vm.passwordInvalid, f: f, focus: $passwordFocused)
                .textContentType(.password)
                .submitLabel(.go)
                .onSubmit(submit)
                .padding(.top, 2 * f)
            LoginErrorText(text: vm.error, f: f).padding(.top, 12 * f)
            LoginSubmitButton(busy: vm.busy, f: f, action: submit)
                .padding(.top, 24 * f)
            orDivider.padding(.vertical, 16 * f)
            ssoButton
            if vm.ssoHint {
                Text("Company SSO isn't enabled yet — sign in with your email and password.")
                    .font(KioskType.sans(15 * f, .light))
                    .foregroundStyle(LoginTokens.slate)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10 * f)
            }
            HStack(spacing: 6 * f) {
                Text("Need help?")
                    .font(KioskType.sans(20 * f))
                    .foregroundStyle(LoginFormColors.label)
                LoginUnderlinedLink(title: "Contact support", size: 20 * f) { vm.supportOpen = true }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 8 * f)
            HStack(spacing: 10 * f) {
                LoginQuietLink(title: "Pair with phone", f: f) { vm.view = .pair }
                Text("·").foregroundStyle(LoginTokens.line)
                LoginQuietLink(title: "Use a move password", f: f) { vm.view = .move }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var pairBody: some View {
        VStack(spacing: 8 * f) {
            PairPanel(makeModel: makePair, f: f)
            LoginQuietLink(title: "Back to email & password", f: f, action: back)
        }
        .frame(maxWidth: .infinity)
    }

    private var orDivider: some View {
        HStack(spacing: 16 * f) {
            Rectangle().fill(LoginTokens.line).frame(height: 1)
            Text("OR")
                .font(KioskType.sans(16 * f, .semibold))
                .tracking(0.3 * 16 * f)
                .foregroundStyle(LoginFormColors.label)
                .fixedSize()
            Rectangle().fill(LoginTokens.line).frame(height: 1)
        }
    }

    private var ssoButton: some View {
        Button { vm.ssoHint = true } label: {
            HStack(spacing: 12 * f) {
                VectorIconView(icon: LoginIcons.link, tint: LoginTokens.orange, size: 34 * f)
                Text("Continue with SSO")
                    .font(KioskType.sans(24 * f, .medium))
                    .foregroundStyle(LoginTokens.ink)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 62 * f)
            .background(Color.white.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(LoginTokens.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func submit() {
        Task { await vm.submit() }
    }

    private func back() { vm.view = .password }
}
