import SwiftUI

/// What Settings › This Kiosk's biometric row shows.
enum BiometricRowState: Equatable {
    /// No enrollment on this device.
    case off
    /// Someone else is signed in over another person's enrollment: nothing to forget for them.
    case notYours
    /// The enrolled person is signed in, or nobody is: "On · Forget this device".
    case on
}

/// The row's state (Android `FingerprintRow`): Forget is offered to the enrollment's own person,
/// and to anyone signed out (the device forgets it; the portal's key is useless without it).
func biometricRowState(enrollment: BiometricEnrollment?, signedInPersonId: String?) -> BiometricRowState {
    guard let enrollment else { return .off }
    if let signedInPersonId, signedInPersonId != enrollment.personId { return .notYours }
    return .on
}

/// What Forget says after it ran: the server reached (signed in) or not, and whether this device
/// still holds an enrollment after it.
func biometricForgetMessage(serverReached: Bool, stillEnrolled: Bool, _ w: BiometricWords) -> String {
    if stillEnrolled { return BiometricCopy.forgetFailed(w) }
    return serverReached ? BiometricCopy.forgotten(w) : BiometricCopy.forgottenHereOnly(w)
}

/// Settings › This Kiosk › Biometric sign-in: off, on for another person, or
/// "<Bio> sign-in: On · Forget this device". It works signed out, where Forget drops the key on
/// the device only.
struct BiometricRow: View {
    @Environment(BiometricSignIn.self) private var biometric
    @Environment(KioskAuth.self) private var auth
    @Environment(\.kioskPalette) private var palette
    @State private var busy = false
    @State private var done: String?

    private var signedInPersonId: String? {
        if case .authed(let session) = auth.state { return session.person.id }
        return nil
    }

    var body: some View {
        let w = biometric.words
        SettingsRow(title: BiometricCopy.rowTitle(w), detail: BiometricCopy.rowDetail(w)) {
            switch biometricRowState(enrollment: biometric.enrollment, signedInPersonId: signedInPersonId) {
            case .off:
                line(BiometricCopy.rowOff(w))
            case .notYours:
                line(BiometricCopy.rowNotYours(w))
            case .on:
                HStack(spacing: 6) {
                    line(BiometricCopy.rowOn(w))
                    LinkButton(BiometricCopy.rowForget(w)) { forget(w) }
                        .accessibilityIdentifier("biometric-forget")
                }
            }
            KioskToast(text: done)
        }
    }

    private func line(_ text: String) -> some View {
        Text(text).font(KioskType.bodyMedium).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
    }

    private func forget(_ w: BiometricWords) {
        guard !busy else { return }
        busy = true
        let signedIn = signedInPersonId != nil
        Task {
            let reached = await biometric.forget(signedIn: signedIn)
            done = biometricForgetMessage(serverReached: reached, stillEnrolled: biometric.enrollment != nil, w)
            busy = false
        }
    }
}
