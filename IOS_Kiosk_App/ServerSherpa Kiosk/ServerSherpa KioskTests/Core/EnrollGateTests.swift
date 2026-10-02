import Testing
@testable import ServerSherpa_Kiosk

private struct Row: ScanAsset, Equatable {
    var id: String
    var assetId: String
    var name: String? = nil
    var rfid: String? = nil
    var serialNumber: String? = nil
    var makeModel: String = ""
}

struct EnrollGateTests {
    private let rack = Row(id: "a1", assetId: "A-1", name: "Rack", rfid: nil, serialNumber: "SN1", makeModel: "Dell")
    private let tagged = Row(id: "a2", assetId: "A-2", name: "Tagged rack", rfid: "000000000000000000100348", serialNumber: "SN2", makeModel: "HP")
    private var index: ScanIndex<Row> { buildScanIndex([rack, tagged]) }

    @Test func aFreeTagOnAnUntaggedAssetPasses() {
        #expect(checkEnrollTag(index: index, log: [], target: rack, padded: "000000000000000000100349") == nil)
    }

    /// The double scan: the same tag waved at the asset that already wears it.
    @Test func theTagAnAssetAlreadyWearsIsRefused() {
        let v = checkEnrollTag(index: index, log: [], target: tagged, padded: "000000000000000000100348")
        #expect(v?.issue == .sameTagOnThisAsset)
        #expect(enrollTagText(v!) == "That tag is already on this asset.")
    }

    /// Padding must not hide a repeat.
    @Test func paddingDoesNotHideARepeat() {
        #expect(checkEnrollTag(index: index, log: [], target: tagged, padded: "100348")?.issue == .sameTagOnThisAsset)
    }

    @Test func aTagTheRosterPutsOnAnotherAssetIsRefused() {
        let v = checkEnrollTag(index: index, log: [], target: rack, padded: "100348")
        #expect(v?.issue == .tagOnAnotherAsset)
        #expect(enrollTagText(v!) == "That tag is on Tagged rack. Scan a different tag.")
    }

    /// The session log is the fresher of the two.
    @Test func aTagUsedThisSessionIsRefusedEvenWithAStaleRoster() {
        let log = [EnrollLogEntry(assetRowId: "a9", tag: "000000000000000000100349", assetName: "Other rack")]
        let v = checkEnrollTag(index: index, log: log, target: rack, padded: "100349")
        #expect(v?.issue == .tagUsedThisSession)
        #expect(enrollTagText(v!) == "You just enrolled that tag on Other rack. Scan a different tag.")
    }

    @Test func theSessionLogSaysWhatThisKioskDidToAnAsset() {
        let log = [EnrollLogEntry(assetRowId: "a1", tag: "000000000000000000100349", assetName: "Rack")]
        #expect(enrolledThisSession(log, assetRowId: "a1")?.tag == "000000000000000000100349")
        #expect(enrolledThisSession(log, assetRowId: "a2") == nil)
    }

    /// Re-reading the same tag onto the same asset is a repeat, not a conflict.
    @Test func theAssetsOwnTagIsNotReportedAsAConflict() {
        #expect(checkEnrollTag(index: index, log: [], target: tagged, padded: "0100348")?.issue == .sameTagOnThisAsset)
    }
}
