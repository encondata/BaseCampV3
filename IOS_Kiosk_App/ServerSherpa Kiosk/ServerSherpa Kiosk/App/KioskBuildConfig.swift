import Foundation

enum KioskBuildConfig {
    // The environment a kiosk connects to until one is saved: Dev in debug builds, Prod in
    // release builds. DEV_API is set by tools/build_ipa.sh for the crew builds distributed from
    // devices.dev: an optimized Release build that still defaults to Dev.
    #if DEBUG || DEV_API
    static let defaultEnvironmentId = "dev"
    #else
    static let defaultEnvironmentId = "prod"
    #endif

    /// The built-in environment `defaultEnvironmentId` names (a build with an id that isn't built
    /// in stops at launch).
    static var defaultEnvironment: SavedEnvironment {
        guard let env = Environments.byId(defaultEnvironmentId) else {
            preconditionFailure("defaultEnvironmentId \(defaultEnvironmentId) isn't a built-in environment")
        }
        return env.asSaved
    }

    static var kioskVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
