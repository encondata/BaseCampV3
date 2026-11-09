import Foundation

/// The words the biometric sign-in copy uses for this device: its biometric ("Face ID" or
/// "Touch ID") and what it is ("iPad" or "iPhone").
struct BiometricWords: Equatable, Sendable {
    let bio: String
    let device: String
}
