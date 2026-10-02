import Testing
@testable import ServerSherpa_Kiosk

struct DeviceCapabilitiesTests {
    @Test func cameraStrings() {
        #expect(DeviceCapabilities.cameraText(hasBack: true, hasFront: true) == "Back and front cameras")
        #expect(DeviceCapabilities.cameraText(hasBack: true, hasFront: false) == "Back camera")
        #expect(DeviceCapabilities.cameraText(hasBack: false, hasFront: true) == "Front camera")
        #expect(DeviceCapabilities.cameraText(hasBack: false, hasFront: false) == "No camera on this device")
    }

    @Test func torchStrings() {
        #expect(DeviceCapabilities.torchText(hasTorch: true) == "Available on the back camera")
        #expect(DeviceCapabilities.torchText(hasTorch: false) == "No torch on this device")
    }

    @Test func keyboardStrings() {
        #expect(DeviceCapabilities.keyboardText(attached: true) == "A hardware keyboard is attached")
        #expect(DeviceCapabilities.keyboardText(attached: false) == "None attached right now")
    }

    @Test func currentComposesTheThreeLines() {
        let c = DeviceCapabilities.make(hasBack: true, hasFront: false, hasTorch: true, keyboardAttached: false)
        #expect(c == DeviceCapabilities(camera: "Back camera", torch: "Available on the back camera", keyboard: "None attached right now"))
    }

    @Test func choosingCameraPositionNeedsBothCameras() {
        #expect(DeviceCapabilities.offersCameraChoice(hasBack: true, hasFront: true))
        #expect(!DeviceCapabilities.offersCameraChoice(hasBack: true, hasFront: false))
        #expect(!DeviceCapabilities.offersCameraChoice(hasBack: false, hasFront: false))
    }
}
