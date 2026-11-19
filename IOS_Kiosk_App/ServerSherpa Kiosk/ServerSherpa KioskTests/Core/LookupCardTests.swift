import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// What Asset Lookup's card, list and history say (Android AssetLookupScreenTest's text checks, as
/// pure cases): who sees what on the card, RU or Position, the move names over two routes, the
/// blanks, the list's names, and a history row's words.
struct LookupCardTests {
    private let oneRoute = KioskAssetRoute(
        initiativeId: "m1", initiativeName: "Move One",
        source: KioskAssetEnd(siteName: "Site A", rack: "R12", ru: "14"),
        destination: KioskAssetEnd(siteName: "Site B", rack: "R40", ru: "22"))
    private var workerDetail: KioskAssetDetail {
        KioskAssetDetail(id: "a1", name: "Asset A", makeModel: "Make A", assetTag: "102466", serialNumber: "SN-100",
                         rfid: "000000000000000000100418", routes: [oneRoute])
    }
    private let adminFull = KioskAssetFull(
        status: "packed", statusLabel: "Packed", statusColor: "#22aa55",
        moves: [KioskAssetMove(initiativeId: "m1", initiativeName: "Move One", status: "packed", statusLabel: "Loaded", statusColor: "#3366ff")],
        containerName: "Container A", truckName: "Truck A")

    @Test func aWorkersCardShowsIdentityOnly() {
        let facts = lookupIdentityFacts(workerDetail)
        #expect(facts.map(\.label) == ["Asset tag", "Serial", "RFID"])
        #expect(facts.map(\.value) == ["102466", "SN-100", "100418"])     // the RFID in display form
        #expect(facts.map(\.mono) == [true, true, true])
        #expect(!lookupShowsRouteTitles(workerDetail), "one route: no move name above it")
    }

    @Test func anAdminsCardAddsTheCurrentLocation() {
        var d = workerDetail
        d.full = adminFull
        let facts = lookupIdentityFacts(d)
        #expect(facts.map(\.label) == ["Asset tag", "Serial", "RFID", "Current location"])
        #expect(facts.last?.value == "Container A · on Truck A")
        #expect(facts.last?.mono == false)

        d.full = KioskAssetFull(locationDetail: "Cage 4")
        #expect(lookupIdentityFacts(d).last?.value == "Cage 4")
        d.full = KioskAssetFull()
        #expect(lookupIdentityFacts(d).last?.value == "—")
    }

    @Test func blanksShowADash() {
        let d = KioskAssetDetail(id: "a1", assetTag: " ", serialNumber: nil, rfid: "")
        #expect(lookupIdentityFacts(d).map(\.value) == ["—", "—", "—"])
        #expect(lookupName(nil) == "Unnamed asset")
        #expect(lookupName("  ") == "Unnamed asset")
        #expect(lookupName("Asset A") == "Asset A")
        #expect(lookupText(nil) == "—" && lookupText("") == "—" && lookupText(" x ") == " x ")
    }

    /// Source and Destination: Site, Rack, then RU, or Position when there is no RU. No Pod.
    @Test func routeEndsShowRuOrPosition() {
        let ru = lookupEndFacts(KioskAssetEnd(siteName: "Site A", pod: "P1", rack: "R12", ru: "14", position: "Left"))
        #expect(ru.map(\.label) == ["Site", "Rack", "RU"])
        #expect(ru.map(\.value) == ["Site A", "R12", "14"])
        #expect(ru.map(\.mono) == [false, true, true])

        let position = lookupEndFacts(KioskAssetEnd(siteName: "Site B", rack: "R40", ru: " ", position: "Right"))
        #expect(position.map(\.label) == ["Site", "Rack", "Position"])
        #expect(position.last?.value == "Right")

        let blank = lookupEndFacts(KioskAssetEnd())
        #expect(blank.map(\.label) == ["Site", "Rack", "RU"])
        #expect(blank.map(\.value) == ["—", "—", "—"])
    }

    @Test func moveNamesShowOverTwoRoutes() {
        var d = workerDetail
        d.routes.append(KioskAssetRoute(initiativeId: "m2", initiativeName: "Move Two",
                                        source: KioskAssetEnd(siteName: "Site B"), destination: KioskAssetEnd(siteName: "Site C")))
        #expect(lookupShowsRouteTitles(d))
    }

    /// The list's facts: Asset tag and Serial, then "Matched on" only when the list shows it.
    @Test func matchFacts() {
        let m = KioskLookupMatch(id: "a1", name: nil, assetTag: "", serialNumber: "SN-1", matched: ["asset_tag", "rfid"])
        #expect(lookupMatchFacts(m, showMatched: false).map(\.label) == ["Asset tag", "Serial"])
        let shown = lookupMatchFacts(m, showMatched: true)
        #expect(shown.map(\.label) == ["Asset tag", "Serial", "Matched on"])
        #expect(shown.map(\.value) == ["—", "SN-1", "Asset tag, RFID"])
        #expect(shown.last?.mono == false)
    }

    @Test func historyLineWords() {
        let row = AssetScanRow(id: "s1", scanTypeLabel: " ", status: "packed", statusLabel: "", scannedAt: "nope", deviceId: " ",
                               operatorName: "", siteName: nil, offMove: true)
        let line = LookupScanLine(row, zone: TimeZone(identifier: "UTC")!)
        #expect(line.status == nil && line.method == nil)
        #expect(line.when == "nope", "an unreadable time shows as sent")
        #expect(line.device == "—" && line.operatorName == "—" && line.site == "—")
        #expect(line.offMove)
    }

    @Test func screenCopyIsAndroids() {
        #expect(LookupCopy.placeholder == "Asset tag, serial, RFID, or name")
        #expect(LookupCopy.scanHistory == "Scan history")
        #expect(LookupCopy.scansLoading == "Loading…")
        #expect(LookupCopy.scansFailed == "Could not load scan history.")
        #expect(LookupCopy.noScans == "No scans recorded for this asset.")
        #expect(LookupCopy.latestScans == "Latest 50 scans shown.")
        #expect(LookupCopy.refine == "Refine your search")
        #expect(LookupCopy.unnamed == "Unnamed asset")
        #expect(LookupCopy.finishSetup == "Finish Kiosk Setup first.")
    }
}
