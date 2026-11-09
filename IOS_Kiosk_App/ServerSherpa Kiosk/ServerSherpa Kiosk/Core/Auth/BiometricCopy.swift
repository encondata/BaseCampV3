import Foundation

/// Biometric sign-in's copy: the spec's "Copy (iOS)" table, with `<Bio>` and `<device>` from
/// `w`. Rows that don't name either still take `w`, so every caller reads the same way.
enum BiometricCopy {
    static func unsupported(_ w: BiometricWords) -> String { "This \(w.device) can't use \(w.bio) sign-in." }
    static func expired(_ w: BiometricWords) -> String { "Sign in with your password to keep using \(w.bio)." }
    static func passwordChange(_ w: BiometricWords) -> String { "Your password needs changing in the portal." }
    static func rateLimited(_ w: BiometricWords) -> String { "Too many sign-in tries. Wait a few minutes, then try again." }
    static func removed(_ w: BiometricWords) -> String { "\(w.bio) sign-in is off for this \(w.device). Sign in with your password." }
    static func kioskNotAllowed(_ w: BiometricWords) -> String {
        "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access."
    }
    static func accountDisabled(_ w: BiometricWords) -> String { "This account is disabled. Contact your coordinator." }
    static func network(_ w: BiometricWords) -> String { "Can't reach the server. Check the kiosk's network connection." }
    static func tryAgain(_ w: BiometricWords) -> String { "\(w.bio) sign-in didn't go through. Try again, or use your password." }
    static func enrollWindow(_ w: BiometricWords) -> String { "Sign in with your password again to turn on \(w.bio) sign-in." }
    static func enrollFailed(_ w: BiometricWords) -> String { "Couldn't turn on \(w.bio) sign-in. Try again later." }
    static func enrollRetry(_ w: BiometricWords) -> String { "Turning on \(w.bio) sign-in took too long. Tap Turn on to try again." }
    static func somethingWrong(_ w: BiometricWords) -> String { "Something went wrong. Try again, or use your password." }

    // The prompt's problems, on the card and on the Turn on sheet.
    static func lockoutCard(_ w: BiometricWords) -> String { "Too many tries. Use your password, or try again later." }
    static func unavailableCard(_ w: BiometricWords) -> String { "\(w.bio) isn't available right now. Use your password." }
    static func lockoutSheet(_ w: BiometricWords) -> String { "Too many tries. Try again later." }
    static func unavailableSheet(_ w: BiometricWords) -> String { "\(w.bio) isn't available right now. Try again later." }

    // The system prompt's reason line.
    static func signInReason(_ w: BiometricWords, name: String) -> String { "Sign in as \(name)" }
    static func signInReasonFallback(_ w: BiometricWords) -> String { "Sign in to ServerSherpa" }
    static func enrollReason(_ w: BiometricWords) -> String { "Turn on \(w.bio) sign-in" }

    // Settings › This Kiosk.
    static func rowTitle(_ w: BiometricWords) -> String { "Biometric sign-in" }
    static func rowDetail(_ w: BiometricWords) -> String { "Sign in with Face ID or Touch ID on an iPad or iPhone assigned to you." }
    static func rowOn(_ w: BiometricWords) -> String { "\(w.bio) sign-in: On ·" }
    static func rowForget(_ w: BiometricWords) -> String { "Forget this device" }
    static func rowOff(_ w: BiometricWords) -> String {
        "Off. After a password sign-in on an iPad or iPhone assigned to you, the app offers to turn it on."
    }
    static func rowNotYours(_ w: BiometricWords) -> String {
        "On for another person. Only they can forget it here, or an admin in the portal."
    }
    static func forgotten(_ w: BiometricWords) -> String { "This \(w.device) forgot \(w.bio) sign-in." }
    static func forgottenHereOnly(_ w: BiometricWords) -> String {
        "This \(w.device) forgot \(w.bio) sign-in, but the portal couldn't be reached. An admin can remove it there."
    }
    static func forgetFailed(_ w: BiometricWords) -> String { "Couldn't forget \(w.bio) sign-in on this \(w.device). Try again." }

    // The Turn on sheet after a password sign-in.
    static func offerOverline(_ w: BiometricWords) -> String { "SIGN-IN" }
    static func offerTitle(_ w: BiometricWords) -> String { "\(w.bio) sign-in" }
    static func offerBody(_ w: BiometricWords) -> String {
        "Use \(w.bio) to sign in on this \(w.device)? You'll sign in with your password again every 30 days."
    }
}
