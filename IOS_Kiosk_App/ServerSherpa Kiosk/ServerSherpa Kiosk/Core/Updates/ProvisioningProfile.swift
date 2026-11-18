import Foundation

/// How this install was signed, read from the app's own `embedded.mobileprovision`.
/// The raw values are the wire values the devices service expects.
enum ProfileKind: String, Sendable, Equatable {
    case adhoc
    case development
    case none
}

/// Reads a provisioning profile (CMS-signed DER wrapping an XML plist). The signature is not
/// verified: the file ships inside the app bundle, so this only scans for the plist. Anything that
/// is not a complete plist reads as `.none`, never `.adhoc`.
func profileKind(fromMobileprovision data: Data?) -> ProfileKind {
    guard let data, isCompleteEnvelope(data),
          let start = data.range(of: Data("<?xml".utf8)),
          let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
          let plist = try? PropertyListSerialization.propertyList(
              from: data.subdata(in: start.lowerBound..<end.upperBound), options: [], format: nil),
          let dict = plist as? [String: Any]
    else { return .none }

    if let entitlements = dict["Entitlements"] as? [String: Any],
       entitlements["get-task-allow"] as? Bool == true {
        return .development
    }
    if let devices = dict["ProvisionedDevices"] as? [String], !devices.isEmpty {
        return .adhoc
    }
    return .none
}

/// A CMS envelope (DER/BER, leading 0x30) must be whole: the plist sits near the front, so a file
/// cut off partway can still hold a complete plist. Indefinite length ends with 00 00; definite
/// length must match the file size. Bare XML (no envelope) passes through.
private func isCompleteEnvelope(_ data: Data) -> Bool {
    let bytes = [UInt8](data)
    guard bytes.first == 0x30 else { return true }
    guard bytes.count >= 2 else { return false }
    let lengthByte = bytes[1]
    if lengthByte == 0x80 {
        return bytes.count >= 4 && bytes[bytes.count - 1] == 0 && bytes[bytes.count - 2] == 0
    }
    if lengthByte < 0x80 { return bytes.count == 2 + Int(lengthByte) }
    let lengthBytes = Int(lengthByte & 0x7f)
    guard lengthBytes <= 4, bytes.count >= 2 + lengthBytes else { return false }
    let length = bytes[2..<(2 + lengthBytes)].reduce(0) { $0 << 8 | Int($1) }
    return bytes.count == 2 + lengthBytes + length
}
