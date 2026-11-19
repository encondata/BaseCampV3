import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Android AssetLookupTest, case for case (less the sled's `distinctTags`), plus the iOS rules the
/// screen reads: what a lookup's answer becomes, "Matched on" and the scan-history gate.
struct AssetLookupTests {
    private func a(_ id: String, tag: String = "", name: String? = nil, serial: String? = nil,
                   rfid: String? = nil, container: String? = nil) -> LocalAsset {
        LocalAsset(id: id, assetId: tag, name: name, rfid: rfid, serialNumber: serial, containerId: container)
    }

    private func data(_ assets: [LocalAsset], moveId: String = "m1") -> LocalLookupData {
        LocalLookupData(assets: assets, containerNames: ["c1": "Crate 7"], moveId: moveId, moveName: "Move One",
                        sourceSite: "Src", destinationSite: "Dst")
    }

    @Test func assetTagMatchesOnlyPlainDigits() {
        let xs = [a("1", tag: "102466")]
        #expect(matchLocal(xs, "0102466").matches.isEmpty)
        #expect(matchLocal(xs, "12a").matches.isEmpty)
        let r = matchLocal(xs, "102466")
        #expect(r.matches.count == 1)
        #expect(r.matches.first?.matched == ["asset_tag"])
    }

    /// At most 18 digits, as the server's rule (a longer run is never an asset tag).
    @Test func anAssetTagIsAtMostEighteenDigits() {
        let long = String(repeating: "1", count: 19)
        #expect(matchLocal([a("1", tag: long)], long).matches.isEmpty)
        let ok = String(repeating: "1", count: 18)
        #expect(matchLocal([a("1", tag: ok)], ok).matches.first?.matched == ["asset_tag"])
    }

    @Test func serialIgnoresCaseAndSpaces() {
        let xs = [a("1", serial: " ab12 ")]
        #expect(matchLocal(xs, " AB12 ").matches.map(\.matched) == [["serial"]])
    }

    @Test func rfidMatchesPaddedOrNot() {
        let xs = [a("1", rfid: "000000000000000000100418")]
        #expect(matchLocal(xs, "100418").matches.count == 1)
        #expect(matchLocal(xs, "000000000000000000100418").matches.map(\.matched) == [["rfid"]])
    }

    @Test func oneValueOnTwoDevicesListsBothWithKinds() {
        let xs = [a("A", tag: "102466", name: "A"), a("B", name: "B", rfid: "000000000000000000102466")]
        let r = matchLocal(xs, "102466")
        #expect(r.matches.count == 2)
        #expect(r.matches[0].matched == ["asset_tag"])
        #expect(r.matches[1].matched == ["rfid"])
    }

    @Test func nameFallbackOnlyWithoutExactHit() {
        let xs = [a("1", name: "Switch 55", serial: "SW55"), a("2", name: "Router sw")]
        #expect(matchLocal(xs, "sw55").matches.map(\.matched) == [["serial"]])
        let n = matchLocal(xs, "sw")
        #expect(n.matches.count == 2)
        #expect(n.matches[0].matched == ["name"])
    }

    @Test func capAt25Truncates() {
        let xs = (1...30).map { a("\($0)", name: "Box \($0)") }
        let r = matchLocal(xs, "box")
        #expect(r.matches.count == 25)
        #expect(r.truncated)
        #expect(!matchLocal(Array(xs.prefix(25)), "box").truncated)
        #expect(LOOKUP_CAP == 25 && SCAN_LIMIT == 50)
    }

    @Test func sortsNaturally() {
        let xs = [a("1", name: "Rack 10"), a("2", name: "Rack 2")]
        #expect(matchLocal(xs, "rack").matches.map(\.name) == ["Rack 2", "Rack 10"])
    }

    /// Exact hits on the same name sort by asset tag, naturally.
    @Test func exactHitsBreakANameTieByAssetTag() {
        let xs = [a("1", tag: "10", name: "Same", serial: "S"), a("2", tag: "9", name: "Same", serial: "s")]
        #expect(matchLocal(xs, "s").matches.map(\.assetTag) == ["9", "10"])
    }

    @Test func emptyValueFindsNothing() {
        #expect(matchLocal([a("1", name: "x")], "   ").matches.isEmpty)
    }

    @Test func localDetailHidesFullBelowAdmin() {
        let x = a("1", tag: "5")
        let d = localDetail(x, data([x]), admin: false)
        #expect(d.full == nil)
        #expect(d.routes.count == 1)
        #expect(d.routes[0].source.siteName == "Src")
        #expect(d.routes[0].destination.siteName == "Dst")
        #expect(d.assetTag == "5")
    }

    @Test func localDetailAdminHasContainerNameNoTruckNoColor() throws {
        var x = a("1", tag: "5", container: "c1")
        x.assetStatus = "ok"; x.assetStatusLabel = "OK"; x.locationDetail = nil
        let f = try #require(localDetail(x, data([x]), admin: true).full)
        #expect(f.containerName == "Crate 7")
        #expect(f.truckName == nil)
        #expect(f.statusColor == "")
        #expect(f.status == "ok")
        #expect(f.locationDetail == "")
        #expect(f.moves.map(\.initiativeId) == ["m1"])
        #expect(f.moves.first?.status == "")
        let none = try #require(localDetail(x, data([x], moveId: ""), admin: true).full)
        #expect(none.moves.isEmpty)
    }

    /// The route's two ends carry the synced rack, RU, position and pod.
    @Test func localDetailRouteCarriesTheSyncedEnds() {
        var x = a("1")
        x.sourceRack = "R12"; x.sourceRu = "14"; x.sourcePod = "P1"
        x.destinationRack = "R40"; x.destinationPosition = "Shelf 3"
        let route = localDetail(x, data([x]), admin: false).routes[0]
        #expect(route.initiativeId == "m1" && route.initiativeName == "Move One")
        #expect(route.source == KioskAssetEnd(siteName: "Src", pod: "P1", rack: "R12", ru: "14", position: nil))
        #expect(route.destination == KioskAssetEnd(siteName: "Dst", pod: nil, rack: "R40", ru: nil, position: "Shelf 3"))
    }

    @Test func placementTextForms() {
        #expect(placementText(KioskAssetFull(containerName: "C", truckName: "T")) == "C · on T")
        #expect(placementText(KioskAssetFull(containerName: "C")) == "C")
        #expect(placementText(KioskAssetFull(locationDetail: "Dock")) == "Dock")
        #expect(placementText(KioskAssetFull()) == "")
    }

    @Test func scanWhenTextIs24Hour() throws {
        let utc = try #require(TimeZone(identifier: "UTC"))
        #expect(scanWhenText("2026-11-08T21:05:00Z", zone: utc) == "2026-11-08 21:05")
        #expect(scanWhenText("not a date", zone: utc) == "not a date")
        // the server's forms: microseconds and an offset
        #expect(scanWhenText("2026-11-08T21:05:59.123456Z", zone: utc) == "2026-11-08 21:05")
        #expect(scanWhenText("2026-11-08T21:05:00+00:00", zone: utc) == "2026-11-08 21:05")
        let chicago = try #require(TimeZone(identifier: "America/Chicago"))
        #expect(scanWhenText("2026-11-08T21:05:00Z", zone: chicago) == "2026-11-08 15:05")
    }

    @Test func matchLabels() {
        #expect(matchLabel("asset_tag") == "Asset tag")
        #expect(matchLabel("serial") == "Serial")
        #expect(matchLabel("rfid") == "RFID")
        #expect(matchLabel("name") == "Name")
        #expect(matchLabel("other") == "other")
    }

    // MARK: iOS: the rules the screen reads

    private func m(_ id: String, _ matched: [String]) -> KioskLookupMatch {
        KioskLookupMatch(id: id, name: id, assetTag: "", matched: matched)
    }

    /// One match opens; several list; none keeps the value and says so (Android's view model).
    @Test func anAnswerOpensListsOrMisses() {
        let one = LookupFound(offline: false, result: KioskLookupResult(matches: [m("a", ["serial"])]))
        #expect(lookupOutcome(one, shown: "SN-1") == .open(id: "a"))
        let two = KioskLookupResult(matches: [m("a", ["name"]), m("b", ["name"])], truncated: true)
        #expect(lookupOutcome(LookupFound(offline: true, result: two), shown: "x") == .list(two))
        let none = LookupFound(offline: false, result: KioskLookupResult())
        #expect(lookupOutcome(none, shown: "102466") == .miss("No asset matches 102466."))
        let offlineNone = LookupFound(offline: true, result: KioskLookupResult())
        #expect(lookupOutcome(offlineNone, shown: "102466") == .miss("No asset matches 102466."))
    }

    /// Offline with no synced move there is nothing to search: it says so (Android's Scanning
    /// words), never "No asset matches".
    @MainActor @Test func offlineWithNoSyncedMoveSaysSo() {
        let found = LookupFound(offline: true, result: KioskLookupResult(), noMoveData: true)
        #expect(lookupOutcome(found, shown: "102466") == .miss("No move data on this kiosk. Sync from Kiosk Setup."))
        #expect(LookupCopy.noMoveData == ScanViewModel.NO_MOVE_DATA)
    }

    @Test func theCopyIsAndroids() {
        #expect(LookupCopy.miss("A-1") == "No asset matches A-1.")
        #expect(LookupCopy.offlineNotice == "Offline — showing this move's devices only.")
        #expect(LookupCopy.scansOffline == "Scan history needs a connection.")
        #expect(LookupCopy.lookupError == "Couldn't look that up. Try again.")
        #expect(LookupCopy.loadError == "Couldn't load that asset.")
    }

    /// "Matched on" shows only when some match is not by name; its text names each key.
    @Test func matchedOnOnlyWhenAMatchIsNotByName() {
        #expect(!showsMatchedOn([m("a", ["name"]), m("b", ["name"])]))
        #expect(showsMatchedOn([m("a", ["name"]), m("b", ["asset_tag"])]))
        #expect(!showsMatchedOn([]))
        #expect(matchedOnText(m("a", ["asset_tag", "rfid"])) == "Asset tag, RFID")
    }

    /// History: an admin's card (full) for a device on a move, online, with scans:view.
    @Test func scanHistoryOnlyOnlineForAnAdminWithScansViewOnAMove() {
        let moves = KioskAssetFull(moves: [KioskAssetMove(initiativeId: "m1", initiativeName: "Move")])
        let onMove = KioskAssetDetail(id: "a", full: moves)
        #expect(wantsScanHistory(onMove, offline: false, canViewScans: true))
        #expect(!wantsScanHistory(onMove, offline: true, canViewScans: true))
        #expect(!wantsScanHistory(onMove, offline: false, canViewScans: false))
        #expect(!wantsScanHistory(KioskAssetDetail(id: "a", full: KioskAssetFull()), offline: false, canViewScans: true))
        #expect(!wantsScanHistory(KioskAssetDetail(id: "a"), offline: false, canViewScans: true))
    }

    /// A synced asset decodes from the server's raw row: unknown keys ignored, blanks default.
    @Test func aSyncedPayloadDecodes() throws {
        let row = #"{"id":"a1","asset_id":"A-1","name":"Core switch","rfid":null,"serial_number":"SN-100","make":"Dell","model":"R740","make_model":"Dell R740","container_id":"c1","source_rack":"R12","source_ru":"14","destination_rack":"R40","destination_ru":"20","asset_status":"staged","asset_status_label":"Staged","location_detail":"","extra_unknown":1,"label":{"x":"y"}}"#
        let x = try KioskJSON.decoder.decode(LocalAsset.self, from: Data(row.utf8))
        #expect(x.id == "a1" && x.assetId == "A-1" && x.name == "Core switch" && x.rfid == nil)
        #expect(x.serialNumber == "SN-100" && x.makeModel == "Dell R740" && x.containerId == "c1")
        #expect(x.sourceRack == "R12" && x.sourceRu == "14" && x.destinationRu == "20")
        #expect(x.assetStatus == "staged" && x.assetStatusLabel == "Staged" && x.locationDetail == "")
        let bare = try KioskJSON.decoder.decode(LocalAsset.self, from: Data(#"{"id":"b"}"#.utf8))
        #expect(bare.assetId == "" && bare.makeModel == "")
    }
}
