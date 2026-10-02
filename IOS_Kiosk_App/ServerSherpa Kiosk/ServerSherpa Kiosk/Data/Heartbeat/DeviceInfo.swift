import Foundation
import UIKit

enum DeviceInfo {
    /// The heartbeat's `raw_info`. `model` is the hardware identifier (e.g. "iPad14,8").
    @MainActor static func rawInfo() -> [String: String] {
        let device = UIDevice.current
        return [
            "manufacturer": "Apple",
            "model": modelIdentifier(),
            "system_name": device.systemName,
            "system_version": device.systemVersion,
            "idiom": device.userInterfaceIdiom == .pad ? "ipad" : "phone",
        ]
    }

    private static func modelIdentifier() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty { return simulated }
        var info = utsname()
        uname(&info)
        return withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
        }
    }
}
