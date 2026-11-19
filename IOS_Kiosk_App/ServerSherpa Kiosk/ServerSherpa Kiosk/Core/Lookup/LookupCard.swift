import Foundation

// What Asset Lookup's screen says (Android `AssetLookupScreen.kt`): the card's facts, a route end,
// the list's facts and a scan-history row, as plain text the screen lays out. Blank values read "—".

/// A blank value on the card, in the list and in the scan history.
let LOOKUP_BLANK = "—"

/// The screen's own words, Android's exactly.
extension LookupCopy {
    static let placeholder = "Asset tag, serial, RFID, or name"
    static let finishSetup = "Finish Kiosk Setup first."
    static let unnamed = "Unnamed asset"
    static let refine = "Refine your search"
    static let scanHistory = "Scan history"
    static let scansLoading = "Loading…"
    static let scansFailed = "Could not load scan history."
    static let noScans = "No scans recorded for this asset."
    static let latestScans = "Latest \(SCAN_LIMIT) scans shown."
}

/// A label over its value (the web's dt/dd). `mono`: an identifier, set in the mono face.
struct LookupFact: Equatable, Sendable, Identifiable {
    let label: String
    let value: String
    var mono = true
    var id: String { label }
}

/// The value as sent, or "—" when it is missing or blank.
func lookupText(_ s: String?) -> String {
    guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return LOOKUP_BLANK }
    return s
}

/// An asset's name, or "Unnamed asset".
func lookupName(_ name: String?) -> String {
    guard let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return LookupCopy.unnamed }
    return name
}

/// The card's identity line: Asset tag, Serial and RFID (display form, unpadded) for everyone;
/// an admin's card (`full`) adds Current location ("<container> · on <truck>", else the location text).
func lookupIdentityFacts(_ d: KioskAssetDetail) -> [LookupFact] {
    let rfid = lookupText(d.rfid)
    var facts = [
        LookupFact(label: "Asset tag", value: lookupText(d.assetTag)),
        LookupFact(label: "Serial", value: lookupText(d.serialNumber)),
        LookupFact(label: "RFID", value: rfid == LOOKUP_BLANK ? rfid : displayRfid(rfid)),
    ]
    if let full = d.full { facts.append(LookupFact(label: "Current location", value: lookupText(placementText(full)), mono: false)) }
    return facts
}

/// One end of a route: Site, Rack, then RU, or Position when there is no RU. No Pod.
func lookupEndFacts(_ end: KioskAssetEnd) -> [LookupFact] {
    let noRu = lookupText(end.ru) == LOOKUP_BLANK
    let position = lookupText(end.position)
    return [
        LookupFact(label: "Site", value: lookupText(end.siteName), mono: false),
        LookupFact(label: "Rack", value: lookupText(end.rack)),
        noRu && position != LOOKUP_BLANK ? LookupFact(label: "Position", value: position) : LookupFact(label: "RU", value: lookupText(end.ru)),
    ]
}

/// Each route's move name shows above it only when the device is on more than one move.
func lookupShowsRouteTitles(_ d: KioskAssetDetail) -> Bool { d.routes.count >= 2 }

/// A list row's facts: Asset tag, Serial, and "Matched on" when the list shows it (`showsMatchedOn`).
func lookupMatchFacts(_ m: KioskLookupMatch, showMatched: Bool) -> [LookupFact] {
    var facts = [LookupFact(label: "Asset tag", value: lookupText(m.assetTag)), LookupFact(label: "Serial", value: lookupText(m.serialNumber))]
    if showMatched { facts.append(LookupFact(label: "Matched on", value: matchedOnText(m), mono: false)) }
    return facts
}

/// One scan-history row as the screen shows it, formatted once when the rows load (the time's
/// formatters are built per call, so never per render). A nil status or method shows "—".
struct LookupScanLine: Equatable, Sendable, Identifiable {
    let id: String
    let status: String?
    let statusColor: String?
    let offMove: Bool
    /// `yyyy-MM-dd HH:mm`, 24-hour.
    let when: String
    let method: String?
    let methodColor: String
    let device: String
    let operatorName: String
    let site: String
}

extension LookupScanLine {
    init(_ row: AssetScanRow, zone: TimeZone) {
        let status = lookupText(row.statusLabel)
        let method = lookupText(row.scanTypeLabel)
        self.init(id: row.id, status: status == LOOKUP_BLANK ? nil : status, statusColor: row.statusColor, offMove: row.offMove,
                  when: scanWhenText(row.scannedAt, zone: zone), method: method == LOOKUP_BLANK ? nil : method,
                  methodColor: row.scanTypeColor, device: lookupText(row.deviceId), operatorName: lookupText(row.operatorName),
                  site: lookupText(row.siteName))
    }
}
