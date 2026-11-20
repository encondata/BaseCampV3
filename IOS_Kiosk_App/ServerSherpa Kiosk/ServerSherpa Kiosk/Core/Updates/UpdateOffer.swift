import Foundation

/// The Devices site lives next to the API: `api.<rest>` becomes `devices.<rest>`.
/// Scheme and port are kept, path dropped. Any other host (localhost, an IP,
/// `portal.…`) has no Devices site we can derive, so nil.
func devicesBaseUrl(apiUrl: String) -> String? {
    guard var parts = URLComponents(string: apiUrl.trimmingCharacters(in: .whitespaces)),
          let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = parts.host else { return nil }
    var labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard labels.count >= 2, labels[0].lowercased() == "api" else { return nil }
    labels[0] = "devices"
    parts.host = labels.joined(separator: ".")
    parts.path = ""
    parts.query = nil
    parts.fragment = nil
    parts.user = nil
    parts.password = nil
    return parts.string
}

/// `GET /api/updates` answer. Wire names are spelled in CodingKeys.
struct UpdateAnswer: Decodable, Equatable, Sendable {
    var status: String
    var versionName: String?
    var build: String?
    var notes: String?
    var installUrl: String?
    var message: String?
    var size: Int?

    enum CodingKeys: String, CodingKey {
        case status, build, notes, message, size
        case versionName = "version_name"
        case installUrl = "install_url"
    }
}

enum UpdateOffer: Equatable, Sendable {
    case upToDate
    case available(version: String, build: String?, notes: String?, size: Int?, installUrl: URL)
    case registerFirst(message: String)
    case waiting(message: String)

    var showsOnHome: Bool {
        switch self {
        case .available, .registerFirst: return true
        case .upToDate, .waiting: return false
        }
    }
}

/// `device` is what this device is called in copy ("iPad" or "iPhone"); Core can't ask UIKit,
/// so the caller passes it.
func updateOffer(_ answer: UpdateAnswer, profile: ProfileKind, devicesUrl: String,
                 device: String) -> UpdateOffer {
    func registerFirstMessage() -> String {
        let host = URLComponents(string: devicesUrl)?.host ?? devicesUrl
        return "Add this \(device) on \(host) first."
    }
    switch answer.status {
    case "up_to_date":
        return .upToDate
    case "available":
        guard profile == .adhoc else { return .registerFirst(message: registerFirstMessage()) }
        // Only a real itms-services link may ever be opened.
        guard let raw = answer.installUrl, let url = URL(string: raw),
              url.scheme?.lowercased() == "itms-services" else {
            return .waiting(message: "This update's install link isn't valid. Check again later.")
        }
        return .available(version: answer.versionName ?? answer.build ?? "a new version",
                          build: answer.build, notes: answer.notes, size: answer.size, installUrl: url)
    case "register_first":
        return .registerFirst(message: answer.message ?? registerFirstMessage())
    case "preparing", "not_set_up":
        return .waiting(message: answer.message ?? "The update isn't ready yet. Check again later.")
    default:
        return .waiting(message: answer.message ?? "The Devices site sent an answer this app doesn't know.")
    }
}

struct UpdateQuery: Equatable, Sendable {
    var bundleId: String
    var build: String
    var profile: ProfileKind

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "platform", value: "ios"),
         URLQueryItem(name: "bundle_id", value: bundleId),
         URLQueryItem(name: "build", value: build),
         URLQueryItem(name: "profile_kind", value: profile.rawValue)]
    }
}
