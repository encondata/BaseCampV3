import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// The spec's "Copy (iOS)" table, verbatim, with `<Bio>` and `<device>` filled in.
struct BiometricCopyTests {
    @Test func faceIDOnIPadCopy() {
        let w = BiometricWords(bio: "Face ID", device: "iPad")
        #expect(BiometricCopy.unsupported(w) == "This iPad can't use Face ID sign-in.")
        #expect(BiometricCopy.expired(w) == "Sign in with your password to keep using Face ID.")
        #expect(BiometricCopy.passwordChange(w) == "Your password needs changing in the portal.")
        #expect(BiometricCopy.rateLimited(w) == "Too many sign-in tries. Wait a few minutes, then try again.")
        #expect(BiometricCopy.removed(w) == "Face ID sign-in is off for this iPad. Sign in with your password.")
        #expect(BiometricCopy.kioskNotAllowed(w) == "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.")
        #expect(BiometricCopy.accountDisabled(w) == "This account is disabled. Contact your coordinator.")
        #expect(BiometricCopy.network(w) == "Can't reach the server. Check the kiosk's network connection.")
        #expect(BiometricCopy.tryAgain(w) == "Face ID sign-in didn't go through. Try again, or use your password.")
        #expect(BiometricCopy.enrollWindow(w) == "Sign in with your password again to turn on Face ID sign-in.")
        #expect(BiometricCopy.enrollFailed(w) == "Couldn't turn on Face ID sign-in. Try again later.")
        #expect(BiometricCopy.enrollRetry(w) == "Turning on Face ID sign-in took too long. Tap Turn on to try again.")
        #expect(BiometricCopy.somethingWrong(w) == "Something went wrong. Try again, or use your password.")
        #expect(BiometricCopy.lockoutCard(w) == "Too many tries. Use your password, or try again later.")
        #expect(BiometricCopy.unavailableCard(w) == "Face ID isn't available right now. Use your password.")
        #expect(BiometricCopy.lockoutSheet(w) == "Too many tries. Try again later.")
        #expect(BiometricCopy.unavailableSheet(w) == "Face ID isn't available right now. Try again later.")
        #expect(BiometricCopy.signInReason(w, name: "Ada Lovelace") == "Sign in as Ada Lovelace")
        #expect(BiometricCopy.signInReasonFallback(w) == "Sign in to ServerSherpa")
        #expect(BiometricCopy.enrollReason(w) == "Turn on Face ID sign-in")
        #expect(BiometricCopy.rowTitle(w) == "Biometric sign-in")
        #expect(BiometricCopy.rowDetail(w) == "Sign in with Face ID or Touch ID on an iPad or iPhone assigned to you.")
        #expect(BiometricCopy.rowOn(w) == "Face ID sign-in: On ·")
        #expect(BiometricCopy.rowForget(w) == "Forget this device")
        #expect(BiometricCopy.rowOff(w) == "Off. After a password sign-in on an iPad or iPhone assigned to you, the app offers to turn it on.")
        #expect(BiometricCopy.rowNotYours(w) == "On for another person. Only they can forget it here, or an admin in the portal.")
        #expect(BiometricCopy.forgotten(w) == "This iPad forgot Face ID sign-in.")
        #expect(BiometricCopy.forgottenHereOnly(w) == "This iPad forgot Face ID sign-in, but the portal couldn't be reached. An admin can remove it there.")
        #expect(BiometricCopy.forgetFailed(w) == "Couldn't forget Face ID sign-in on this iPad. Try again.")
        #expect(BiometricCopy.offerOverline(w) == "SIGN-IN")
        #expect(BiometricCopy.offerTitle(w) == "Face ID sign-in")
        #expect(BiometricCopy.offerBody(w) == "Use Face ID to sign in on this iPad? You'll sign in with your password again every 30 days.")
    }

    @Test func touchIDOnIPhoneCopy() {
        let w = BiometricWords(bio: "Touch ID", device: "iPhone")
        #expect(BiometricCopy.unsupported(w) == "This iPhone can't use Touch ID sign-in.")
        #expect(BiometricCopy.removed(w) == "Touch ID sign-in is off for this iPhone. Sign in with your password.")
        #expect(BiometricCopy.forgotten(w) == "This iPhone forgot Touch ID sign-in.")
    }
}
