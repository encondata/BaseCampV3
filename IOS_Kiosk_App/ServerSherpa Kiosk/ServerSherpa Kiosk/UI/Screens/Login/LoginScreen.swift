import SwiftUI

/// Temporary sign-in form so the app is usable before Task 13 replaces it with the mockup.
struct LoginScreen: View {
    @Environment(KioskAuth.self) private var auth
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Sign in").font(KioskType.sans(40, .heavy)).foregroundStyle(LoginTokens.ink)
            TextField("you@company.com", text: $email)
                .textContentType(.username).keyboardType(.emailAddress)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("Password", text: $password).textContentType(.password)
            if let error { Text(error).foregroundStyle(ChipTone.red.text) }
            Button(busy ? "Signing in…" : "Sign in") { Task { await submit() } }
                .buttonStyle(.borderedProminent).tint(LoginTokens.ink)
                .disabled(busy)
        }
        .textFieldStyle(.roundedBorder)
        .frame(maxWidth: 392)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LoginTokens.canvas.ignoresSafeArea())
    }

    private func submit() async {
        guard !email.isEmpty, !password.isEmpty else { error = "Please enter both email and password"; return }
        busy = true
        defer { busy = false }
        do {
            try await auth.login(email: email, password: password)
            error = nil
        } catch let e as ApiError where e.code == "invalid_credentials" {
            error = "Invalid email or password."
        } catch {
            self.error = "Login failed. Please try again."
        }
    }
}
