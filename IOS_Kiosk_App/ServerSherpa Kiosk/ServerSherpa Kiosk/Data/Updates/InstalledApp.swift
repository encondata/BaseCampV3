import Foundation

/// This install as the update check describes it: the bundle id, the version and build iOS shows,
/// and how it was signed (its own `embedded.mobileprovision`; none when the bundle has no profile,
/// as an App Store, TestFlight or test-host build).
struct InstalledApp: Equatable, Sendable {
    var bundleId: String
    var versionName: String
    var build: String
    var profile: ProfileKind

    static func current(bundle: Bundle = .main) -> InstalledApp {
        let info = bundle.infoDictionary ?? [:]
        let profile = bundle.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
        return InstalledApp(bundleId: bundle.bundleIdentifier ?? info["CFBundleIdentifier"] as? String ?? "",
                            versionName: info["CFBundleShortVersionString"] as? String ?? "",
                            build: info["CFBundleVersion"] as? String ?? "",
                            profile: profileKind(fromMobileprovision: profile))
    }

    var query: UpdateQuery { UpdateQuery(bundleId: bundleId, build: build, profile: profile) }
}
