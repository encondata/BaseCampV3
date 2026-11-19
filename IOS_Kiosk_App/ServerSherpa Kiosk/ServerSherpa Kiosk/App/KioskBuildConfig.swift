import Foundation

enum KioskBuildConfig {
    // DEV_API is set by tools/build_ipa.sh for the crew builds distributed
    // from devices.dev: an optimized Release build that still defaults to dev.
    #if DEBUG || DEV_API
    static let defaultApiUrl = "https://api.dev.serversherpa.com"
    #else
    static let defaultApiUrl = "https://api.serversherpa.com"
    #endif
    static let defaultPortalUrl = "https://portal.dev.serversherpa.com"
    static var kioskVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
