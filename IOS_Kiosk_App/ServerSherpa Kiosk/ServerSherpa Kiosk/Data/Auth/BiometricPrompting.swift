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

/// The system Face ID / Touch ID prompt, biometrics only: no passcode fallback button. A canceled
/// task (Turn on stopped by a sign-out, the sign-in screen gone) takes the prompt down with it:
/// the context is invalidated, and the prompt answers as a cancel.
struct SystemBiometricPrompter: BiometricPrompter {
    func authenticate(reason: String) async throws -> BiometricAuth? {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        let auth = BiometricAuth(context: context)
        do {
            try await withTaskCancellationHandler {
                try await auth.context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            } onCancel: {
                auth.context.invalidate()
            }
            return auth
        } catch let error as LAError {
            if let problem = biometricPromptProblem(for: error.code) { throw problem }
            return nil
        }
    }
}

/// `prompter` with a `BiometricPromptProblem` turned into a cancel (nil), after `onProblem` hears
/// which one (Android `problemAware`): the rules see a cancel, and the screen shows the problem's
/// line (`BiometricCopy.lockoutCard`, `unavailableSheet`, …) instead of staying silent. Any other
/// error still throws.
func problemAware(_ prompter: BiometricPrompter,
                  onProblem: @escaping @Sendable (BiometricPromptProblem) -> Void) -> BiometricPrompter {
    ProblemAwarePrompter(base: prompter, onProblem: onProblem)
}

private struct ProblemAwarePrompter: BiometricPrompter {
    let base: BiometricPrompter
    let onProblem: @Sendable (BiometricPromptProblem) -> Void

    func authenticate(reason: String) async throws -> BiometricAuth? {
        do {
            return try await base.authenticate(reason: reason)
        } catch let problem as BiometricPromptProblem {
            onProblem(problem)
            return nil
        }
    }
}

/// The last problem a `problemAware` prompter turned into a cancel, for the line under the card or
/// on the Turn on sheet.
final class BiometricPromptProblems: @unchecked Sendable {
    private let lock = NSLock()
    private var _last: BiometricPromptProblem?

    var last: BiometricPromptProblem? { lock.withLock { _last } }

    func record(_ problem: BiometricPromptProblem) { lock.withLock { _last = problem } }
}
