import SwiftUI

extension Color {
    /// A scan type's CSS color (`#abc` / `#aabbcc`), slate when unparseable.
    init(cssHex css: String) { self.init(hex: parseCssHex(css)) }
}

/// kiosk/src/pages/KioskSetup.tsx: the three-step wizard and the summary.
struct KioskSetupScreen: View {
    @Binding var path: [Route]
    @Environment(\.container) private var container

    var body: some View {
        KioskSetupBody(container: container, path: $path)
    }
}

private struct KioskSetupBody: View {
    @Binding var path: [Route]
    let container: AppContainer
    @State private var vm: KioskSetupViewModel
    @Environment(\.kioskPalette) private var palette
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(container: AppContainer, path: Binding<[Route]>) {
        self.container = container
        _path = path
        _vm = State(initialValue: KioskSetupViewModel(api: container.api, identity: container.identity, prefs: container.prefs, sync: container.sync, auth: container.auth))
    }

    private var columns: [GridItem] {
        sizeClass == .compact ? [GridItem(.flexible())] : [GridItem(.adaptive(minimum: 300), spacing: 10, alignment: .top)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Setup", title: "Kiosk setup")
                if vm.step == .summary { summary } else { wizard }
            }
            .padding(16)
        }
        .background(palette.paper2)
        .task(id: vm.step == .summary) {
            if vm.step != .summary, vm.options == nil, vm.loadError == nil { await vm.load() }
        }
    }

    // MARK: summary

    @ViewBuilder private var summary: some View {
        if let sel = vm.selection {
            let sync = container.sync.status
            Text("This kiosk is set up for \(sel.initiativeName) at \(sel.siteName) (\(sel.siteRole)) · scan type \(sel.scanLabel)")
                .font(KioskType.bodyLarge).foregroundStyle(palette.text)
            HStack(spacing: 8) {
                switch sync.phase {
                case .idle:
                    Text("No move data on this kiosk yet.").font(KioskType.bodyMedium).foregroundStyle(palette.text)
                    SecondaryButton("Sync now") { vm.syncAgain() }
                case .running:
                    Text("Downloading move data…").font(KioskType.bodyMedium).foregroundStyle(palette.text)
                case .done:
                    Text("Local data: \(sync.assets ?? 0) assets · \(sync.people ?? 0) people · \(sync.containers ?? 0) containers · \(sync.trucks ?? 0) trucks" + (sync.syncedAt.map { " · synced \(Sync.formatSyncedAt($0))" } ?? ""))
                        .font(KioskType.bodyMedium).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    SecondaryButton("Sync again") { vm.syncAgain() }
                case .error:
                    KioskToast(text: "Couldn't download move data (\(sync.error ?? "unknown_error")).", error: true)
                    SecondaryButton("Try again") { vm.syncAgain() }
                }
            }
            .padding(.top, 12)
            HStack(spacing: 8) {
                SecondaryButton("Change setup") { vm.changeSetup() }
                PrimaryButton("Go to home") { path.removeAll() }
            }
            .padding(.top, 16)
        }
    }

    // MARK: wizard

    @ViewBuilder private var wizard: some View {
        if let n = vm.stepNumber {
            let name = ["Move", "Site", "Scan type"][n - 1]
            Text("STEP \(n) OF 3 · \(name.uppercased())").font(KioskType.labelSmall).foregroundStyle(palette.textMute)
        }
        if let error = vm.loadError {
            KioskToast(text: error, error: true)
            SecondaryButton("Retry") { Task { await vm.load() } }
        } else if let opts = vm.options {
            switch vm.step {
            case .move: moveStep(opts)
            case .site: siteStep
            case .scanType: scanTypeStep(opts)
            case .summary: EmptyView()
            }
        } else {
            Text("Loading moves…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
        }
    }

    private func heading(_ text: String) -> some View {
        Text(text).font(KioskType.headline).foregroundStyle(palette.text).padding(.vertical, 8)
    }

    private func moveStep(_ opts: SetupOptions) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Which move?")
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(opts.initiatives, id: \.id) { i in
                    SetupCard(selected: i.id == vm.initiativeId) { vm.pickMove(i.id) } content: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(i.name).font(KioskType.titleMedium).foregroundStyle(palette.text)
                            KioskChip(text: i.statusLabel, tone: i.status == "in_progress" ? .green : .slate, dot: false)
                            if let c = i.clientName { mute(c) }
                            if let d = formatMoveDates(i) { mute(d) }
                            mute("\(i.sourceSite?.name ?? "—") → \(i.destinationSite?.name ?? "—")")
                        }
                    }
                }
            }
            if opts.initiatives.isEmpty { Text("No active moves. Ask a coordinator to plan one.").font(KioskType.bodyMedium).foregroundStyle(palette.textMute) }
            if vm.canCancel { SecondaryButton("Cancel") { vm.cancelChange() }.padding(.top, 10) }
        }
    }

    private var siteStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Which site is this kiosk at?")
            let choices = vm.siteChoices
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(choices, id: \.site.id) { c in
                    SetupCard(selected: c.site.id == vm.siteId) { vm.pickSite(c.site.id) } content: {
                        Text(c.role.uppercased()).font(KioskType.labelSmall).foregroundStyle(palette.textMute)
                        Text(c.site.name).font(KioskType.titleMedium).foregroundStyle(palette.text)
                    }
                }
            }
            if choices.isEmpty { Text("This move has no sites yet. Ask a coordinator to add them.").font(KioskType.bodyMedium).foregroundStyle(palette.textMute) }
            SecondaryButton("Back") { vm.back() }.padding(.top, 10)
        }
    }

    private func scanTypeStep(_ opts: SetupOptions) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Which scan type?")
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(opts.scanTypes, id: \.key) { s in
                    let saving = vm.saving && vm.scanStatus == s.key
                    SetupCard(selected: s.key == vm.scanStatus, enabled: !vm.saving) { Task { await vm.pickScanType(s.key) } } content: {
                        HStack(spacing: 10) {
                            Circle().fill(Color(cssHex: s.color)).frame(width: 14, height: 14)
                            Text(saving ? "Saving…" : s.label).font(KioskType.titleMedium).foregroundStyle(palette.text)
                        }
                    }
                }
            }
            if let code = vm.saveError { KioskToast(text: "Couldn't save the kiosk setup (\(code)). Try again.", error: true) }
            SecondaryButton("Back", enabled: !vm.saving) { vm.back() }.padding(.top, 10)
        }
    }

    private func mute(_ text: String) -> some View {
        Text(text).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
    }
}
