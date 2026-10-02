import Testing
import Foundation
@testable import ServerSherpa_Kiosk

struct OutboxMachineTests {
    let asset = OutboxAsset(id: "a1", assetId: "A-1", name: "Rack", rfid: nil, serialNumber: "SN", makeModel: "Dell")
    var input: EnqueueInput {
        EnqueueInput(scannedValue: "A-1", scanType: "barcode", asset: asset, siteId: "site", initiativeId: "init", scanStatus: "pre_stage")
    }

    func row(_ seq: Int64, _ status: OutboxStatus = .queued, attempts: Int = 0, next: Int64? = nil, scannedAtMs: Int64 = 0) -> OutboxRow {
        var r = OutboxMachine.newRow(input, clientScanId: "id\(seq)", seq: seq, nowMs: scannedAtMs)
        r.status = status
        r.attempts = attempts
        r.nextAttemptAt = next
        return r
    }

    @Test func newRowIsQueuedWhenMatchedNomatchOtherwise() {
        #expect(OutboxMachine.newRow(input, clientScanId: "x", seq: 1, nowMs: 0).status == .queued)
        var noAsset = input
        noAsset.asset = nil
        let miss = OutboxMachine.newRow(noAsset, clientScanId: "y", seq: 2, nowMs: 0)
        #expect(miss.status == .nomatch)
        #expect(miss.matched == false)
        #expect(miss.scannedAt == "1970-01-01T00:00:00.000Z")
    }

    @Test func isoMillisFormatsWithMilliseconds() {
        #expect(isoMillis(0) == "1970-01-01T00:00:00.000Z")
        #expect(isoMillis(1_234) == "1970-01-01T00:00:01.234Z")
    }

    @Test func dueRowsTakesQueuedAndDueRetriesOldestFirstCapped() {
        var rows: [OutboxRow] = (1...120).map { row(Int64($0)) }
        rows += [row(200, .retrying, next: 50), row(201, .retrying, next: 500),
                 row(300, .failed), row(301, .accepted), row(302, .nomatch)]
        let due = OutboxMachine.dueRows(rows.shuffled(), nowMs: 100)
        #expect(due.count == OutboxMachine.MAX_BATCH)
        #expect(due.first?.seq == 1)
        #expect(due.allSatisfy { $0.seq != 201 && $0.seq < 300 })
    }

    @Test func statusDecodeFallsBackToQueuedForAnUnknownStatus() throws {
        func decode(_ s: String) throws -> OutboxStatus {
            try JSONDecoder().decode(OutboxStatus.self, from: Data("\"\(s)\"".utf8))
        }
        #expect(try decode("accepted") == .accepted)
        #expect(try decode("something_new") == .queued)
    }

    @Test func recoverStrandedResetsSendingToQueued() {
        let out = OutboxMachine.recoverStranded([row(1, .sending), row(2, .accepted)])
        #expect(out.map(\.status) == [.queued])
        #expect(out.first?.seq == 1)
    }

    @Test func responseAcceptsRejectsAndFailsUnmentioned() {
        let batch = [row(1, .sending), row(2, .sending), row(3, .sending)]
        let out = OutboxMachine.applyResponse(batch, accepted: ["id1"], rejected: ["id2": "bad_site"])
        #expect(out[0].status == .accepted)
        #expect(out[1].status == .failed)
        #expect(out[1].lastError == "bad_site")
        #expect(out[2].status == .failed)
        #expect(out[2].lastError == "no_ack")
    }

    @Test func failureWalksTheLadderThenFails() {
        var rows = [row(1, .sending)]
        var waits: [Int64] = []
        for i in 0..<4 {
            rows = OutboxMachine.applyFailure(rows, code: "network", nowMs: 1000)
            #expect(rows[0].status == .retrying)
            #expect(rows[0].attempts == i + 1)
            waits.append(rows[0].nextAttemptAt! - 1000)
        }
        #expect(waits == [2000, 4000, 15000, 60000])
        rows = OutboxMachine.applyFailure(rows, code: "network", nowMs: 1000)
        #expect(rows[0].status == .failed)
        #expect(rows[0].nextAttemptAt == nil)
        #expect(rows[0].lastError == "network")
    }

    @Test func staleNoMatchAndCounts() {
        let rows = [
            row(1, .nomatch, scannedAtMs: 0), row(2, .nomatch, scannedAtMs: 100_000),
            row(3, .queued, scannedAtMs: 0), row(4, .accepted), row(5, .failed), row(6, .retrying),
        ]
        #expect(OutboxMachine.staleNoMatch(rows, nowMs: 130_000).map(\.seq) == [1])
        #expect(OutboxMachine.counts(rows) == OutboxCounts(queued: 2, accepted: 1, failed: 1, nomatch: 2, total: 6))
    }

    @Test func nextWakeAndRetryFailed() {
        #expect(OutboxMachine.nextWake([row(1)], nowMs: 0) == nil)
        #expect(OutboxMachine.nextWake([row(1, .retrying, next: 140), row(2, .retrying, next: 900)], nowMs: 100) == 40)
        #expect(OutboxMachine.nextWake([row(1, .retrying, next: 10)], nowMs: 100) == 0)
        let retried = OutboxMachine.retryFailed([row(1, .failed, attempts: 5), row(2, .accepted)])
        #expect(retried.count == 1)
        #expect(retried[0].status == .queued)
        #expect(retried[0].attempts == 0)
        #expect(retried[0].lastError == nil)
    }

    @Test func assetJSONUsesCamelCaseKeys() throws {
        let data = try JSONEncoder().encode(asset)
        let obj = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(obj["assetId"] as? String == "A-1")
        #expect(obj["makeModel"] as? String == "Dell")
    }
}
