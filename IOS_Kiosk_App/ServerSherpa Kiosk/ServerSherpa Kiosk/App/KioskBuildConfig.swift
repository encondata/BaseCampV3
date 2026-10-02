import Foundation

enum KioskBuildConfig {
    #if DEBUG
    static let defaultApiUrl = "https://api.dev.serversherpa.com"
    #else
    static let defaultApiUrl = "https://api.serversherpa.com"
    #endif
    static let defaultPortalUrl = "https://portal.dev.serversherpa.com"
    static var kioskVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
