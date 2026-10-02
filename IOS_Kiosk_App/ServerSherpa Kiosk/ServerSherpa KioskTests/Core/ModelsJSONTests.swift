import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct ModelsJSONTests {
    @Test func sessionDecodesWithUnknownKeysAndPreferencesSubset() throws {
        let body = #"""
        {"access_token":"t","token_type":"bearer","expires_in":900,
          "session_expires_at":"2026-09-16T00:00:00Z",
          "person":{"id":"p1","first_name":"Tina","last_name":"T","preferred_name":null,"display_name":"Tina T","email":null,"job_title":null,"avatar_key":null},
          "roles":["worker"],"must_change_password":false,
          "preferences":{"accent":"aqua","theme":"dark","density":"compact","notif":{"critical":true}},
          "perms":{"kiosk":{"view":true,"add":false,"change":false,"delete":false}},
          "max_rank":20,"scope":{"global":true,"client_ids":[]},"password_min_length":8}
        """#
        let s = try KioskJSON.decoder.decode(SessionData.self, from: Data(body.utf8))
        #expect(s.accessToken == "t")
        #expect(s.preferences.accent == "aqua")
        #expect(s.preferences.theme == "dark")
        #expect(s.perms["kiosk"]?["view"] == true)
        #expect(s.person.avatarUrl == nil)
    }

    @Test func heartbeatOmitsNullsAndKeepsSnakeCase() throws {
        let encoded = String(decoding: try KioskJSON.encoder.encode(HeartbeatIn(serial: "s", name: "n", version: "0.1.0")), as: UTF8.self)
        #expect(encoded.contains(#""mode":"ios""#))
        #expect(!encoded.contains("login_method"))
        #expect(encoded.contains(#""sign_in":false"#))
    }

    @Test func assetRowDefaultsLabelMap() throws {
        let row = try KioskJSON.decoder.decode(KioskAssetRow.self, from: Data(#"{"id":"a","asset_id":"A-1","make_model":"Dell R740","label":{"asset_id":"A-1"}}"#.utf8))
        #expect(row.label["asset_id"] == "A-1")
        #expect(row.rfid == nil)
    }

    @Test func sessionDecodesKioskMoveAndDefaults() throws {
        let json = #"{"access_token":"t","expires_in":900,"session_expires_at":"2026-10-01T00:00:00Z","person":{"id":"p","first_name":"A","last_name":"B","display_name":"A B"},"kiosk_move":{"initiative_id":"i1","name":"Move 1"},"extra":1}"#
        let s = try KioskJSON.decoder.decode(SessionData.self, from: Data(json.utf8))
        #expect(s.kioskMove == KioskMove(initiativeId: "i1", name: "Move 1"))
        #expect(s.roles.isEmpty && s.maxRank == 0 && s.preferences.accent == "amber")
    }

    @Test func apiErrorReadsNestedAndStringDetail() {
        let nested = ApiError.from(status: 409, body: Data(#"{"detail":{"code":"rfid_in_use","asset_name":"Srv 1"}}"#.utf8))
        #expect(nested.code == "rfid_in_use" && nested.detailString("asset_name") == "Srv 1")
        #expect(ApiError.from(status: 401, body: Data(#"{"detail":"invalid_credentials"}"#.utf8)).code == "invalid_credentials")
        #expect(ApiError.from(status: 500, body: Data("oops".utf8)).code == "unknown_error")
        #expect(ApiError.network().isNetwork)
    }

    @Test func pairStatusFromWire() {
        #expect(PairStatus.fromWire("APPROVED") == .approved)
        #expect(PairStatus.fromWire("pending") == .pending)
        #expect(PairStatus.fromWire("weird") == .expired)
    }

    @Test func setupSelectionUsesCamelCaseKeys() throws {
        let sel = KioskSetupSelection(initiativeId: "i", initiativeName: "n", siteId: "s", siteName: "sn", siteRole: "r", scanStatus: "x", scanLabel: "l")
        let text = String(decoding: try KioskJSON.encoder.encode(sel), as: UTF8.self)
        #expect(text.contains(#""initiativeId":"i""#) && text.contains(#""scanLabel":"l""#))
        #expect(try KioskJSON.decoder.decode(KioskSetupSelection.self, from: Data(text.utf8)) == sel)
    }

    @Test func syncDefaultsApplyOnDecode() throws {
        let p = try KioskJSON.decoder.decode(KioskPeopleSync.self, from: Data(#"{"generated_at":"g","people":[{"id":"1","display_name":"A"}]}"#.utf8))
        #expect(p.people[0].isWorker == false && p.people[0].firstName == "")
        let b = try KioskJSON.decoder.decode(KioskScanBatchOut.self, from: Data("{}".utf8))
        #expect(b.accepted.isEmpty && b.rejected.isEmpty)
        let st = try KioskJSON.decoder.decode(SystemStatus.self, from: Data("{}".utf8))
        #expect(st.readOnly == false && st.readOnlyMessage == "" && st.banner == nil)
    }
}
