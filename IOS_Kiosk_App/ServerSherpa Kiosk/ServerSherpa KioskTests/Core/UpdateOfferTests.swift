import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct UpdateOfferTests {
    private let itms = "itms-services://?action=download-manifest&url=https%3A%2F%2Fdevices.dev.serversherpa.com%2Fota%2Ft%2Fmanifest.plist"
    private let devices = "https://devices.dev.serversherpa.com"

    private func answer(_ json: String) throws -> UpdateAnswer {
        try KioskJSON.decoder.decode(UpdateAnswer.self, from: Data(json.utf8))
    }

    private func available(installUrl: String?) -> UpdateAnswer {
        UpdateAnswer(status: "available", versionName: "1.2.0", build: "7", notes: "Fixes",
                     installUrl: installUrl, message: nil, size: 1234)
    }

    @Test func devicesUrlFromApi() {
        #expect(devicesBaseUrl(apiUrl: "https://api.dev.serversherpa.com") == "https://devices.dev.serversherpa.com")
        #expect(devicesBaseUrl(apiUrl: "https://api.serversherpa.com/") == "https://devices.serversherpa.com")
        #expect(devicesBaseUrl(apiUrl: "http://api.dev.serversherpa.com:8000") == "http://devices.dev.serversherpa.com:8000")
        for bad in ["http://localhost:8000", "http://192.168.1.5:8000", "https://portal.dev.serversherpa.com",
                    "https://apis.example.com", "not a url"] {
            #expect(devicesBaseUrl(apiUrl: bad) == nil, "\(bad)")
        }
    }

    @Test func decodesTheContract() throws {
        let a = try answer("{\"status\":\"available\",\"version_name\":\"1.2.0\",\"build\":\"7\",\"notes\":\"Fixes\",\"size\":1234,\"install_url\":\"\(itms)\"}")
        #expect(a.status == "available")
        #expect(a.versionName == "1.2.0")
        #expect(a.build == "7")
        #expect(a.notes == "Fixes")
        #expect(a.size == 1234)
        #expect(a.installUrl == itms)
        #expect(a.message == nil)
        let b = try answer("{\"status\":\"up_to_date\"}")
        #expect(b.status == "up_to_date")
        #expect(b.versionName == nil && b.build == nil && b.notes == nil && b.size == nil
                && b.installUrl == nil && b.message == nil)
    }

    @Test func availableOnAdhocIsOffered() {
        let offer = updateOffer(available(installUrl: itms), profile: .adhoc, devicesUrl: devices, device: "iPhone")
        #expect(offer == .available(version: "1.2.0", build: "7", notes: "Fixes", size: 1234,
                                    installUrl: URL(string: itms)!))
    }

    @Test func availableWithoutAdhocAsksToRegister() {
        for profile in [ProfileKind.development, .none] {
            let offer = updateOffer(available(installUrl: itms), profile: profile, devicesUrl: devices, device: "iPhone")
            #expect(offer == .registerFirst(message: "Add this iPhone on devices.dev.serversherpa.com first."))
            let onPad = updateOffer(available(installUrl: itms), profile: profile, devicesUrl: devices, device: "iPad")
            #expect(onPad == .registerFirst(message: "Add this iPad on devices.dev.serversherpa.com first."))
        }
    }

    @Test func availableWithoutItmsUrlIsNotOffered() {
        let expected = UpdateOffer.waiting(message: "This update's install link isn't valid. Check again later.")
        #expect(updateOffer(available(installUrl: "https://evil.example/x.ipa"), profile: .adhoc, devicesUrl: devices, device: "iPhone") == expected)
        #expect(updateOffer(available(installUrl: nil), profile: .adhoc, devicesUrl: devices, device: "iPhone") == expected)
    }

    @Test func versionFallsBack() {
        var a = available(installUrl: itms)
        a.versionName = nil
        guard case .available(let v, _, _, _, _) = updateOffer(a, profile: .adhoc, devicesUrl: devices, device: "iPhone") else {
            Issue.record("not available"); return
        }
        #expect(v == "7")
        a.build = nil
        guard case .available(let w, _, _, _, _) = updateOffer(a, profile: .adhoc, devicesUrl: devices, device: "iPhone") else {
            Issue.record("not available"); return
        }
        #expect(w == "a new version")
    }

    @Test func registerFirstUsesTheServersMessage() throws {
        let said = try answer("{\"status\":\"register_first\",\"message\":\"Add this device on https://devices.dev.serversherpa.com first.\"}")
        #expect(updateOffer(said, profile: .none, devicesUrl: devices, device: "iPhone")
                == .registerFirst(message: "Add this device on https://devices.dev.serversherpa.com first."))
        let silent = try answer("{\"status\":\"register_first\"}")
        #expect(updateOffer(silent, profile: .none, devicesUrl: devices, device: "iPhone")
                == .registerFirst(message: "Add this iPhone on devices.dev.serversherpa.com first."))
        #expect(updateOffer(silent, profile: .none, devicesUrl: devices, device: "iPad")
                == .registerFirst(message: "Add this iPad on devices.dev.serversherpa.com first."))
    }

    @Test func preparingAndNotSetUpWait() throws {
        for status in ["preparing", "not_set_up"] {
            let a = try answer("{\"status\":\"\(status)\",\"message\":\"Hold on.\"}")
            #expect(updateOffer(a, profile: .adhoc, devicesUrl: devices, device: "iPhone") == .waiting(message: "Hold on."))
        }
        let unknown = try answer("{\"status\":\"later_thing\"}")
        #expect(updateOffer(unknown, profile: .adhoc, devicesUrl: devices, device: "iPhone")
                == .waiting(message: "The Devices site sent an answer this app doesn't know."))
    }

    @Test func upToDateAndShowsOnHome() throws {
        let a = try answer("{\"status\":\"up_to_date\"}")
        #expect(updateOffer(a, profile: .adhoc, devicesUrl: devices, device: "iPhone") == .upToDate)
        #expect(UpdateOffer.upToDate.showsOnHome == false)
        #expect(UpdateOffer.waiting(message: "x").showsOnHome == false)
        #expect(UpdateOffer.registerFirst(message: "x").showsOnHome)
        #expect(UpdateOffer.available(version: "1", build: nil, notes: nil, size: nil,
                                      installUrl: URL(string: itms)!).showsOnHome)
    }

    @Test func queryItems() {
        let q = UpdateQuery(bundleId: "Server-Sherpas.ServerSherpa-Kiosk", build: "1", profile: .adhoc)
        #expect(q.queryItems == [
            URLQueryItem(name: "platform", value: "ios"),
            URLQueryItem(name: "bundle_id", value: "Server-Sherpas.ServerSherpa-Kiosk"),
            URLQueryItem(name: "build", value: "1"),
            URLQueryItem(name: "profile_kind", value: "adhoc"),
        ])
    }
}
