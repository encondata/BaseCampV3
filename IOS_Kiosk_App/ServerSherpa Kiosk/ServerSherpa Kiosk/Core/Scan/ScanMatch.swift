import Foundation

/// What matching needs from an asset row (the synced `KioskAssetRow`
/// provides these).
protocol ScanAsset {
    var id: String { get }
    var assetId: String { get }
    var name: String? { get }
    var rfid: String? { get }
    var serialNumber: String? { get }
    var makeModel: String { get }
}

extension KioskAssetRow: ScanAsset {}

enum ScanMatchKind: Sendable { case rfid, assetId, serial }

struct ScanMatch<A: ScanAsset> {
    var kind: ScanMatchKind
    var asset: A
}

struct ScanIndex<A: ScanAsset> {
    var byRfid: [String: A]
    var byAssetId: [String: A]
    var bySerial: [String: A]
    var size: Int
}

extension ScanMatch: Sendable where A: Sendable {}
extension ScanIndex: Sendable where A: Sendable {}

private func key(_ value: String?) -> String? {
    guard let value else { return nil }
    let k = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    return k.isEmpty ? nil : k
}

/// Zero-padding stripped, upper-cased — so a handheld that pads the EPC
/// and a fixed reader that doesn't land on the same asset.
func rfidKey(_ value: String?) -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return key(displayRfid(value.trimmingCharacters(in: .whitespacesAndNewlines)))
}

/// First row wins on a duplicate key, as in scanMatch.ts.
func buildScanIndex<A: ScanAsset>(_ assets: [A]) -> ScanIndex<A> {
    var byRfid: [String: A] = [:]
    var byAssetId: [String: A] = [:]
    var bySerial: [String: A] = [:]
    for asset in assets {
        if let k = rfidKey(asset.rfid), byRfid[k] == nil { byRfid[k] = asset }
        if let k = key(asset.assetId), byAssetId[k] == nil { byAssetId[k] = asset }
        if let k = key(asset.serialNumber), bySerial[k] == nil { bySerial[k] = asset }
    }
    return ScanIndex(byRfid: byRfid, byAssetId: byAssetId, bySerial: bySerial, size: assets.count)
}

/// RFID first (the readers), then asset ID (the labels), then serial.
func matchScan<A: ScanAsset>(_ index: ScanIndex<A>, _ raw: String) -> ScanMatch<A>? {
    guard let plain = key(raw) else { return nil }
    if let k = rfidKey(raw), let a = index.byRfid[k] { return ScanMatch(kind: .rfid, asset: a) }
    if let a = index.byAssetId[plain] { return ScanMatch(kind: .assetId, asset: a) }
    if let a = index.bySerial[plain] { return ScanMatch(kind: .serial, asset: a) }
    return nil
}

/// Asset ID or serial only — RFID Enroll's first step, where a tag read
/// must not silently pick "re-tag that asset".
func matchAssetOrSerial<A: ScanAsset>(_ index: ScanIndex<A>, _ raw: String) -> ScanMatch<A>? {
    guard let plain = key(raw) else { return nil }
    if let a = index.byAssetId[plain] { return ScanMatch(kind: .assetId, asset: a) }
    if let a = index.bySerial[plain] { return ScanMatch(kind: .serial, asset: a) }
    return nil
}

/// The ingest endpoint's `scan_type`.
func scanTypeFor(_ kind: ScanMatchKind) -> String { kind == .rfid ? "rfid" : "barcode" }
