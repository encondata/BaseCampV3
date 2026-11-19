#if DEBUG
import SwiftUI

/// Debug builds only (`-uiTestAssetLookup <empty|detail|list|offline>`): the real Asset Lookup
/// screen inside the kiosk shell (shown signed in, as in production), answered from memory, so
/// its layout can be checked on the Simulator with no server, no sign-in and no Kiosk Setup.
/// Nothing is stored or sent. "102466"
/// opens an admin's card, anything with "asset" in it lists three matches, and the rest miss.
enum AssetLookupSampleMode: String {
    case empty, detail, list, offline

    /// The mode the launch asked for, if any.
    static var fromLaunch: AssetLookupSampleMode? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-uiTestAssetLookup") else { return nil }
        return args.indices.contains(i + 1) ? AssetLookupSampleMode(rawValue: args[i + 1]) ?? .empty : .empty
    }

    /// What the sample types first.
    var firstScan: String? {
        switch self {
        case .empty: nil
        case .detail, .offline: "102466"
        case .list: "Asset"
        }
    }
}

private struct SampleLookupSource: AssetLookupSource {
    let offline: Bool

    private func match(_ id: String, _ name: String, _ tag: String, _ serial: String, _ matched: [String]) -> KioskLookupMatch {
        KioskLookupMatch(id: id, name: name, assetTag: tag, serialNumber: serial, matched: matched)
    }

    func find(serial: String, value: String) async throws -> LookupFound {
        try await Task.sleep(for: .milliseconds(300))
        if value == "102466" {
            return LookupFound(offline: offline, result: KioskLookupResult(matches: [match("a1", "Asset A", "102466", "SN-100", ["asset_tag"])]))
        }
        if value.localizedCaseInsensitiveContains("asset") {
            return LookupFound(offline: offline, result: KioskLookupResult(matches: [
                match("a1", "Asset A", "102466", "SN-100", ["asset_tag"]),
                match("a2", "Asset B", "102467", "SN-200", ["rfid"]),
                match("a3", "Asset C", "102468", "SN-300", ["serial"]),
            ], truncated: true))
        }
        return LookupFound(offline: offline, result: KioskLookupResult())
    }

    func open(serial: String, id: String, offline wasOffline: Bool, admin: Bool) async throws -> LookupOpened {
        try await Task.sleep(for: .milliseconds(300))
        let route = KioskAssetRoute(initiativeId: "m1", initiativeName: "Move A",
                                    source: KioskAssetEnd(siteName: "Site A", rack: "R12", ru: "14"),
                                    destination: KioskAssetEnd(siteName: "Site B", rack: "R40", position: "Left"))
        let full = offline
            ? KioskAssetFull(status: "packed", statusLabel: "Packed",
                             moves: [KioskAssetMove(initiativeId: "m1", initiativeName: "Move A")], containerName: "Container A")
            : KioskAssetFull(status: "packed", statusLabel: "Packed", statusColor: "#22aa55",
                             moves: [KioskAssetMove(initiativeId: "m1", initiativeName: "Move A", status: "active",
                                                    statusLabel: "Active", statusColor: "#3366ff")],
                             containerName: "Container A", truckName: "Truck A")
        let name = ["a1": "Asset A", "a2": "Asset B", "a3": "Asset C"][id] ?? "Asset A"
        return LookupOpened(offline: offline, detail: KioskAssetDetail(
            id: id, name: name, makeModel: "Make A Model A", assetTag: "102466", serialNumber: "SN-100",
            rfid: "000000000000000000100418", routes: [route], full: full))
    }

    func scans(serial: String, id: String) async throws -> [AssetScanRow] {
        try await Task.sleep(for: .milliseconds(300))
        func row(_ n: Int, _ status: String, _ color: String, _ method: String, _ methodColor: String, offMove: Bool = false) -> AssetScanRow {
            AssetScanRow(id: "s\(n)", scanTypeLabel: method, scanTypeColor: methodColor, statusLabel: status, statusColor: color,
                         scannedAt: "2026-11-1\(n)T1\(n):0\(n):00Z", deviceId: "Kiosk A", operatorName: n.isMultiple(of: 2) ? "Person B" : "Person A",
                         siteName: n.isMultiple(of: 2) ? "Site B" : "Site A", offMove: offMove)
        }
        return [
            row(6, "Loaded", "#3366ff", "RFID", "#8b5cf6"),
            row(5, "Packed", "#22aa55", "Barcode", "#0ea5e9", offMove: true),
            row(4, "Pre-stage", "#f59e0b", "Barcode", "#0ea5e9"),
            AssetScanRow(id: "s3", scannedAt: "2026-11-13T13:03:00Z"),
        ]
    }
}

/// The sample screen in the kiosk shell, on the device's light or dark look.
struct AssetLookupSampleHost: View {
    let mode: AssetLookupSampleMode
    @Environment(\.container) private var container
    @State private var vm: AssetLookupViewModel

    init(mode: AssetLookupSampleMode) {
        self.mode = mode
        _vm = State(initialValue: AssetLookupViewModel(source: SampleLookupSource(offline: mode == .offline), serial: { "SAMPLE" },
                                                       isAdmin: { true }, canViewScans: { true }))
    }

    var body: some View {
        KioskShell(path: .constant([.lookup])) {
            AssetLookupBody(vm: vm, ready: true, subtitle: "Move A · Site A", bus: container.scanBus, prefs: container.prefs)
        }
        .kioskTheme(accent: "amber", scheme: nil)
        .task {
            // The shell as production shows it: someone signed in, a registration chip, Sign out.
            container.auth.showSampleSessionForUITest(SessionData(
                accessToken: "sample", expiresIn: 900, sessionExpiresAt: "2099-01-01T00:00:00Z",
                person: PersonOut(id: "p1", firstName: "Person", lastName: "A Lastname", displayName: "Person A Lastname"),
                roles: ["admin"], perms: ["kiosk": ["view": true], "scans": ["view": true]], maxRank: 60))
            container.heartbeat.showSampleRegistrationForUITest(.ok)
            if let first = mode.firstScan { vm.onScan(first) }
        }
    }
}
#endif
