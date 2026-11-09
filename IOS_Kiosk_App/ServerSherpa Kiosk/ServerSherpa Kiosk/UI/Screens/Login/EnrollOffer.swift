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

    /// The sheet's biometric and device words.
    var words: BiometricWords { biometric.words }

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
/// follows the app's light or dark theme (its palette), with rounded corners.
struct EnrollOfferSheet: View {
    let ui: EnrollOfferUI
    let words: BiometricWords
    let onTurnOn: () -> Void
    let onNotNow: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ScrollView { content }
        .scrollBounceBehavior(.basedOnSize)
        .background(palette.paper)
        // Not while Turn on runs (Android's dialog ignores a dismiss then).
        .interactiveDismissDisabled(ui.busy)
        .presentationBackground(palette.paper)
        .presentationCornerRadius(16)
        .presentationDetents([.medium])
        .presentationSizing(.form.fitted(horizontal: false, vertical: true))
    }

    /// Overline, title and question, the line from the last Turn on, then the two buttons.
    var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(eyebrow: BiometricCopy.offerOverline(words), title: BiometricCopy.offerTitle(words),
                       subtitle: BiometricCopy.offerBody(words))
            KioskToast(text: ui.message, error: true)
            HStack(spacing: 8) {
                PrimaryButton(ui.busy ? "Turning on…" : "Turn on", enabled: !ui.busy, action: onTurnOn)
                    .accessibilityIdentifier("enroll-offer-turn-on")
                SecondaryButton("Not now", enabled: !ui.busy, action: onNotNow)
                    .accessibilityIdentifier("enroll-offer-not-now")
            }
            .padding(.top, 8)
        }
        .padding(20)
    }
}
