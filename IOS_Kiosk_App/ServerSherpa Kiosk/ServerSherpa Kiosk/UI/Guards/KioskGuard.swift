import SwiftUI

/// What KioskGuard shows for an auth state. `stationResting` is a signed-out Time Clock
/// station's Welcome (StationWelcomeHost), full screen, outside the shell.
enum GuardScreen: Equatable { case spinner, stationResting, login, mustChangePassword, content }

/// `stationResting`: `stationRests(selection:loginRequested:)`, a Time Clock station whose
/// Welcome gear has not asked for sign-in.
func guardScreen(for state: AuthState, stationResting: Bool = false) -> GuardScreen {
    switch state {
    case .loading: .spinner
    case .anon: stationResting ? .stationResting : .login
    case .authed(let s): s.mustChangePassword ? .mustChangePassword : .content
    }
}

func mustChangePasswordText(portalUrl: String) -> String {
    "Your password needs to be changed before you can use a kiosk. Sign in to the portal at \(portalUrl) to change it."
}

/// The kiosk's ProtectedRoute: loading → spinner, anon → login (a Time Clock station's Welcome
/// instead, until its gear asks for sign-in), must-change-password → notice.
struct KioskGuard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(KioskAuth.self) private var auth
    @Environment(KioskPrefs.self) private var prefs
    @Environment(TimeclockStation.self) private var station

    var body: some View {
        let resting = stationRests(selection: prefs.setupSelection, loginRequested: station.loginRequested)
        switch guardScreen(for: auth.state, stationResting: resting) {
        case .spinner: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .stationResting: StationWelcomeHost()
        case .login: LoginScreen()
        case .mustChangePassword: MustChangePasswordNotice()
        case .content: content()
        }
    }
}

struct MustChangePasswordNotice: View {
    @Environment(KioskAuth.self) private var auth
    @Environment(KioskConfig.self) private var config
    @Environment(\.kioskPalette) private var palette
    @State private var signingOut = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(eyebrow: "Kiosk", title: "Password change required")
            Text(mustChangePasswordText(portalUrl: config.portalUrl))
                .font(KioskType.bodyLarge).foregroundStyle(palette.text)
                .padding(.bottom, 16)
            SecondaryButton("Sign out", enabled: !signingOut) {
                signingOut = true
                Task { await auth.logout(); signingOut = false }
            }
            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(palette.paper2)
    }
}
