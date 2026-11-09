import Foundation
import LocalAuthentication

/// A prompt that can't be shown: Face ID / Touch ID is locked out (too many failed tries), or
/// unavailable (no sensor, or nothing enrolled any more).
enum BiometricPromptProblem: Error, Equatable, Sendable {
    case lockedOut, unavailable
}

protocol BiometricPrompter: Sendable {
    /// Shows the Face ID / Touch ID prompt. Returns the authenticated context, nil on a cancel or
    /// fallback, and throws a `BiometricPromptProblem` when the prompt can't be used.
    func authenticate(reason: String) async throws -> BiometricAuth?
}

/// What an `LAError` from the prompt means; nil is a cancel (the person backed out, the app or
/// the system closed the prompt, or the face or finger didn't match).
func biometricPromptProblem(for code: LAError.Code) -> BiometricPromptProblem? {
    switch code {
    case .biometryLockout: return .lockedOut
    case .biometryNotAvailable, .biometryNotEnrolled: return .unavailable
    default: return nil
    }
}

/// The system Face ID / Touch ID prompt, biometrics only: no passcode fallback button.
struct SystemBiometricPrompter: BiometricPrompter {
    func authenticate(reason: String) async throws -> BiometricAuth? {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        do {
            try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            return BiometricAuth(context: context)
        } catch let error as LAError {
            if let problem = biometricPromptProblem(for: error.code) { throw problem }
            return nil
        }
    }
}
