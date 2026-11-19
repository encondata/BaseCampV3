import Foundation

/// The Devices site's update check.
protocol DevicesApi: Sendable {
    func checkUpdates(_ query: UpdateQuery) async throws -> UpdateAnswer
}

enum DevicesApiError: Error, Equatable {
    /// The API URL has no derivable Devices site (see `devicesBaseUrl`); nothing was sent.
    case noDevicesUrl
}

/// `GET <devices>/api/updates` with the kiosk bearer. Devices checks the token with
/// the main API, so its 401/403 says nothing about the kiosk session: no
/// refresh-and-retry and no session end here, whatever it answers.
final class URLSessionDevicesApi: DevicesApi {
    private let devicesUrl: @Sendable () async -> String?
    private let session: URLSession
    private let sessionStore: SessionStore

    init(devicesUrl: @escaping @Sendable () async -> String?, session: URLSession, sessionStore: SessionStore) {
        self.devicesUrl = devicesUrl
        self.session = session
        self.sessionStore = sessionStore
    }

    func checkUpdates(_ query: UpdateQuery) async throws -> UpdateAnswer {
        guard let base = await devicesUrl(),
              var parts = URLComponents(string: base + "/api/updates") else { throw DevicesApiError.noDevicesUrl }
        parts.queryItems = query.queryItems
        guard let url = parts.url else { throw DevicesApiError.noDevicesUrl }
        if await sessionStore.tokenIsStale() { _ = await sessionStore.refresh() }
        var request = URLSessionKioskApi.request(url)
        if let token = await sessionStore.accessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return try URLSessionKioskApi.parse(try await URLSessionKioskApi.execute(request, on: session))
    }
}
