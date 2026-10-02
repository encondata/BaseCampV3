import AVFoundation
import Testing
@testable import ServerSherpa_Kiosk

struct CameraStartGateTests {
    @Test func startsOnlyWhenAuthorizedAndActive() {
        #expect(CameraStartGate.canStart(status: .authorized, isActive: true))
        #expect(!CameraStartGate.canStart(status: .authorized, isActive: false))
        #expect(!CameraStartGate.canStart(status: .denied, isActive: true))
        #expect(!CameraStartGate.canStart(status: .notDetermined, isActive: true))
        #expect(!CameraStartGate.canStart(status: .restricted, isActive: true))
    }
}
