import Testing
@testable import ServerSherpa_Kiosk

private struct TestAsset: ScanAsset, Equatable {
    var id: String
    var assetId: String
    var name: String? = nil
    var rfid: String? = nil
    var serialNumber: String? = nil
    var makeModel: String = ""
}

struct ScanMatchTests {
    private let rack = TestAsset(id: "1", assetId: "A-100", name: "Rack", rfid: "000000000000000000100348", serialNumber: "SN-1")
    private let server = TestAsset(id: "2", assetId: "A-200", name: "Server", rfid: nil, serialNumber: "sn-2")

    @Test func rfidThenAssetIdThenSerial() {
        let index = buildScanIndex([rack, server])
        #expect(matchScan(index, "100348")?.kind == .rfid)
        #expect(matchScan(index, "000000000000000000100348")?.kind == .rfid)
        #expect(matchScan(index, "a-100")?.asset.id == "1")
        #expect(matchScan(index, "a-100")?.kind == .assetId)
        #expect(matchScan(index, "SN-2")?.kind == .serial)
        #expect(matchScan(index, "nothing") == nil)
        #expect(matchScan(index, "   ") == nil)
    }

    @Test func firstRowWinsOnDuplicateKeys() {
        let dup = TestAsset(id: "9", assetId: "A-100", name: "Other")
        let i = buildScanIndex([rack, dup])
        #expect(matchScan(i, "A-100")?.asset.id == "1")
        #expect(i.size == 2)
    }

    @Test func assetOrSerialNeverMatchesByTag() {
        let index = buildScanIndex([rack, server])
        #expect(matchAssetOrSerial(index, "100348") == nil)
        #expect(matchAssetOrSerial(index, "A-100")?.kind == .assetId)
        #expect(matchAssetOrSerial(index, "sn-1")?.kind == .serial)
    }

    @Test func scanTypeWire() {
        #expect(scanTypeFor(.rfid) == "rfid")
        #expect(scanTypeFor(.assetId) == "barcode")
        #expect(scanTypeFor(.serial) == "barcode")
    }

    @Test func anRfidMatchSendsTheStoredTagAndEverythingElseSendsTheValueAsScanned() throws {
        let rack = KioskAssetRow(id: "r1", assetId: "A-1", rfid: "000000000000000000100348", serialNumber: "SN-1")
        let index = buildScanIndex([rack])
        // The portal's RFID match is exact, so a label's short form must go out as the full tag.
        let tag = try #require(matchScan(index, "100348"))
        #expect(sentScanValue(tag, "100348") == "000000000000000000100348")
        let serial = try #require(matchScan(index, "SN-1"))
        #expect(sentScanValue(serial, "SN-1") == "SN-1")
        let id = try #require(matchScan(index, "a-1"))
        #expect(sentScanValue(id, "a-1") == "a-1")
        // A tag match with no stored tag can't happen, but never send an empty value.
        let untagged = KioskAssetRow(id: "r2", assetId: "A-2", rfid: "  ")
        #expect(sentScanValue(ScanMatch(kind: .rfid, asset: untagged), "100348") == "100348")
    }

    @Test func syncedAssetRowIsAScanAsset() {
        let row = KioskAssetRow(id: "r1", assetId: "A-1", rfid: "000000000000000000100348")
        let index = buildScanIndex([row])
        #expect(matchScan(index, "100348")?.asset.id == "r1")
    }
}
