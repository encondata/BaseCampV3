import SwiftUI
import UIKit

/// The SF Symbol for the device's biometric on the card's button; nil (the button's arrow) when
/// the device names none.
func biometricSymbol(_ kind: BiometryKind?) -> String? {
    switch kind {
    case .faceID: "faceid"
    case .touchID: "touchid"
    case nil: nil
    }
}

/// The "Sign in as …" card (Android `BiometricCardView`): the person's photo (initials until it
/// lands, or when there is none), the button that brings the prompt back, the line from the last
/// try, then Use password and Other account (the empty password form, for someone else).
struct BiometricCardView: View {
    let vm: LoginViewModel
    let card: BiometricCard
    let words: BiometricWords
    let kind: BiometryKind?
    let f: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            LoginAvatar(photoUrl: card.photoUrl, name: card.displayName)
                .padding(.bottom, 24 * f)
            // The button says what the prompt will.
            LoginSubmitButton(busy: vm.bioBusy, f: f, title: BiometricCopy.signInReason(words, name: card.displayName),
                              systemImage: biometricSymbol(kind)) {
                Task { await vm.signInWithBiometric(SystemBiometricPrompter()) }
            }
            .accessibilityIdentifier("login-bio-sign-in")
            LoginErrorText(text: vm.bioError, f: f).padding(.top, 12 * f)
            // Not while a sign-in runs: its answer would land over the form chosen.
            HStack(spacing: 10 * f) {
                LoginQuietLink(title: "Use password", f: f, enabled: !vm.bioBusy) { vm.usePassword() }
                    .accessibilityIdentifier("login-bio-password")
                Text("·").foregroundStyle(LoginTokens.line).accessibilityHidden(true)
                LoginQuietLink(title: "Other account", f: f, enabled: !vm.bioBusy) { vm.otherAccount() }
                    .accessibilityIdentifier("login-bio-other")
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 16 * f)
        }
        .frame(maxWidth: .infinity)
    }
}

/// The card on its way: the avatar's empty circle, "Checking…", and Use password for anyone who
/// won't wait (at most `LoginViewModel.cardPendingMax`).
struct BiometricPendingView: View {
    let vm: LoginViewModel
    let f: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            Circle()
                .fill(LoginTokens.line)
                .frame(width: LoginAvatar.size, height: LoginAvatar.size)
                .overlay(Circle().stroke(Color.white, lineWidth: 3))
                .accessibilityHidden(true)
                .padding(.bottom, 16 * f)
            Text("Checking…")
                .font(KioskType.sans(18 * f))
                .foregroundStyle(LoginTokens.slate)
                .accessibilityIdentifier("login-bio-pending")
                .padding(.bottom, 16 * f)
            LoginQuietLink(title: "Use password", f: f) { vm.usePassword() }
                .accessibilityIdentifier("login-bio-password")
        }
        .frame(maxWidth: .infinity)
    }
}

/// The card's round photo, or the initials on ink while it loads or when there is none. The
/// photo link is presigned and unauthenticated; it is fetched and shrunk off the main actor and
/// not cached (a new card brings a fresh link).
struct LoginAvatar: View {
    static let size: CGFloat = 88

    let photoUrl: String?
    let name: String
    @Environment(\.container) private var container
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                LoginTokens.ink
                Text(initialsOf(name))
                    .font(KioskType.sans(30, .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: Self.size, height: Self.size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white, lineWidth: 3))
        .accessibilityHidden(true)
        .task(id: photoUrl) { await load() }
    }

    private func load() async {
        image = nil
        guard let url = photoUrl, !url.isEmpty else { return }
        let api = container.api
        let photo = await Self.photo(url: url, fetch: { try await api.fetchImage(url: $0) })
        guard !Task.isCancelled else { return }
        image = photo
    }

    /// Nil on any failure (no connection, an expired link, not an image): the initials stay.
    @concurrent nonisolated static func photo(url: String, fetch: @Sendable (String) async throws -> Data) async -> UIImage? {
        guard let data = try? await fetch(url) else { return nil }
        return RolodexAvatar.downsample(data, maxPixels: 256)
    }
}
