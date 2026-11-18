#if DEBUG
import Foundation

/// UI tests and simulator checks pass `-uiTestUpdate <available|register_first|preparing|up_to_date>`:
/// the update check answers this sample at once, with no server (no devices service is reachable
/// from the simulator).
struct SampleDevicesApi: DevicesApi {
    var status: String

    static let launchArgument = "-uiTestUpdate"

    /// The status after `-uiTestUpdate` in `arguments`; nil without the flag.
    static func status(in arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
        guard let i = arguments.firstIndex(of: launchArgument), arguments.indices.contains(i + 1) else { return nil }
        return arguments[i + 1]
    }

    func checkUpdates(_ query: UpdateQuery) async throws -> UpdateAnswer {
        guard status == "available" else { return UpdateAnswer(status: status) }
        return UpdateAnswer(status: "available", versionName: "1.2.0", build: "7",
                            notes: "Faster sync.\nFixes the scan box on iPhone.",
                            installUrl: "itms-services://?action=download-manifest&url=https%3A%2F%2Fdevices.dev.serversherpa.com%2Fota%2Fsample%2Fmanifest.plist",
                            size: 48_200_000)
    }
}
#endif
