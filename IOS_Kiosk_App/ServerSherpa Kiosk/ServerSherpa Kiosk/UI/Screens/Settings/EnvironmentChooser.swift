import Observation
import SwiftUI

/// The Server row: a named environment's API host, or a Custom environment's whole API URL.
func environmentServerLabel(_ env: SavedEnvironment) -> String {
    switch env {
    case let .named(_, _, domain): "api.\(domain)"
    case let .custom(apiUrl, _): apiUrl
    }
}

/// The non-Prod badge's text: the environment's name (`Custom` for typed URLs); nil on Prod.
func environmentBadgeText(_ env: SavedEnvironment) -> String? {
    env.isProd ? nil : env.label
}

/// The environment chooser's steps and copy (Android `EnvironmentChooser`, the laptop's
/// `EnvironmentModal`): the environment password, then the list (the current one marked by its id
/// and domain, Custom URL… last), then the API and portal URLs for Custom, or a confirm that says
/// what a switch clears. Unsent scans come back as a count: wait for them (the chooser closes) or
/// discard them (an admin must be signed in). Cancel on the confirm or the URLs goes back to the
/// list.
///
/// The list shows the last good download (or the built-in list) at once and is replaced in place
/// when a fresh download lands. A switch away from a dead server can take a while: until it
/// answers nothing else can be pressed or typed, and it counts as activity every 15 s, so a
/// signed-out Time Clock station doesn't go back to Welcome under it. A throw (an unreadable
/// outbox, storage) is shown here and leaves the chooser on its step.
@MainActor @Observable
final class EnvironmentChooserModel: Identifiable {
    enum Step: Equatable { case password, list, custom, confirm }

    static let wrongPasswordText = "That password isn't right."
    static let badUrlText = "Enter an http or https address for both URLs."
    static let loadingText = "Loading environments…"
    static let customRowText = "Custom URL…"
    /// How often a switch in progress counts as activity on a Time Clock station's sign-in page
    /// (its quiet minute is 60 s).
    static let activityEvery: Duration = .seconds(15)

    static func confirmText(_ name: String) -> String {
        "Switching to \(name) signs this kiosk out and clears its setup and saved move data."
    }

    /// The environment this kiosk is on as the chooser opened.
    let current: SavedEnvironment
    private(set) var step = Step.password
    private(set) var password = ""
    /// Nil until the first list (the saved or built-in one) is in.
    private(set) var list: [Env]?
    private(set) var chosen: Env?
    private(set) var customApi: String
    private(set) var customPortal: String
    /// The unsent scans the last switch stopped at.
    private(set) var pending: Int?
    private(set) var busy = false
    private(set) var error: String?

    @ObservationIgnored private let cachedList: @MainActor () -> [Env]?
    @ObservationIgnored private let freshList: @MainActor () async -> [Env]
    @ObservationIgnored private let switchTo: @MainActor (SavedEnvironment, Bool) async throws -> SwitchResult
    @ObservationIgnored private let activity: @MainActor () -> Void
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void

    /// `cachedList` is the last good download, `freshList` the list as the fetcher has it now (a
    /// fresh download, else the saved or built-in one), `switchTo` the environment switch and
    /// `activity` a touch on a Time Clock station's sign-in page.
    init(current: SavedEnvironment, cachedList: @escaping @MainActor () -> [Env]?,
         freshList: @escaping @MainActor () async -> [Env],
         switchTo: @escaping @MainActor (SavedEnvironment, Bool) async throws -> SwitchResult,
         activity: @escaping @MainActor () -> Void = {},
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.current = current
        self.cachedList = cachedList
        self.freshList = freshList
        self.switchTo = switchTo
        self.activity = activity
        self.sleep = sleep
        customApi = current.apiUrl
        customPortal = current.portalUrl
    }

    /// The app's chooser: its environment store, list fetcher, switcher and Time Clock station.
    convenience init(container: AppContainer) {
        self.init(current: container.config.environment,
                  cachedList: { container.environments.cachedList },
                  freshList: { await container.environmentList.current().list },
                  switchTo: { try await container.environmentSwitcher.switchTo($0, discard: $1) },
                  activity: { container.station.noteLoginActivity() })
    }

    // MARK: what the sheet shows

    var canContinue: Bool { !password.isEmpty }

    /// Marked by its saved id and domain: the list's entry for that id under another domain is a
    /// normal choice (picking it is a full switch).
    func isCurrent(_ env: Env) -> Bool {
        if case let .named(id, _, domain) = current { return id == env.id && domain == env.domain }
        return false
    }

    /// Custom is marked when the kiosk is on typed URLs, and can still be picked to change them.
    var customIsCurrent: Bool { if case .custom = current { true } else { false } }

    var confirmText: String { Self.confirmText(step == .custom ? customLabel : chosen?.name ?? "") }

    var pendingText: String? { pending.map(SettingsModel.unsentScansText) }

    /// The URL fields can't change while a switch runs or its unsent scans are being asked about.
    var fieldsLocked: Bool { busy || pending != nil }

    var canSwitch: Bool {
        !busy && (step != .custom || (!customApi.trimmingCharacters(in: .whitespaces).isEmpty
                                      && !customPortal.trimmingCharacters(in: .whitespaces).isEmpty))
    }

    // MARK: what people do

    /// The saved (or built-in) list at once, then the fetcher's list in its place.
    func loadList() async {
        list = cachedList() ?? Environments.builtIn
        list = await freshList()
    }

    /// A touch in the sheet.
    func noteActivity() { activity() }

    func typePassword(_ value: String) {
        guard !busy, value != password else { return }
        password = value
        error = nil
        activity()
    }

    /// Continue: the environment password opens the list.
    func unlock() {
        guard !busy, !password.isEmpty else { return }
        if password == Environments.password { go(.list) } else { error = Self.wrongPasswordText }
    }

    func choose(_ env: Env) {
        guard !busy, !isCurrent(env) else { return }
        chosen = env
        go(.confirm)
    }

    func chooseCustom() {
        guard !busy else { return }
        go(.custom)
    }

    /// Cancel on the confirm or the URLs.
    func backToList() {
        guard !busy else { return }
        go(.list)
    }

    func typeApi(_ value: String) {
        guard !fieldsLocked, value != customApi else { return }
        customApi = value
        error = nil
        activity()
    }

    func typePortal(_ value: String) {
        guard !fieldsLocked, value != customPortal else { return }
        customPortal = value
        error = nil
        activity()
    }

    /// Switch (or Discard and switch): true when the kiosk switched (on to sign-in). Otherwise the
    /// reason is in `pending` or `error`, and the chooser stays on its step. The switch itself runs
    /// to the end even if this caller is cancelled or the sheet goes away.
    func switchNow(discard: Bool) async -> Bool {
        guard !busy else { return false }
        let target: SavedEnvironment
        if step == .custom {
            guard let typed = SettingsModel.customTarget(api: customApi, portal: customPortal) else {
                error = Self.badUrlText
                return false
            }
            target = typed
        } else {
            guard step == .confirm, let chosen else { return false }
            target = chosen.asSaved
        }
        busy = true
        error = nil
        let ticker = Task { [activity, sleep] in
            while !Task.isCancelled {
                activity()
                do { try await sleep(Self.activityEvery) } catch { return }
            }
        }
        defer {
            ticker.cancel()
            busy = false
        }
        do {
            let result = try await switchTo(target, discard)
            switch result {
            case .done: return true
            case .pending(let n): pending = n
            case .refused: error = SettingsModel.switchMessage(result)
            }
        } catch {
            self.error = SettingsModel.switchFailedMessage(error)
        }
        return false
    }

    private func go(_ next: Step) {
        step = next
        pending = nil
        error = nil
    }
}

/// Settings › This Kiosk's Environment and Server rows: which environment this kiosk connects to
/// (`Custom` for typed URLs) and its server, with Change… opening the chooser. `onSwitched` runs
/// after a switch (the kiosk is signed out and cleared: on to sign-in).
struct EnvironmentRow: View {
    var onSwitched: () -> Void = {}
    @Environment(KioskConfig.self) private var config
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette
    @State private var chooser: EnvironmentChooserModel?

    var body: some View {
        let env = config.environment
        VStack(alignment: .leading, spacing: 0) {
            SettingsRow(title: "Environment") {
                HStack(spacing: 8) {
                    Text(env.label).font(KioskType.bodyLarge).foregroundStyle(palette.text)
                        .accessibilityIdentifier("env-name")
                    Spacer(minLength: 8)
                    SecondaryButton("Change…") { chooser = EnvironmentChooserModel(container: container) }
                        .accessibilityIdentifier("env-change")
                }
            }
            SettingsRow(title: "Server") {
                Text(environmentServerLabel(env)).font(KioskType.mono(13)).foregroundStyle(palette.text)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("env-server")
            }
        }
        .sheet(item: $chooser) { model in
            EnvironmentChooser(model: model, onClose: { chooser = nil },
                               onSwitched: { chooser = nil; onSwitched() })
        }
    }
}

/// The chooser sheet (see `EnvironmentChooserModel`): the house modal header (eyebrow, title,
/// close), the step's content, and its buttons pinned below it, never behind a scroll; the close
/// stays in the sheet's corner. It follows
/// the app's light or dark theme. While a switch runs it can't be closed or swiped away.
struct EnvironmentChooser: View {
    let model: EnvironmentChooserModel
    let onClose: () -> Void
    let onSwitched: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        PinnedActions(padding: 16) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 8) {
                    PageHeader(eyebrow: "This kiosk", title: "Change environment")
                    // Room for the close button, which sits over the sheet's corner.
                    Color.clear.frame(width: 44, height: 44)
                }
                stepContent
            }
        } actions: {
            // The lines sit with the buttons, so they show even with the keyboard up.
            VStack(alignment: .leading, spacing: 0) {
                KioskToast(text: model.pendingText, error: true)
                KioskToast(text: model.error, error: true)
                buttons.padding(.top, 8)
            }
        }
        // Each step opens at its top, not where the last one was scrolled to.
        .id(model.step)
        .frame(maxHeight: .infinity, alignment: .top)
        // Pinned to the corner, never scrolled away (the header itself scrolls with the step on a
        // short screen at large text sizes, where pinning it would leave the step no room).
        .overlay(alignment: .topTrailing) { closeButton.padding(.top, 16).padding(.trailing, 16) }
        .background(palette.paper)
        // A Time Clock station's sign-in page sees nothing of this sheet: a touch here counts too.
        .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in model.noteActivity() })
        .task { await model.loadList() }
        // The UI test's handle on the sheet's frame (the buttons must lie inside it).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("env-chooser")
        .interactiveDismissDisabled(model.busy)
        .presentationBackground(palette.paper)
        .presentationCornerRadius(16)
        .presentationSizing(.form)
    }

    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(palette.textMute)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.busy)
        .opacity(model.busy ? 0.45 : 1)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("env-close")
    }

    @ViewBuilder private var stepContent: some View {
        switch model.step {
        case .password:
            fieldLabel("Environment password")
            SecureField("", text: Binding(get: { model.password }, set: { model.typePassword($0) }))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.continue)
                .onSubmit { model.unlock() }
                .modifier(ChooserField(palette: palette))
                .accessibilityLabel("Environment password")
                .accessibilityIdentifier("env-password")
        case .list:
            if let list = model.list {
                ForEach(list) { env in
                    choiceRow(env.name, here: model.isCurrent(env), enabled: !model.isCurrent(env), id: "env-row-\(env.id)") {
                        model.choose(env)
                    }
                }
            } else {
                Text(EnvironmentChooserModel.loadingText).font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                    .padding(.bottom, 8)
            }
            // Picked again when current, to change its URLs.
            choiceRow(EnvironmentChooserModel.customRowText, here: model.customIsCurrent, enabled: true, id: "env-custom") {
                model.chooseCustom()
            }
        case .custom:
            fieldLabel("API URL")
            urlField("API URL", Binding(get: { model.customApi }, set: { model.typeApi($0) }), id: "env-api-url")
            fieldLabel("Portal URL").padding(.top, 8)
            urlField("Portal URL", Binding(get: { model.customPortal }, set: { model.typePortal($0) }), id: "env-portal-url")
            confirmLine
        case .confirm:
            confirmLine
        }
    }

    private var confirmLine: some View {
        Text(model.confirmText).font(KioskType.bodyMedium).foregroundStyle(palette.text)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12).padding(.bottom, 4)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.bottom, 4)
    }

    private func urlField(_ label: String, _ text: Binding<String>, id: String) -> some View {
        TextField(label, text: text)
            .font(KioskType.mono(14))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .disabled(model.fieldsLocked)
            .modifier(ChooserField(palette: palette))
            .accessibilityIdentifier(id)
    }

    /// One environment in the list: its name, and "Current" on the one this kiosk is on.
    private func choiceRow(_ name: String, here: Bool, enabled: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(name).font(KioskType.bodyLarge).foregroundStyle(palette.text)
                Spacer(minLength: 8)
                if here { KioskChip(text: "Current", tone: .slate, dot: false).fixedSize() }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled || model.busy)
        .accessibilityIdentifier(id)
        .padding(.bottom, 8)
    }

    @ViewBuilder private var buttons: some View {
        switch model.step {
        case .password:
            buttonRow {
                PrimaryButton("Continue", enabled: model.canContinue) { model.unlock() }
                    .accessibilityIdentifier("env-continue")
                SecondaryButton("Cancel", action: onClose)
                    .accessibilityIdentifier("env-password-cancel")
            }
        case .list:
            SecondaryButton("Cancel", action: onClose)
                .accessibilityIdentifier("env-list-cancel")
        case .custom, .confirm:
            if model.pending == nil {
                buttonRow {
                    PrimaryButton(model.busy ? "Switching…" : "Switch", enabled: model.canSwitch) { start(discard: false) }
                        .accessibilityIdentifier("env-confirm")
                    SecondaryButton("Cancel", enabled: !model.busy) { model.backToList() }
                        .accessibilityIdentifier("env-cancel")
                }
            } else {
                buttonRow {
                    PrimaryButton(model.busy ? "Switching…" : "Discard and switch", enabled: !model.busy) { start(discard: true) }
                        .accessibilityIdentifier("env-discard")
                    SecondaryButton("Wait for them to send", enabled: !model.busy, action: onClose)
                        .accessibilityIdentifier("env-wait")
                }
            }
        }
    }

    /// Two buttons side by side, or one above the other when they don't fit (a phone, large text).
    private func buttonRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let buttons = content()
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttons }
            VStack(alignment: .leading, spacing: 8) { buttons }
        }
    }

    /// The switch runs in a task of its own, not the sheet's: a signed-in switch signs out first,
    /// and the app's sign-out takes this sheet away while the switch carries on to the end (the
    /// kiosk then lands on sign-in).
    private func start(discard: Bool) {
        let model = model
        let onSwitched = onSwitched
        Task { if await model.switchNow(discard: discard) { onSwitched() } }
    }
}

/// The chooser's text fields: the app's own field look, in the theme (the sign-in form's fields
/// are forced light).
private struct ChooserField: ViewModifier {
    let palette: KioskPalette

    func body(content: Content) -> some View {
        content
            .font(KioskType.bodyLarge)
            .foregroundStyle(palette.text)
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
    }
}

/// The non-Prod badge: the environment's name (`Custom` for typed URLs) in an amber chip, on the
/// shell's top bar and the sign-in screen. Nothing on Prod.
struct EnvironmentBadge: View {
    @Environment(KioskConfig.self) private var config

    var body: some View {
        if let text = environmentBadgeText(config.environment) {
            KioskChip(text: text, tone: .amber)
                .fixedSize()
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("env-badge")
        }
    }
}
