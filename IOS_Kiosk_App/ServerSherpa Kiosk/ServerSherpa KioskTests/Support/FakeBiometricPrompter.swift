import Foundation
import LocalAuthentication
@testable import ServerSherpa_Kiosk

/// A Face ID / Touch ID prompt whose answer is set per test. `answer` nil plays a cancel or
/// fallback; `error` plays a prompt that throws (a lockout, say). `gate`, when set, holds the
/// prompt open: `authenticate` records the reason first, then awaits it.
final class FakeBiometricPrompter: BiometricPrompter, @unchecked Sendable {
    private let lock = NSLock()
    private var _answer: BiometricAuth? = BiometricAuth(context: LAContext())
    private var _error: Error?
    private var _gate: (@Sendable () async -> Void)?
    private var _reasons: [String] = []

    var answer: BiometricAuth? {
        get { lock.withLock { _answer } }
        set { lock.withLock { _answer = newValue } }
    }
    var error: Error? {
        get { lock.withLock { _error } }
        set { lock.withLock { _error = newValue } }
    }
    var gate: (@Sendable () async -> Void)? {
        get { lock.withLock { _gate } }
        set { lock.withLock { _gate = newValue } }
    }
    /// The reason of every prompt shown, in order.
    var reasons: [String] { lock.withLock { _reasons } }

    func authenticate(reason: String) async throws -> BiometricAuth? {
        let gate = lock.withLock { () -> (@Sendable () async -> Void)? in
            _reasons.append(reason)
            return _gate
        }
        await gate?()
        if let error { throw error }
        return answer
    }
}
