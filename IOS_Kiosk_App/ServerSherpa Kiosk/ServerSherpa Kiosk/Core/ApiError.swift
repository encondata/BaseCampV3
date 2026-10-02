import Foundation

/// A non-2xx answer (`code` from the body's `detail.code`, else
/// `unknown_error`) or a transport failure (`status` 0, code `network`).
struct ApiError: Error, Equatable, Sendable {
    let status: Int
    let code: String
    /// The string-valued members of an object `detail`.
    let detail: [String: String]

    init(status: Int, code: String, detail: [String: String] = [:]) {
        self.status = status
        self.code = code
        self.detail = detail
    }

    var isNetwork: Bool { status == 0 }

    /// `detail.<key>` when the detail is an object with a string there.
    func detailString(_ key: String) -> String? { detail[key] }

    static func network() -> ApiError { ApiError(status: 0, code: "network") }

    static func from(status: Int, body: Data) -> ApiError {
        guard let root = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let detail = root["detail"] else {
            return ApiError(status: status, code: "unknown_error")
        }
        if let text = detail as? String {
            return ApiError(status: status, code: text)
        }
        if let object = detail as? [String: Any] {
            var strings: [String: String] = [:]
            for (key, value) in object { if let s = value as? String { strings[key] = s } }
            return ApiError(status: status, code: strings["code"] ?? "unknown_error", detail: strings)
        }
        return ApiError(status: status, code: "unknown_error")
    }
}
