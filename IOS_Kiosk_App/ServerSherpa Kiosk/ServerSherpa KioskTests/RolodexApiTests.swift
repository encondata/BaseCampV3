import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The `/kiosk/rolodex/*` calls over the stub server (Android OkHttpKioskApiRolodexTest).
@Suite(.serialized, .timeLimit(.minutes(1)))
struct RolodexApiTests {
    private func signedIn() async throws -> ApiHarness {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        _ = h.server.takeRequest()
        return h
    }

    private let rowJSON = """
        {"person_id":"p 7","first_name":"Ana","last_name":"Ortiz","preferred_name":null,"display_name":"Ana Ortiz",
         "job_title":"Rigger","company":{"id":"c1","name":"Summit Crew"},"trade":null,"level":"L2","level_color":null,
         "status":"active","status_label":"Active","status_color":"#16a34a","has_photo":false,
         "photo_url":null,"photo_version":null,"rfid_enrolled":false,"has_account":false}
        """

    private var detailJSON: String {
        String(rowJSON.dropLast()) + #","email":null,"phone":null,"external_id":null,"status_note":null,"can_edit":true,"can_change_status":true,"edit_block_reason":null,"status_block_reason":null}"#
    }

    @Test func listDetailAndOptionsAreAuthedGets() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, #"{"generated_at":"2026-10-22T15:42:00Z","workers":[\#(rowJSON)]}"#))
        #expect(try await h.api.rolodexWorkers().workers.map(\.lastName) == ["Ortiz"])
        let listReq = try #require(h.server.takeRequest())
        #expect(listReq.method == "GET"); #expect(listReq.path == "/kiosk/rolodex/workers")
        #expect(listReq.header("Authorization") == "Bearer tok1")

        h.server.enqueue(.json(200, detailJSON))
        let d = try await h.api.rolodexWorker(id: "p 7")
        #expect(d.canEdit); #expect(d.row.company?.name == "Summit Crew")
        let detailReq = try #require(h.server.takeRequest())
        #expect(detailReq.method == "GET"); #expect(detailReq.path == "/kiosk/rolodex/workers/p%207")
        #expect(detailReq.header("Authorization") == "Bearer tok1")

        h.server.enqueue(.json(200, #"{"levels":[{"level":"L1","title":"Helper","color":null}],"statuses":[],"partners":[]}"#))
        #expect(try await h.api.rolodexOptions().levels.map(\.level) == ["L1"])
        let optionsReq = try #require(h.server.takeRequest())
        #expect(optionsReq.method == "GET"); #expect(optionsReq.path == "/kiosk/rolodex/options")
        #expect(optionsReq.header("Authorization") == "Bearer tok1")
    }

    @Test func duplicatesPostsTheNamesInTheBodyAndReturnsTheMatches() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, """
            {"matches":[{"person_id":"p1","display_name":"Ana Ortiz","job_title":null,"company":null,"is_worker":true,
              "has_account":false,"photo_url":null,"photo_version":null,"matched_on":["name"]}]}
            """))
        let matches = try await h.api.rolodexDuplicates(RolodexDuplicatesIn(firstName: "Ana", lastName: "Ortiz"))
        #expect(matches.map(\.personId) == ["p1"]); #expect(matches[0].matchedOn == ["name"])
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/rolodex/duplicates")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(req.bodyString == #"{"first_name":"Ana","last_name":"Ortiz"}"#)
    }

    @Test func createPostsTheWorkerAndReturnsTheDetail() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(201, detailJSON))
        let d = try await h.api.rolodexCreate(RolodexCreateIn(firstName: "Ana", lastName: "Ortiz", allowDuplicate: true))
        #expect(d.personId == "p 7")
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/rolodex/workers")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(req.header("Content-Type") == "application/json; charset=utf-8")
        #expect(req.bodyString == #"{"allow_duplicate":true,"first_name":"Ana","last_name":"Ortiz","photo_skipped":false}"#)
    }

    @Test func possibleDuplicateComesBackAsAnApiError() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(409, #"{"detail":{"code":"possible_duplicate"}}"#))
        do {
            _ = try await h.api.rolodexCreate(RolodexCreateIn(firstName: "Ana", lastName: "Ortiz"))
            Issue.record("expected ApiError")
        } catch let e as ApiError {
            #expect(e.status == 409); #expect(e.code == "possible_duplicate")
        }
    }

    @Test func updatePatchesOnlyTheChangesWithExplicitNulls() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, detailJSON))
        let d = try await h.api.rolodexUpdate(id: "p 7", patch: RolodexPatch([.phone: nil, .level: "L4"]))
        #expect(d.lastName == "Ortiz")
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "PATCH"); #expect(req.path == "/kiosk/rolodex/workers/p%207")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(req.header("Content-Type") == "application/json; charset=utf-8")
        #expect(req.bodyString == #"{"level":"L4","phone":null}"#)
    }

    @Test func photoPutsTheRawJpegBytes() async throws {
        let h = try await signedIn()
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9])
        h.server.enqueue(.json(200, #"{"photo_url":"https://s3.example/a.jpg","photo_version":"0123456789abcdef"}"#))
        let out = try await h.api.rolodexPhoto(id: "p 7", jpeg: jpeg)
        #expect(out == RolodexPhotoOut(photoUrl: "https://s3.example/a.jpg", photoVersion: "0123456789abcdef"))
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "PUT"); #expect(req.path == "/kiosk/rolodex/workers/p%207/photo")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(req.header("Content-Type") == "image/jpeg")
        #expect(req.body == jpeg)
    }

    @Test func photoSendsTheSameBytesAgainAfterARefresh() async throws {
        let h = try await signedIn()
        let jpeg = Data((0..<2048).map { UInt8($0 % 251) })
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(sessionResponse(cookie: nil, token: "tok2"))
        h.server.enqueue(.json(200, #"{"photo_url":null,"photo_version":"fedcba9876543210"}"#))
        #expect(try await h.api.rolodexPhoto(id: "p1", jpeg: jpeg).photoVersion == "fedcba9876543210")
        let first = try #require(h.server.takeRequest())
        #expect(first.header("Authorization") == "Bearer tok1"); #expect(first.body == jpeg)
        #expect(h.server.takeRequest()?.path == "/auth/refresh")
        let retry = try #require(h.server.takeRequest())
        #expect(retry.method == "PUT"); #expect(retry.header("Authorization") == "Bearer tok2")
        #expect(retry.header("Content-Type") == "image/jpeg"); #expect(retry.body == jpeg)
    }
}
