import Foundation
@testable import ServerSherpa_Kiosk

/// A DevicesApi that records each query and answers from a queue (an empty queue answers
/// `up_to_date`). `hold()` parks every call until `release()`.
final class FakeDevicesApi: DevicesApi, @unchecked Sendable {
    private let lock = NSLock()
    private var _queries: [UpdateQuery] = []
    private var answers: [Result<UpdateAnswer, Error>] = []
    private var holding = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var queries: [UpdateQuery] { lock.withLock { _queries } }
    var callCount: Int { queries.count }

    func enqueue(_ answer: UpdateAnswer) { lock.withLock { answers.append(.success(answer)) } }
    func enqueue(error: Error) { lock.withLock { answers.append(.failure(error)) } }

    func hold() { lock.withLock { holding = true } }

    func release() {
        let parked = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            holding = false
            defer { waiters.removeAll() }
            return waiters
        }
        for c in parked { c.resume() }
    }

    func checkUpdates(_ query: UpdateQuery) async throws -> UpdateAnswer {
        lock.withLock { _queries.append(query) }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let park = lock.withLock { () -> Bool in
                if holding { waiters.append(c); return true }
                return false
            }
            if !park { c.resume() }
        }
        let next = lock.withLock { answers.isEmpty ? nil : answers.removeFirst() }
        return try (next ?? .success(UpdateAnswer(status: "up_to_date"))).get()
    }
}

