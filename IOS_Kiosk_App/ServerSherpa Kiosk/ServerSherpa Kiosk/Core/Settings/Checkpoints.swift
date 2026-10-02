import Foundation

/// The checkpoints the non-scanning screens record; keys and defaults
/// from kiosk/src/lib/checkpointSettings.ts. Only `enroll` has a UI here.
enum CheckpointId: CaseIterable, Sendable {
    case enroll, containerPack, containerUnpack, truckLoad, truckUnload

    var storageKey: String {
        switch self {
        case .enroll: "ss.kiosk.enrollStatus"
        case .containerPack: "ss.kiosk.containerPackStatus"
        case .containerUnpack: "ss.kiosk.containerUnpackStatus"
        case .truckLoad: "ss.kiosk.truckLoadStatus"
        case .truckUnload: "ss.kiosk.truckUnloadStatus"
        }
    }

    var fallback: String {
        switch self {
        case .enroll: "pre_stage"
        case .containerPack: "in_container"
        case .containerUnpack: "un_pack"
        case .truckLoad: "on_truck"
        case .truckUnload: "received"
        }
    }

    var label: String {
        switch self {
        case .enroll: "RFID Enroll checkpoint"
        case .containerPack: "Container pack checkpoint"
        case .containerUnpack: "Container unpack checkpoint"
        case .truckLoad: "Truck load checkpoint"
        case .truckUnload: "Truck unload checkpoint"
        }
    }
}

/// The stored key, or the default when the portal no longer offers it.
/// An empty `offered` means the options have not loaded — the stored key stands.
func effectiveCheckpoint(_ id: CheckpointId, stored: String, offered: [String]) -> String {
    if offered.isEmpty { return stored }
    return offered.contains(stored) ? stored : id.fallback
}
