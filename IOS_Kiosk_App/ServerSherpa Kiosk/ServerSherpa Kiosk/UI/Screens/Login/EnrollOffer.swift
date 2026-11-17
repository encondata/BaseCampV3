import Observation
import SwiftUI

/// The Turn on sheet while it shows: `busy` while Turn on runs, `message` after one that didn't work.
struct EnrollOfferUI: Equatable {
    var busy = false
    var message: String?
}

extension EnrollOfferUI: Identifiable {
    /// One sheet: a new state updates the open sheet rather than presenting another.
    var id: Int { 0 }
}

/// The Turn on offer after a password sign-in (Android `EnrollOffer`). It lives in the app
/// (`AppContainer`), not the sign-in screen: the screen is gone by the time the server answers,
/// and the sign-in never waits for it. `sheet` is non-nil while the sheet should show. The offer
/// only lands while the same person is still signed in; signing out (or the session ending)
/// closes it and stops a running Turn on. `BiometricSignIn` decides who is offered: never a move
/// password, a pair, a shared station or a restored session.
@MainActor @Observable
final class EnrollOffer {
    @ObservationIgnored private let biometric: BiometricSignIn
    @ObservationIgnored private let auth: KioskAuth

    private(set) var sheet: EnrollOfferUI?
    /// The person the offer being decided or shown is for; nil once it closes.
    @ObservationIgnored private var owner: String?
    /// The latest offer being decided (tests wait on it; a close forgets it, so capture it first).
    @ObservationIgnored private(set) var deciding: Task<Void, Never>?
    @ObservationIgnored private var turningOn: Task<Void, Never>?

    init(biometric: BiometricSignIn, auth: KioskAuth) {
        self.biometric = biometric
        self.auth = auth
        follow()
    }

    #if DEBUG
    /// The sample sheet's words (`showSampleForUITest()`); nil for every real offer.
    @ObservationIgnored private var sampleWords: BiometricWords?
    #endif

    /// The sheet's biometric and device words.
    var words: BiometricWords {
        #if DEBUG
        if let sampleWords { return sampleWords }
        #endif
        return biometric.words
    }

    #if DEBUG
    /// Debug builds only (`-uiTestEnrollOffer`): the real sheet with sample words, so its layout
    /// can be checked on the Simulator, which has no Secure Enclave and never reaches a real offer.
    /// It asks nothing: no key, no system prompt, no server. Its Turn on only shows the line a
    /// Turn on that didn't work shows (the sheet's taller state); Not now and a swipe down close it.
    func showSampleForUITest() {
        close()
        sampleWords = BiometricWords(bio: "Face ID", device: "iPad")
        sheet = EnrollOfferUI()
    }
    #endif

    /// After a person's password sign-in: asks in the background, shows the sheet on a yes.
    func afterPasswordSignIn() {
        guard let person = signedIn() else { return }
        deciding?.cancel()
        owner = person
        deciding = Task { [weak self] in
            guard let self, await self.biometric.offerEnroll(), !Task.isCancelled else { return }
            self.show(person, EnrollOfferUI(), replaceOnly: false)
        }
    }

    /// Not now: nothing is stored, so the next password sign-in asks again.
    func notNow() { close() }

    /// Turn on: the system prompt once, then the key to the server. The sheet closes when it's on,
    /// and stays up with a line otherwise. Returns when Turn on has ended (or was stopped).
    func turnOn(_ p: BiometricPrompter) async {
        #if DEBUG
        if let sampleWords {
            sheet = EnrollOfferUI(message: BiometricCopy.enrollFailed(sampleWords))
            return
        }
        #endif
        guard let person = signedIn(), person == owner else {
            close()
            return
        }
        guard let now = sheet, !now.busy else { return }
        sheet = EnrollOfferUI(busy: true)
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runTurnOn(person, p)
        }
        turningOn = task
        await task.value
    }

    /// Closes the sheet and stops the offer being decided and a running Turn on: Not now, a
    /// sign-out, a session that ends. The container's sign-out hooks call it before the state flips.
    func close() {
        deciding?.cancel()
        deciding = nil
        turningOn?.cancel()
        turningOn = nil
        owner = nil
        sheet = nil
        #if DEBUG
        sampleWords = nil
        #endif
    }

    private func runTurnOn(_ person: String, _ p: BiometricPrompter) async {
        let problems = BiometricPromptProblems()
        let outcome = await biometric.enroll(problemAware(p) { problems.record($0) })
        // Closed while it ran (signed out): BiometricSignIn stored nothing, and the sheet stays closed.
        if Task.isCancelled { return }
        turningOn = nil
        let w = biometric.words
        switch outcome {
        case .enrolled:
            owner = nil
            sheet = nil
        case .canceled:
            show(person, EnrollOfferUI(message: Self.sheetLine(problems.last, w)), replaceOnly: true)
        case .unsupported:
            show(person, EnrollOfferUI(message: BiometricCopy.unsupported(w)), replaceOnly: true)
        case .failed(let message):
            show(person, EnrollOfferUI(message: message), replaceOnly: true)
        }
    }

    /// Shows `next` while `person` is still the one signed in and offered; `replaceOnly` replaces
    /// an open sheet only, so one a sign-out closed stays closed.
    private func show(_ person: String, _ next: EnrollOfferUI, replaceOnly: Bool) {
        guard owner == person, signedIn() == person else { return }
        if replaceOnly && sheet == nil { return }
        sheet = next
    }

    /// Who is signed in, if a person may be offered: not while the password must change first.
    private func signedIn() -> String? {
        guard case .authed(let session) = auth.state, !session.mustChangePassword else { return nil }
        return session.person.id
    }

    /// Follows who is signed in (Observation): anyone but the offer's person closes it. The
    /// container's sign-out hooks close it at once; this covers every other way the state changes.
    private func follow() {
        withObservationTracking { _ = signedIn() } onChange: { [weak self] in
            // onChange runs before the new state is set: read it on the next main-actor turn.
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let owner = self.owner, self.signedIn() != owner { self.close() }
                self.follow()
            }
        }
    }

    private static func sheetLine(_ problem: BiometricPromptProblem?, _ w: BiometricWords) -> String? {
        switch problem {
        case .lockedOut: BiometricCopy.lockoutSheet(w)
        case .unavailable: BiometricCopy.unavailableSheet(w)
        case nil: nil
        }
    }
}

/// "Use Face ID to sign in on this iPad?" with Turn on and Not now, over the signed-in app. It
/// follows the app's light or dark theme (its palette), with rounded corners. The sheet fits its
/// content, and the buttons are always on screen when it opens: only the text can scroll (very
/// large text, an iPhone in landscape), never the buttons (`PinnedActions`).
struct EnrollOfferSheet: View {
    let ui: EnrollOfferUI
    let words: BiometricWords
    let onTurnOn: () -> Void
    let onNotNow: () -> Void
    /// The presenter's width is compact (an iPhone, a narrow iPad window). Read by the presenter:
    /// inside a sheet the size class can differ from the window's.
    let compactWidth: Bool
    @Environment(\.kioskPalette) private var palette
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        PinnedActions(padding: 20) {
            // Overline, title and question.
            PageHeader(eyebrow: BiometricCopy.offerOverline(words), title: BiometricCopy.offerTitle(words),
                       subtitle: BiometricCopy.offerBody(words))
        } actions: {
            // The line from the last Turn on, then the two buttons.
            VStack(alignment: .leading, spacing: 0) {
                KioskToast(text: ui.message, error: true)
                HStack(spacing: 8) {
                    PrimaryButton(ui.busy ? "Turning on…" : "Turn on", enabled: !ui.busy, action: onTurnOn)
                        .accessibilityIdentifier("enroll-offer-turn-on")
                    SecondaryButton("Not now", enabled: !ui.busy, action: onNotNow)
                        .accessibilityIdentifier("enroll-offer-not-now")
                }
                .padding(.top, 8)
            }
        }
        // At the top of a sheet taller than it (a phone's half-height sheet).
        .frame(maxHeight: .infinity, alignment: .top)
        .background(palette.paper)
        // The UI test's handle on the sheet's frame (the buttons must lie inside it).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("enroll-offer-sheet")
        // Not while Turn on runs (Android's dialog ignores a dismiss then).
        .interactiveDismissDisabled(ui.busy)
        .presentationBackground(palette.paper)
        .presentationCornerRadius(16)
        // A phone's sheet stops at half height, or opens full height at the accessibility text
        // sizes, where half leaves the text hardly any room. Elsewhere the form sheet fits its
        // content: a medium detent there cuts the fitted sheet to about half of it (iPadOS 26),
        // which hid the buttons.
        .presentationDetents(compactWidth && !typeSize.isAccessibilitySize ? [.medium] : [.large])
        .presentationSizing(.form.fitted(horizontal: false, vertical: true))
    }
}
