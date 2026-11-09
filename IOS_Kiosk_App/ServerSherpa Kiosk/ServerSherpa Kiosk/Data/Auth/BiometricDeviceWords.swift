import UIKit

/// The words for this device's biometric and the device itself. With no kind (no biometric is
/// ready), a device with no Home button is taken to have Face ID, any other to have Touch ID.
@MainActor func currentBiometricWords(_ kind: BiometryKind?) -> BiometricWords {
    let idiom = UIDevice.current.userInterfaceIdiom
    let bio: String
    switch kind {
    case .faceID: bio = "Face ID"
    case .touchID: bio = "Touch ID"
    case nil: bio = hasNoHomeButton(idiom) ? "Face ID" : "Touch ID"
    }
    return BiometricWords(bio: bio, device: idiom == .pad ? "iPad" : "iPhone")
}

/// A phone or iPad whose key window keeps a bottom inset for the home indicator has no Home button.
@MainActor private func hasNoHomeButton(_ idiom: UIUserInterfaceIdiom) -> Bool {
    guard idiom == .phone || idiom == .pad else { return false }
    let window = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .first(where: \.isKeyWindow)
    return (window?.safeAreaInsets.bottom ?? 0) > 0
}
