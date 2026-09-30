import SwiftUI

/// The signed-out screen: Jimmy's mockup (the portal's light login scene) with
/// the kiosk's form. Wide and medium screens float the form over the scene on
/// the right; compact screens stack logo, form and status line in one column.
struct LoginScreen: View {
    @Environment(\.container) private var container

    var body: some View {
        LoginScreenBody(container: container)
    }
}

/// The whole screen and its safe-area insets, measured without the keyboard
/// so the scene does not rescale when the keyboard comes up.
private struct ScreenFrame: Equatable {
    var size: CGSize
    var insets: EdgeInsets
}

private struct LoginScreenBody: View {
    let container: AppContainer
    @State private var vm: LoginViewModel
    @State private var kioskSheet = false
    @State private var frame: ScreenFrame?

    init(container: AppContainer) {
        self.container = container
        _vm = State(initialValue: LoginViewModel(auth: container.auth, api: container.api))
    }

    var body: some View {
        // Color.clear takes exactly the offered size; the scene and the form hang
        // off it as background and overlay, so neither can widen the screen.
        Color.clear
            .background {
                GeometryReader { geo in
                    let insets = geo.safeAreaInsets
                    let full = CGSize(width: geo.size.width + insets.leading + insets.trailing,
                                      height: geo.size.height + insets.top + insets.bottom)
                    let metrics = LoginMetrics(size: full)
                    Group {
                        if metrics.layout == .compact { LoginBackdrop(metrics: metrics) } else { LoginScene(metrics: metrics) }
                    }
                    .frame(width: full.width, height: full.height)
                    .position(x: full.width / 2 - insets.leading, y: full.height / 2 - insets.top)
                    .onChange(of: ScreenFrame(size: full, insets: insets), initial: true) { _, new in frame = new }
                }
                .ignoresSafeArea(.keyboard)
            }
            .overlay(alignment: .topLeading) {
                if let frame {
                    let metrics = LoginMetrics(size: frame.size)
                    Group {
                        if metrics.layout == .compact { compact(metrics, insets: frame.insets) } else { wide(metrics, insets: frame.insets) }
                    }
                    .ignoresSafeArea(.container)
                }
            }
            .overlay {
                if vm.supportOpen {
                    SupportCard { vm.supportOpen = false }
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.15), value: vm.supportOpen)
            .environment(\.colorScheme, .light)
            .tint(LoginTokens.orange)
            .task { await vm.loadStatus() }
            .sheet(isPresented: $kioskSheet) { LoginKioskSheet() }
    }

    private func form(_ metrics: LoginMetrics) -> some View {
        LoginForm(vm: vm, f: metrics.f) {
            PairViewModel(api: container.api, identity: container.identity, auth: container.auth)
        }
        .frame(width: metrics.formWidth)
    }

    /// The form column on the right (≥ 900 pt); the scene is drawn behind it.
    private func wide(_ metrics: LoginMetrics, insets: EdgeInsets) -> some View {
        ZStack(alignment: .topTrailing) {
            ScrollView {
                VStack(spacing: 0) {
                    if metrics.layout == .medium { Spacer(minLength: insets.top + 72) }
                    form(metrics)
                        .padding(.top, metrics.layout == .wide ? 156 * metrics.s : 0)
                    Spacer(minLength: insets.bottom + 24)
                }
                .frame(maxWidth: .infinity, minHeight: metrics.size.height, alignment: .trailing)
                .padding(.trailing, metrics.formTrailing)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            gear
                .padding(.top, insets.top + 8)
                .padding(.trailing, metrics.formTrailing - 10)
        }
    }

    /// One scrolling column (< 900 pt): logo, form, status line.
    private func compact(_ metrics: LoginMetrics, insets: EdgeInsets) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    LoginLogo(scale: 0.62)
                    Spacer(minLength: 8)
                    gear
                }
                .padding(.top, insets.top + 12)
                Spacer(minLength: 28)
                form(metrics).frame(maxWidth: .infinity)
                Spacer(minLength: 28)
                LoginStatusLine(scale: 0.8).padding(.bottom, insets.bottom + 16)
            }
            .padding(.leading, insets.leading + 16)
            .padding(.trailing, insets.trailing + 16)
            .frame(minHeight: metrics.size.height)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
    }

    private var gear: some View {
        Button { kioskSheet = true } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(LoginTokens.slate)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Kiosk settings")
    }
}
