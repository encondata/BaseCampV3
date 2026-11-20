import UIKit

/// What copy calls this device: "iPad" on an iPad, else "iPhone".
@MainActor func currentDeviceNoun() -> String {
    UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
}
