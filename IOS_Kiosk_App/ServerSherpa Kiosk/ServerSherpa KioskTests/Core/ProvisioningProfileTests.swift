import Testing
import Foundation
@testable import ServerSherpa_Kiosk

private final class ProfileFixtureBundle {}

/// The provisioning-profile reader, on four real CMS-signed fixture profiles made with a throwaway
/// certificate (`Fixtures/Profiles/make_fixtures.sh`; every value in them is made up).
struct ProvisioningProfileTests {
    private func fixture(_ name: String) throws -> Data {
        let url = try #require(Bundle(for: ProfileFixtureBundle.self).url(forResource: name, withExtension: "mobileprovision"))
        return try Data(contentsOf: url)
    }

    @Test func adhocReadsAsAdhoc() throws {
        #expect(profileKind(fromMobileprovision: try fixture("adhoc")) == .adhoc)
    }

    @Test func developmentReadsAsDevelopment() throws {
        #expect(profileKind(fromMobileprovision: try fixture("development")) == .development)
    }

    @Test func enterpriseReadsAsNone() throws {
        #expect(profileKind(fromMobileprovision: try fixture("enterprise")) == .none)
    }

    @Test func appStoreReadsAsNone() throws {
        #expect(profileKind(fromMobileprovision: try fixture("appstore")) == .none)
    }

    @Test func missingFileReadsAsNone() {
        #expect(profileKind(fromMobileprovision: nil) == .none)
    }

    @Test func garbageReadsAsNone() throws {
        let random = Data((0..<512).map { _ in UInt8.random(in: 0...255) })
        #expect(profileKind(fromMobileprovision: random) == .none)
        let adhoc = try fixture("adhoc")
        #expect(profileKind(fromMobileprovision: adhoc.prefix(adhoc.count / 2)) == .none)
        #expect(profileKind(fromMobileprovision: Data("<?xml version".utf8)) == .none)
    }

    @Test func emptyDeviceListIsNotAdhoc() {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
        <key>ProvisionedDevices</key><array></array>
        <key>Entitlements</key><dict><key>get-task-allow</key><false/></dict>
        </dict></plist>
        """
        #expect(profileKind(fromMobileprovision: Data(plist.utf8)) == .none)
    }
}
