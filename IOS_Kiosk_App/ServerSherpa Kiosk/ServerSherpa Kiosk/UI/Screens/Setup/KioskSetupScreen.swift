import SwiftUI

extension Color {
    /// A scan type's CSS color (`#abc` / `#aabbcc`), slate when unparseable.
    init(cssHex css: String) { self.init(hex: parseCssHex(css)) }
}

/// kiosk/src/pages/KioskSetup.tsx: "What is this kiosk?", then the Regular kiosk's four steps (the
/// last, Top or Front, as on Android) or the Time Clock station's Move and Site, and the summary.
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
        _vm = State(initialValue: KioskSetupViewModel(api: container.api, identity: container.identity, prefs: container.prefs, sync: container.sync,
                                                      auth: container.auth, heartbeat: container.heartbeat, station: container.station))
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
            Text(setupSummaryText(sel))
                .font(KioskType.bodyLarge).foregroundStyle(palette.text)
            // a Time Clock station downloads no move data
            if !sel.isTimeclockStation { SyncSummaryView(status: container.sync.status) { vm.syncAgain() } }
            HStack(spacing: 8) {
                SecondaryButton("Change setup") { vm.changeSetup() }
                PrimaryButton("Go to home") { path.removeAll() }
            }
            .padding(.top, 16)
        }
    }

    // MARK: wizard

    @ViewBuilder private var wizard: some View {
        if let header = vm.stepHeader {
            Text(header).font(KioskType.labelSmall).foregroundStyle(palette.textMute)
        }
        if vm.step == .type {
            typeStep
        } else if let error = vm.loadError {
            KioskToast(text: error, error: true)
            SecondaryButton("Retry") { Task { await vm.load() } }
        } else if let opts = vm.options {
            switch vm.step {
            case .type: EmptyView()
            case .move: moveStep(opts)
            case .site: siteStep
            case .scanType: scanTypeStep(opts)
            case .labels: labelsStep
            case .summary: EmptyView()
            }
        } else {
            Text("Loading moves…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
        }
    }

    private func heading(_ text: String) -> some View {
        Text(text).font(KioskType.headline).foregroundStyle(palette.text).padding(.vertical, 8)
    }

    private var typeStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading(KioskSetupViewModel.typeHeading)
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(KioskSetupViewModel.kindChoices, id: \.kind) { choice in
                    SetupCard(selected: choice.kind == vm.kind) { vm.pickKind(choice.kind) } content: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(choice.title).font(KioskType.titleMedium).foregroundStyle(palette.text)
                            mute(choice.blurb)
                        }
                    }
                    .accessibilityIdentifier("setup-kind-\(choice.kind)")
                }
            }
            if vm.canCancel { SecondaryButton("Cancel") { vm.cancelChange() }.padding(.top, 10) }
        }
    }

    private func moveStep(_ opts: SetupOptions) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Which move?")
            LazyVGrid(columns: columns, spacing: 10) {
                if vm.offersNoMove {
                    SetupCard(selected: vm.noMove) { vm.pickNoMove() } content: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("No move").font(KioskType.titleMedium).foregroundStyle(palette.text)
                            mute(KioskSetupViewModel.noMoveBlurb)
                        }
                    }
                }
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
            SecondaryButton("Back") { vm.back() }.padding(.top, 10)
        }
    }

    private var siteStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Which site is this kiosk at?")
            let choices = vm.siteChoices
            let timeclock = vm.kind == .timeclock
            LazyVGrid(columns: columns, spacing: 10) {
                if vm.offersNoSite {
                    SetupCard(selected: vm.noSite, enabled: !vm.saving) { Task { await vm.finishTimeclock(siteId: nil) } } content: {
                        Text(vm.saving && vm.noSite ? "Saving…" : "No site").font(KioskType.titleMedium).foregroundStyle(palette.text)
                    }
                }
                ForEach(choices, id: \.site.id) { c in
                    let saving = vm.saving && !vm.noSite && c.site.id == vm.siteId
                    SetupCard(selected: c.site.id == vm.siteId, enabled: !vm.saving) {
                        if timeclock { Task { await vm.finishTimeclock(siteId: c.site.id) } } else { vm.pickSite(c.site.id) }
                    } content: {
                        if !c.role.isEmpty { Text(c.role.uppercased()).font(KioskType.labelSmall).foregroundStyle(palette.textMute) }
                        Text(saving ? "Saving…" : c.site.name).font(KioskType.titleMedium).foregroundStyle(palette.text)
                    }
                }
            }
            if choices.isEmpty && !vm.offersNoSite { Text("This move has no sites yet. Ask a coordinator to add them.").font(KioskType.bodyMedium).foregroundStyle(palette.textMute) }
            if timeclock, let code = vm.saveError { KioskToast(text: "Couldn't save the kiosk setup (\(code)). Try again.", error: true) }
            if timeclock, let code = vm.keyError {
                KioskToast(text: "The setup saved, but this time clock couldn't get its station key (\(code)). Pick the site again to retry.", error: true)
            }
            SecondaryButton("Back", enabled: !vm.saving) { vm.back() }.padding(.top, 10)
        }
    }

    private func scanTypeStep(_ opts: SetupOptions) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Which scan type?")
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(opts.scanTypes, id: \.key) { s in
                    SetupCard(selected: s.key == vm.scanStatus) { vm.pickScanType(s.key) } content: {
                        HStack(spacing: 10) {
                            Circle().fill(Color(cssHex: s.color)).frame(width: 14, height: 14)
                            Text(s.label).font(KioskType.titleMedium).foregroundStyle(palette.text)
                        }
                    }
                }
            }
            SecondaryButton("Back") { vm.back() }.padding(.top, 10)
        }
    }

    private var labelsStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading(KioskSetupViewModel.labelsHeading)
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(KioskSetupViewModel.labelKindChoices, id: \.kind) { choice in
                    let saving = vm.saving && vm.labelKind == choice.kind
                    SetupCard(selected: choice.kind == vm.labelKind, enabled: !vm.saving) { Task { await vm.finish(choice.kind) } } content: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(saving ? "Saving…" : choice.title).font(KioskType.titleMedium).foregroundStyle(palette.text)
                            mute(choice.blurb)
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
