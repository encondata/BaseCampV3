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

    /// Clear Setup: `setup_cleared` is sent only with an id; `clear_setup` reads as nil when absent.
    @Test func heartbeatClearSetupFieldsRoundTrip() throws {
        let without = String(decoding: try KioskJSON.encoder.encode(HeartbeatIn(serial: "s", name: "n")), as: UTF8.self)
        #expect(!without.contains("setup_cleared"))
        let with = String(decoding: try KioskJSON.encoder.encode(HeartbeatIn(serial: "s", name: "n", setupCleared: "x1")), as: UTF8.self)
        #expect(with.contains(#""setup_cleared":"x1""#))
        let asked = try KioskJSON.decoder.decode(HeartbeatResult.self, from: Data(#"{"device_id":"d","name":"n","registration":"ok","clear_setup":"x1"}"#.utf8))
        #expect(asked.clearSetup == "x1")
        let none = try KioskJSON.decoder.decode(HeartbeatResult.self, from: Data(#"{"device_id":"d","name":"n","registration":"ok","clear_setup":null}"#.utf8))
        #expect(none.clearSetup == nil)
        let older = try KioskJSON.decoder.decode(HeartbeatResult.self, from: Data(#"{"device_id":"d","name":"n","registration":"ok"}"#.utf8))
        #expect(older.clearSetup == nil)
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
        #expect(sel.labelKind == "top")
        #expect(text.contains(#""labelKind":"top""#))
    }

    @Test func syncDefaultsApplyOnDecode() throws {
        let p = try KioskJSON.decoder.decode(KioskPeopleSync.self, from: Data(#"{"generated_at":"g","people":[{"id":"1","display_name":"A"}]}"#.utf8))
        #expect(p.people[0].isWorker == false && p.people[0].firstName == "")
        let b = try KioskJSON.decoder.decode(KioskScanBatchOut.self, from: Data("{}".utf8))
        #expect(b.accepted.isEmpty && b.rejected.isEmpty)
        let st = try KioskJSON.decoder.decode(SystemStatus.self, from: Data("{}".utf8))
        #expect(st.readOnly == false && st.readOnlyMessage == "" && st.banner == nil)
    }

    /// Android `lookupModelsDecodeTheApiShape`: the Asset Lookup payloads, with their defaults.
    @Test func lookupModelsDecodeTheApiShape() throws {
        let res = try KioskJSON.decoder.decode(KioskLookupResult.self, from: Data(#"{"matches":[{"id":"a1","name":"Core","asset_tag":"T-1","serial_number":"S1","matched":["asset_tag","rfid"]},{"id":"a2","name":null,"asset_tag":"T-2","serial_number":null,"matched":["name"]}],"truncated":true}"#.utf8))
        #expect(res.matches.count == 2); #expect(res.matches[0].matched == ["asset_tag", "rfid"])
        #expect(res.matches[1].name == nil); #expect(res.truncated)
        #expect(try KioskJSON.decoder.decode(KioskLookupResult.self, from: Data("{}".utf8)) == KioskLookupResult())

        let full = try KioskJSON.decoder.decode(KioskAssetDetail.self, from: Data(#"""
            {"id":"a1","name":"Core","make":"Dell","model":"R740","make_model":"Dell R740","asset_tag":"T-1","serial_number":"S1","rfid":"E200",
              "routes":[{"initiative_id":"i1","initiative_name":"Move A","source":{"site_name":"Origin","rack":"R1","ru":"12"},"destination":{"site_name":"Dest","pod":"P2","position":"3"}}],
              "full":{"status":"staged","status_label":"Staged","status_color":"#abc","moves":[{"initiative_id":"i1","initiative_name":"Move A","status":"staged","status_label":"Staged","status_color":"#abc"}],"container_name":"C-9","truck_name":null,"location_detail":"Dock"}}
            """#.utf8))
        #expect(full.makeModel == "Dell R740"); #expect(full.rfid == "E200")
        #expect(full.routes[0].source.siteName == "Origin"); #expect(full.routes[0].source.rack == "R1"); #expect(full.routes[0].source.pod == nil)
        #expect(full.routes[0].destination.position == "3")
        #expect(full.full?.statusLabel == "Staged"); #expect(full.full?.containerName == "C-9"); #expect(full.full?.moves.count == 1)
        #expect(full.full?.locationDetail == "Dock"); #expect(full.full?.moves.first?.statusColor == "#abc")
        let bare = try KioskJSON.decoder.decode(KioskAssetDetail.self, from: Data(#"{"id":"a1","asset_tag":"T-1","routes":[],"full":null}"#.utf8))
        #expect(bare.full == nil); #expect(bare.makeModel == "")

        let scans = try KioskJSON.decoder.decode([AssetScanRow].self, from: Data(#"""
            [{"id":"s1","scanned_value":"T-1","scan_type":"pre_stage","scan_type_label":"Pre-stage","scan_type_color":"#abc","status":null,"scanned_at":"2026-11-10T09:00:00Z","device_id":"d1","operator_name":"Tina","site_name":"Origin","location_detail":"R1","off_move":true,"extra":"x"},
             {"id":"s2","scanned_at":"2026-11-10T08:00:00Z"}]
            """#.utf8))
        #expect(scans[0].offMove); #expect(scans[0].scanTypeLabel == "Pre-stage"); #expect(scans[0].operatorName == "Tina")
        #expect(scans[0].status == nil); #expect(scans[0].scannedAt == "2026-11-10T09:00:00Z")
        #expect(!scans[1].offMove); #expect(scans[1].deviceId == "")
    }
}
