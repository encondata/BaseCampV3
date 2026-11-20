import Foundation

enum KioskBuildConfig {
    // DEV_API is set by tools/build_ipa.sh for the crew builds distributed
    // from devices.dev: an optimized Release build that still defaults to dev.
    // build_ipa.sh checks the app's binary for the dev URL below, so that
    // literal must appear nowhere else in the app.
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
