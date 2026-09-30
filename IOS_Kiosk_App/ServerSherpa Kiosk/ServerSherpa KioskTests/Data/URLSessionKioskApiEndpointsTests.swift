import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@Suite(.serialized, .timeLimit(.minutes(1)))
struct URLSessionKioskApiEndpointsTests {
    private func signedIn() async throws -> ApiHarness {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        _ = h.server.takeRequest()
        return h
    }

    @Test func setupOptionsAndSubmit() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, """
            {"initiatives":[{"id":"i1","name":"Move A","status":"in_progress","status_label":"In progress","client_name":"Acme",
              "scheduled_start":"2026-09-20T00:00:00Z","scheduled_end":null,"source_site":{"id":"s1","name":"Origin"},"destination_site":null}],
              "scan_types":[{"key":"pre_stage","label":"Pre-stage","color":"#abc"}]}
            """))
        let opts = try await h.api.setupOptions()
        #expect(opts.initiatives[0].name == "Move A"); #expect(opts.initiatives[0].sourceSite?.name == "Origin")
        let optsReq = try #require(h.server.takeRequest())
        #expect(optsReq.method == "GET"); #expect(optsReq.path == "/kiosk/setup-options")
        #expect(optsReq.header("Authorization") == "Bearer tok1")
        h.server.enqueue(.json(200, #"{"device_id":"d","initiative_id":"i1","initiative_name":"Move A","site_id":"s1","site_name":"Origin","site_role":"source","scan_status":"pre_stage","scan_status_label":"Pre-stage"}"#))
        let res = try await h.api.submitSetup(KioskSetupIn(serial: "serial", initiativeId: "i1", siteId: "s1", scanStatus: "pre_stage"))
        #expect(res.siteRole == "source")
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/setup")
        #expect(req.bodyString.contains(#""scan_status":"pre_stage""#))
    }

    @Test func syncEndpointsEncodeTheInitiative() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, #"{"initiative_id":"i 1","initiative_name":"M","generated_at":"2026-09-15T00:00:00Z","assets":[{"id":"a","asset_id":"A-1","make_model":"X","label":{}}]}"#))
        #expect(try await h.api.syncAssets(initiativeId: "i 1").assets.count == 1)
        #expect(h.server.takeRequest()?.path == "/kiosk/sync/assets?initiative_id=i%201")
        h.server.enqueue(.json(200, #"{"generated_at":"2026-09-15T00:00:00Z","people":[{"id":"p","display_name":"T","first_name":"T","last_name":"T","is_worker":true,"has_account":false}]}"#))
        #expect(try await h.api.syncPeople().people[0].displayName == "T")
        #expect(h.server.takeRequest()?.path == "/kiosk/sync/people")
        h.server.enqueue(.json(200, #"{"initiative_id":"i1","generated_at":"x","containers":[]}"#))
        #expect(try await h.api.syncContainers(initiativeId: "i1").containers.count == 0)
        #expect(h.server.takeRequest()?.path == "/kiosk/sync/containers?initiative_id=i1")
        h.server.enqueue(.json(200, #"{"initiative_id":"i1","generated_at":"x","trucks":[]}"#))
        #expect(try await h.api.syncTrucks(initiativeId: "i1").trucks.count == 0)
        #expect(h.server.takeRequest()?.path == "/kiosk/sync/trucks?initiative_id=i1")
    }

    @Test func scansRfidAndTimeclock() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, #"{"accepted":["c1"],"rejected":[{"client_scan_id":"c2","code":"bad_site"}]}"#))
        let out = try await h.api.postScans(KioskScanBatchIn(serial: "serial", scans: [KioskScanIn(clientScanId: "c1", scannedValue: "A-1", scanType: "barcode", scannedAt: "2026-09-15T00:00:00Z")]))
        #expect(out.accepted == ["c1"]); #expect(out.rejected[0].code == "bad_site")
        let scansReq = try #require(h.server.takeRequest())
        #expect(scansReq.method == "POST"); #expect(scansReq.path == "/kiosk/scans")
        #expect(scansReq.bodyString.contains(#""client_scan_id":"c1""#))

        h.server.enqueue(.json(409, #"{"detail":{"code":"rfid_in_use","asset_id":"z","asset_name":"Other rack"}}"#))
        do {
            _ = try await h.api.postRfidEnroll(assetId: "a1", KioskRfidEnrollIn(serial: "serial", rfidTag: "000000000000000000100348", scanStatus: "pre_stage", clientScanId: "c3"))
            Issue.record("expected ApiError")
        } catch let e as ApiError {
            #expect(e.code == "rfid_in_use"); #expect(e.detailString("asset_name") == "Other rack")
        }
        let rfidReq = try #require(h.server.takeRequest())
        #expect(rfidReq.method == "POST"); #expect(rfidReq.path == "/kiosk/assets/a1/rfid")
        #expect(rfidReq.bodyString.contains(#""rfid_tag":"000000000000000000100348""#))

        h.server.enqueue(.json(200, #"{"person":{"id":"p","display_name":"T"},"clocked_in":false,"entry":null,"last_entry":null}"#))
        #expect(try await h.api.timeclockStatus(personId: "p").clockedIn == false)
        let statusReq = try #require(h.server.takeRequest())
        #expect(statusReq.method == "GET"); #expect(statusReq.path == "/kiosk/timeclock/p")
        h.server.enqueue(.json(200, #"{"person":{"id":"p","display_name":"T"},"clocked_in":true,"entry":{"id":"e","started_at":"2026-09-15T09:00:00Z"}}"#))
        let st = try await h.api.clockIn(ClockInIn(serial: "serial", personId: "p", siteId: "s1", initiativeId: "i1"))
        #expect(st.clockedIn == true)
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/timeclock/clock-in")
        #expect(req.bodyString.contains(#""site_id":"s1""#))
    }

    @Test func clockOutHeartbeatAndSignOut() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, #"{"person":{"id":"p","display_name":"T"},"clocked_in":false,"entry":null,"last_entry":{"id":"e","started_at":"2026-09-15T09:00:00Z","ended_at":"2026-09-15T17:00:00Z","minutes":480}}"#))
        #expect(try await h.api.clockOut(ClockOutIn(serial: "serial", personId: "p")).lastEntry?.minutes == 480)
        let out = try #require(h.server.takeRequest())
        #expect(out.method == "POST"); #expect(out.path == "/kiosk/timeclock/clock-out")
        #expect(out.bodyString == #"{"person_id":"p","serial":"serial"}"#)

        h.server.enqueue(.json(200, #"{"device_id":"d1","name":"Kiosk","registration":"ok","token_expires_at":null}"#))
        _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk"))
        let hb = try #require(h.server.takeRequest())
        #expect(hb.method == "POST"); #expect(hb.path == "/kiosk/heartbeat")
        #expect(hb.bodyString.contains(#""mode":"ios""#))

        h.server.enqueue(.json(200, "{}"))
        await h.api.signOut(serial: "serial")
        let so = try #require(h.server.takeRequest())
        #expect(so.method == "POST"); #expect(so.path == "/kiosk/sign-out")
        #expect(so.bodyString == #"{"serial":"serial"}"#)
        #expect(so.header("Authorization") == "Bearer tok1")
    }

    @Test func fetchImageIsAPlainGetOfTheAbsoluteURL() async throws {
        let h = try await signedIn()
        h.server.enqueue(StubResponse(status: 200, headers: ["Content-Type": "image/png"], body: Data([1, 2, 3])))
        let data = try await h.api.fetchImage(url: "\(h.server.baseURL)/avatars/p.png?X-Amz-Signature=abc")
        #expect(data == Data([1, 2, 3]))
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "GET"); #expect(req.path == "/avatars/p.png?X-Amz-Signature=abc")
        #expect(req.header("Authorization") == nil)
        h.server.enqueue(.text(403, "denied"))
        await #expect(throws: ApiError(status: 403, code: "unknown_error")) {
            _ = try await h.api.fetchImage(url: "\(h.server.baseURL)/avatars/p.png")
        }
    }

    /// Leaving a screen cancels its call: that is not "Can't reach the portal".
    @Test func aCanceledCallThrowsCancellationNotANetworkError() async throws {
        let h = ApiHarness()
        let hold = StubHold()
        var slow = StubResponse.json(200, #"{"read_only":false}"#)
        slow.hold = hold
        h.server.enqueue(slow)
        let call = Task { try await h.api.systemStatus() }
        await waitUntil { h.server.requestCount == 1 }
        call.cancel()
        do {
            _ = try await call.value
            Issue.record("expected CancellationError")
        } catch is CancellationError {
        } catch {
            Issue.record("expected CancellationError, got \(error)")
        }
        hold.release()
    }
}
