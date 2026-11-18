import SwiftUI

/// kiosk/src/pages/AssetLookup.tsx (Android `AssetLookupScreen.kt`): one box for an asset tag,
/// serial, RFID or name, from typing, a keyboard scanner or the camera. Read-only: the view model
/// takes no Outbox.
///
/// Until Kiosk Setup is complete (only developer mode gets here then) the box, the camera and
/// Search are off and scans are not passed on.
struct AssetLookupScreen: View {
    @Environment(\.container) private var container

    var body: some View {
        AssetLookupLive(container: container)
    }
}

private struct AssetLookupLive: View {
    let container: AppContainer
    @State private var vm: AssetLookupViewModel

    init(container: AppContainer) {
        self.container = container
        let auth = container.auth
        let identity = container.identity
        _vm = State(initialValue: AssetLookupViewModel(
            source: AssetLookupRepository(api: container.api, store: container.store),
            serial: { identity.current.serial },
            isAdmin: { if case .authed(let s) = auth.state { s.isAdmin } else { false } },
            // The server refuses the scans route without it too.
            canViewScans: { auth.can("scans", "view") }))
    }

    var body: some View {
        let prefs = container.prefs
        let setup = prefs.setupSelection
        AssetLookupBody(vm: vm, ready: prefs.setupState.isComplete && setup != nil,
                        subtitle: setup.map { "\($0.initiativeName) · \($0.siteName)" } ?? LookupCopy.finishSetup,
                        bus: container.scanBus, prefs: prefs)
    }
}

/// The screen itself. The header and the box stay above the results on an iPad and an upright
/// phone, so Search and Clear never scroll away; a phone on its side has no height to spare, so
/// there everything scrolls (the buttons still open at the top). From 700 pt wide (Scanning's
/// table width) the list and the scan history are tables and the box shares a row with its
/// buttons; narrower, they stack.
struct AssetLookupBody: View {
    let vm: AssetLookupViewModel
    let ready: Bool
    let subtitle: String
    let bus: ScanBus
    let prefs: KioskPrefs
    @State private var camera = false
    /// The page's width inside its padding; nil until measured.
    @State private var contentWidth: CGFloat?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.kioskPalette) private var palette

    private static let wideWidth: CGFloat = 700
    private static let cardId = "lookup-card"

    /// Until the first measurement, regular-width devices (iPad) start wide so there is no stacked first frame.
    private var wide: Bool { contentWidth.map { $0 >= Self.wideWidth } ?? (sizeClass == .regular) }
    private var pinned: Bool { verticalSizeClass != .compact }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 0) {
                if pinned {
                    top.padding([.horizontal, .top], 16).padding(.bottom, 12)
                    Rectangle().fill(palette.paperLine).frame(height: 1)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if !pinned { top.padding(.bottom, 12) }
                        results
                    }
                    .padding(16)
                }
                .scrollDismissesKeyboard(.never)
            }
            // On a picked row the list stays (as on the web) and the card opens below it: bring it
            // into view rather than leave it under 25 rows.
            .onChange(of: vm.ui.detail?.id) { _, id in
                guard id != nil, vm.ui.list != nil else { return }
                withAnimation { proxy.scrollTo(Self.cardId, anchor: .top) }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width - 32 } action: { contentWidth = $0 }
        .background(palette.paper2)
        .task(id: ready) {
            guard ready else { return }
            for await event in bus.events() { vm.onScan(event.value) }
        }
        .fullScreenCover(isPresented: $camera) {
            CameraScanSheet(bus: bus, prefs: prefs) { camera = false }
        }
    }

    // MARK: header and box

    @ViewBuilder private var top: some View {
        PageHeader(eyebrow: "Kiosk · Asset Lookup", title: "Asset Lookup", subtitle: subtitle)
        if wide {
            HStack(spacing: 8) {
                box
                buttons.fixedSize()
            }
        } else {
            box
            buttons.padding(.top, 8)
        }
    }

    private var box: some View {
        ScanInput(placeholder: LookupCopy.placeholder, enabled: ready, keepFocus: !camera,
                  text: Binding(get: { vm.ui.value }, set: { vm.onValueChange($0) }), selectToken: vm.restoreCount,
                  onSubmit: { bus.publish(ScanEvent(value: $0, source: .keyboard, symbology: nil)) }) {
            if CameraSupport.hasCamera {
                Button { camera = true } label: {
                    Image(systemName: "camera").font(.system(size: 20)).foregroundStyle(palette.text).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).disabled(!ready).opacity(ready ? 1 : 0.45)
                .accessibilityLabel("Scan with camera")
            }
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            PrimaryButton("Search", enabled: ready) { vm.lookup() }
                .accessibilityIdentifier("lookup-search")
            SecondaryButton("Clear") { vm.clear() }
                .accessibilityIdentifier("lookup-clear")
        }
    }

    // MARK: results

    @ViewBuilder private var results: some View {
        let ui = vm.ui
        if ui.offline { OfflineLine() }
        KioskToast(text: ui.miss, error: true)
        KioskToast(text: ui.error, error: true)
        if let list = ui.list { MatchList(list: list, wide: wide, width: contentWidth, onPick: { vm.pick($0) }) }
        if ui.searching {
            ProgressView().tint(palette.textMute).frame(maxWidth: .infinity).padding(.vertical, 24)
                .accessibilityLabel("Looking up")
        }
        if let detail = ui.detail {
            DetailCard(detail: detail, scans: ui.scans, wide: wide).id(Self.cardId)
        }
    }
}

// MARK: - Pieces

private struct OfflineLine: View {
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "wifi.slash").font(.system(size: 13, weight: .semibold)).foregroundStyle(ChipTone.amber.text)
            Text(LookupCopy.offlineNotice).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(ChipTone.amber.bg, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(ChipTone.amber.border, lineWidth: 1))
        .padding(.vertical, 6)
        .accessibilityIdentifier("lookup-offline")
    }
}

/// A label over its value (the web's dt/dd). The value wraps; nothing is cut off.
private struct FactView: View {
    let fact: LookupFact
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            FactLabel(text: fact.label)
            Text(fact.value).font(fact.mono ? KioskType.mono(14) : KioskType.bodyMedium).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 6)
    }
}

private struct FactLabel: View {
    let text: String
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Text(text.uppercased()).font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
    }
}

private struct Hint: View {
    let text: String
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Text(text).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 6)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct LookupSectionTitle: View {
    let text: String
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Text(text).font(KioskType.titleMedium).foregroundStyle(palette.text).padding(.bottom, 2)
    }
}

private struct Blank: View {
    @Environment(\.kioskPalette) private var palette

    var body: some View { Text(LOOKUP_BLANK).font(KioskType.bodyMedium).foregroundStyle(palette.textMute) }
}

/// A status chip in its own color, or "—" without a label. Offline the status has no color: plain.
private struct StatusChip: View {
    let label: String?
    let color: String?

    var body: some View {
        if let label, !label.trimmingCharacters(in: .whitespaces).isEmpty {
            ColorChip(text: label, color: hexColor(color))
        } else {
            Blank()
        }
    }
}

// MARK: - The list

/// The matches; tap one to open it. "Matched on" only when a match isn't by name.
private struct MatchList: View {
    let list: KioskLookupResult
    let wide: Bool
    let width: CGFloat?
    let onPick: (String) -> Void
    @Environment(\.kioskPalette) private var palette

    private var matches: [KioskLookupMatch] { Array(list.matches.prefix(LOOKUP_CAP)) }

    var body: some View {
        let showMatched = showsMatchedOn(matches)
        VStack(alignment: .leading, spacing: 0) {
            if wide { header(showMatched) }
            Rectangle().fill(palette.paperLine).frame(height: 1)
            ForEach(matches, id: \.id) { m in
                Button { onPick(m.id) } label: {
                    Group { if wide { tableRow(m, showMatched) } else { stackedRow(m, showMatched) } }
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("lookup-match-\(m.id)")
                Rectangle().fill(palette.paperLine).frame(height: 1)
            }
            if list.truncated { Hint(text: LookupCopy.refine) }
        }
        .padding(.top, 12)
    }

    private func stackedRow(_ m: KioskLookupMatch, _ showMatched: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(lookupName(m.name)).font(KioskType.titleMedium).foregroundStyle(palette.accent)
            FlowRow(spacing: 16) {
                ForEach(lookupMatchFacts(m, showMatched: showMatched)) { FactView(fact: $0) }
            }
        }
    }

    /// Name takes the most room; the rest share what's left.
    private func columns(_ showMatched: Bool) -> [CGFloat?] {
        guard let width else { return showMatched ? [nil, nil, nil, nil] : [nil, nil, nil] }
        let gaps = 16 * CGFloat(showMatched ? 3 : 2)
        let room = width - gaps
        return showMatched ? [room * 0.4, room * 0.2, room * 0.2, room * 0.2] : [room * 0.5, room * 0.25, room * 0.25]
    }

    private func header(_ showMatched: Bool) -> some View {
        let titles = ["Name", "Asset tag", "Serial"] + (showMatched ? ["Matched on"] : [])
        let widths = columns(showMatched)
        return HStack(spacing: 16) {
            ForEach(titles.indices, id: \.self) { i in
                FactLabel(text: titles[i]).frame(width: widths[i], alignment: .leading)
                    .frame(maxWidth: widths[i] == nil ? .infinity : nil, alignment: .leading)
            }
        }
        .padding(.bottom, 6)
    }

    private func tableRow(_ m: KioskLookupMatch, _ showMatched: Bool) -> some View {
        let widths = columns(showMatched)
        let facts = lookupMatchFacts(m, showMatched: showMatched)
        return HStack(alignment: .firstTextBaseline, spacing: 16) {
            cell(widths[0]) { Text(lookupName(m.name)).font(KioskType.titleMedium).foregroundStyle(palette.accent) }
            ForEach(facts.indices, id: \.self) { i in
                cell(widths[i + 1]) {
                    Text(facts[i].value).font(facts[i].mono ? KioskType.mono(14) : KioskType.bodyMedium).foregroundStyle(palette.text)
                }
            }
        }
    }

    private func cell<C: View>(_ width: CGFloat?, @ViewBuilder _ content: () -> C) -> some View {
        content().fixedSize(horizontal: false, vertical: true)
            .frame(width: width, alignment: .leading)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

// MARK: - The card

/// Identity, each route's two ends, and for admins the status chip, Current location, Moves and
/// the scan history.
private struct DetailCard: View {
    let detail: KioskAssetDetail
    let scans: LookupScans
    let wide: Bool
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(lookupName(detail.name)).font(KioskType.titleLarge).foregroundStyle(palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if lookupText(detail.makeModel) != LOOKUP_BLANK {
                        Text(detail.makeModel).font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // No "Status" word: the chip speaks for itself.
                if let full = detail.full { StatusChip(label: full.statusLabel, color: full.statusColor) }
            }
            FlowRow(spacing: 16) {
                ForEach(lookupIdentityFacts(detail)) { FactView(fact: $0) }
            }
            .padding(.top, 4)
            ForEach(detail.routes.indices, id: \.self) { i in
                route(detail.routes[i])
            }
            if let full = detail.full {
                moves(full)
                ScanSection(scans: scans, wide: wide)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.paperLine, lineWidth: 1))
        .padding(.top, 12)
        .accessibilityIdentifier("lookup-card")
    }

    private func route(_ route: KioskAssetRoute) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if lookupShowsRouteTitles(detail) { LookupSectionTitle(text: route.initiativeName) }
            if wide {
                HStack(alignment: .top, spacing: 24) {
                    RouteEnd(title: "Source", end: route.source).frame(maxWidth: .infinity, alignment: .leading)
                    RouteEnd(title: "Destination", end: route.destination).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                FlowRow(spacing: 24) {
                    RouteEnd(title: "Source", end: route.source)
                    RouteEnd(title: "Destination", end: route.destination)
                }
            }
        }
        .padding(.top, 12)
    }

    private func moves(_ full: KioskAssetFull) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            FactLabel(text: "Moves")
            if full.moves.isEmpty { Blank() }
            ForEach(full.moves.indices, id: \.self) { i in
                let m = full.moves[i]
                FlowRow(spacing: 8) {
                    Text(m.initiativeName).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                    if lookupText(m.statusLabel) != LOOKUP_BLANK { ColorChip(text: m.statusLabel, color: hexColor(m.statusColor)) }
                }
            }
        }
        .padding(.top, 12)
    }
}

/// One end of a route: Site, Rack, then RU, or Position when there is no RU.
private struct RouteEnd: View {
    let title: String
    let end: KioskAssetEnd
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(KioskType.sans(14, .semibold)).foregroundStyle(palette.text)
            ForEach(lookupEndFacts(end)) { FactView(fact: $0) }
        }
        .padding(.top, 4)
    }
}

// MARK: - The scan history

private struct ScanSection: View {
    let scans: LookupScans
    let wide: Bool

    var body: some View {
        if scans != .hidden {
            VStack(alignment: .leading, spacing: 0) {
                LookupSectionTitle(text: LookupCopy.scanHistory)
                switch scans {
                case .hidden: EmptyView()
                case .needsConnection: Hint(text: LookupCopy.scansOffline)
                case .loading: Hint(text: LookupCopy.scansLoading)
                case .failed: Hint(text: LookupCopy.scansFailed)
                case .rows(let rows):
                    if rows.isEmpty {
                        Hint(text: LookupCopy.noScans)
                    } else {
                        if wide { HistoryTable(rows: rows) } else { HistoryRows(rows: rows) }
                        if rows.count >= SCAN_LIMIT { Hint(text: LookupCopy.latestScans) }
                    }
                }
            }
            .padding(.top, 12)
            .accessibilityIdentifier("lookup-scans")
        }
    }
}

/// The status chip, and the amber "Off move" chip for a sighting off the move.
private struct ScanStatusChips: View {
    let line: LookupScanLine

    var body: some View {
        FlowRow(spacing: 6) {
            StatusChip(label: line.status, color: line.statusColor)
            if line.offMove { KioskChip(text: "Off move", tone: .amber, dot: false) }
        }
    }
}

/// The wide layout: Status, Scanned, Method, Device, Operator, Site (the web's table).
private struct HistoryTable: View {
    let rows: [LookupScanLine]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                ForEach(["Status", "Scanned", "Method", "Device", "Operator", "Site"], id: \.self) { FactLabel(text: $0) }
            }
            .padding(.vertical, 6)
            ForEach(rows) { line in
                Rectangle().fill(palette.paperLine).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                GridRow {
                    ScanStatusChips(line: line)
                    Text(line.when).font(KioskType.labelMedium).foregroundStyle(palette.text).fixedSize()
                    StatusChip(label: line.method, color: line.methodColor)
                    Text(line.device).font(KioskType.labelMedium).foregroundStyle(palette.text)
                    Text(line.operatorName).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                    Text(line.site).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                }
                .padding(.vertical, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }
}

/// The narrow layout: the same fields and order, stacked per scan.
private struct HistoryRows: View {
    let rows: [LookupScanLine]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(palette.paperLine).frame(height: 1).padding(.top, 6)
            ForEach(rows) { line in
                VStack(alignment: .leading, spacing: 0) {
                    FlowRow(spacing: 8) {
                        ScanStatusChips(line: line)
                        Text(line.when).font(KioskType.labelMedium).foregroundStyle(palette.text)
                        StatusChip(label: line.method, color: line.methodColor)
                    }
                    FlowRow(spacing: 16) {
                        FactView(fact: LookupFact(label: "Device", value: line.device))
                        FactView(fact: LookupFact(label: "Operator", value: line.operatorName, mono: false))
                        FactView(fact: LookupFact(label: "Site", value: line.site, mono: false))
                    }
                }
                .padding(.vertical, 8)
                Rectangle().fill(palette.paperLine).frame(height: 1)
            }
        }
    }
}
