import Foundation

/// A sleeper the test cranks by hand: `sleep(d)` parks until `fire(d)`. A canceled
/// sleeper removes only its own entry, synchronously, so `pending` is exact the
/// moment `cancel()` returns. `started` counts every sleep ever asked for, so a
/// test can see a timer restart.
final class ManualSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [(id: Int, duration: Duration, cont: CheckedContinuation<Void, Error>)] = []
    private var canceled: Set<Int> = []
    private var starts: [Duration] = []
    private var next = 0

    func sleep(_ d: Duration) async throws {
        let id = lock.withLock { next += 1; starts.append(d); return next }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                let already = lock.withLock { () -> Bool in
                    if canceled.remove(id) != nil { return true }
                    waiters.append((id, d, c))
                    return false
                }
                if already { c.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let c = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                guard let i = waiters.firstIndex(where: { $0.id == id }) else { canceled.insert(id); return nil }
                return waiters.remove(at: i).cont
            }
            c?.resume(throwing: CancellationError())
        }
    }

    func pending(_ d: Duration) -> Int { lock.withLock { waiters.filter { $0.duration == d }.count } }

    func started(_ d: Duration) -> Int { lock.withLock { starts.filter { $0 == d }.count } }

    /// Wakes every sleeper that asked for `d`.
    func fire(_ d: Duration) {
        let hit = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
            let hit = waiters.filter { $0.duration == d }.map(\.cont)
            waiters.removeAll { $0.duration == d }
            return hit
        }
        for c in hit { c.resume() }
    }
}
