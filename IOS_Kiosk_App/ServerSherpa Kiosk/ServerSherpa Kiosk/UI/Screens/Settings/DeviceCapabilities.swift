import GameController

/// Read-only facts about which scan inputs this device has (Android DevicesPanel, minus Zebra).
struct DeviceCapabilities: Equatable {
    var camera: String
    var torch: String
    var keyboard: String

    static func cameraText(hasBack: Bool, hasFront: Bool) -> String {
        switch (hasBack, hasFront) {
        case (true, true): "Back and front cameras"
        case (true, false): "Back camera"
        case (false, true): "Front camera"
        case (false, false): "No camera on this device"
        }
    }

    static func torchText(hasTorch: Bool) -> String {
        hasTorch ? "Available on the back camera" : "No torch on this device"
    }

    static func keyboardText(attached: Bool) -> String {
        attached ? "A hardware keyboard is attached" : "None attached right now"
    }

    /// The back/front choice only means something when there are two cameras.
    static func offersCameraChoice(hasBack: Bool, hasFront: Bool) -> Bool { hasBack && hasFront }

    static func make(hasBack: Bool, hasFront: Bool, hasTorch: Bool, keyboardAttached: Bool) -> DeviceCapabilities {
        DeviceCapabilities(camera: cameraText(hasBack: hasBack, hasFront: hasFront),
                           torch: torchText(hasTorch: hasTorch),
                           keyboard: keyboardText(attached: keyboardAttached))
    }

    static func current() -> DeviceCapabilities {
        make(hasBack: CameraSupport.hasBackCamera, hasFront: CameraSupport.hasFrontCamera,
             hasTorch: CameraSupport.hasTorch, keyboardAttached: GCKeyboard.coalesced != nil)
    }
}
