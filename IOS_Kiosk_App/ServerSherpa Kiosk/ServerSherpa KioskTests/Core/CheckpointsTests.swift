import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct CheckpointsTests {
    @Test func defaultsMatchTheWebKiosk() {
        #expect(CheckpointId.enroll.fallback == "pre_stage")
        #expect(CheckpointId.containerPack.fallback == "in_container")
        #expect(CheckpointId.containerUnpack.fallback == "un_pack")
        #expect(CheckpointId.truckLoad.fallback == "on_truck")
        #expect(CheckpointId.truckUnload.fallback == "received")
        #expect(CheckpointId.enroll.storageKey == "ss.kiosk.enrollStatus")
        #expect(CheckpointId.truckUnload.label == "Truck unload checkpoint")
    }

    @Test func effectiveFallsBackOnlyWhenOfferedAndMissing() {
        #expect(effectiveCheckpoint(.enroll, stored: "custom", offered: []) == "custom")
        #expect(effectiveCheckpoint(.enroll, stored: "custom", offered: ["custom", "pre_stage"]) == "custom")
        #expect(effectiveCheckpoint(.enroll, stored: "retired", offered: ["pre_stage"]) == "pre_stage")
    }
}
