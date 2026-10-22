import Foundation

/// One connection to the saved printer at a time, app-wide (the container owns the one lock).
/// Print Labels' queue sends through it (`lockedSender`) and so does Printer Setup (`LockedZebra`):
/// labels already scanned keep printing after Print Labels closes, so without it a test label, a
/// check or a font install could open a second connection while an asset label is going out.
/// Both apply the container's `PrinterGuard` inside it.
///
/// It only serializes: no check, poll or wait of its own. Callers go in the order they asked and
/// none is dropped: a caller cancelled while it waits still gets its turn (the call it then makes
/// sees the cancellation itself), so the lock is never left held or skipped.
actor PrinterLock {
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    /// Runs `body` once every earlier caller's body has finished.
    func withLock<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
        if busy {
            await withCheckedContinuation { waiting.append($0) }
        } else {
            busy = true
        }
        // Hands the lock straight to the next caller, if any.
        defer {
            if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
        }
        return try await body()
    }
}

/// `send` with each label sent under `lock` and `printerGuard`'s rules (a `~JX` first after a
/// failed send, nothing while a font install is cut): the container's Print Labels sender.
func lockedSender(_ lock: PrinterLock, _ printerGuard: PrinterGuard, _ send: @escaping LabelSender) -> LabelSender {
    { printer, zpl in
        try await lock.withLock {
            try await printerGuard.guarded(.send, clear: { try await send(printer, ZebraCommands.cancelPartialFormat) }) {
                try await send(printer, zpl)
            }
        }
    }
}

/// One Zebra, as Printer Setup talks to it (Android's `SetupZebra`): a `ZebraTransport` on the
/// device (`NetworkZebra`).
protocol SetupZebra: Sendable {
    func identify() async throws -> HostId
    func serial() async throws -> String?
    func status() async throws -> HostStatus
    func peelerPresent() async throws -> Bool?
    func fonts() async throws -> [String]
    func fontEntries() async throws -> [DirectoryEntry]
    func send(_ zpl: String) async throws
    func installFont(name: String, bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws
}

extension SetupZebra {
    /// A font install nobody watches.
    func installFont(name: String, bytes: Data) async throws {
        try await installFont(name: name, bytes: bytes, progress: nil)
    }
}

extension NetworkZebra: SetupZebra {}

/// `inner` with every call made under `lock` (one connection to the printer at a time) and its
/// sends and font installs under `guard`'s rules; an answered `identify()` tells the guard.
struct LockedZebra: SetupZebra {
    let inner: SetupZebra
    let lock: PrinterLock
    let `guard`: PrinterGuard

    func identify() async throws -> HostId {
        try await lock.withLock {
            let id = try await inner.identify()
            await self.guard.printerAnswered()
            return id
        }
    }

    func serial() async throws -> String? { try await lock.withLock { try await inner.serial() } }
    func status() async throws -> HostStatus { try await lock.withLock { try await inner.status() } }
    func peelerPresent() async throws -> Bool? { try await lock.withLock { try await inner.peelerPresent() } }
    func fonts() async throws -> [String] { try await lock.withLock { try await inner.fonts() } }
    func fontEntries() async throws -> [DirectoryEntry] { try await lock.withLock { try await inner.fontEntries() } }

    func send(_ zpl: String) async throws {
        try await lock.withLock {
            try await self.guard.guarded(.send, clear: { try await inner.send(ZebraCommands.cancelPartialFormat) }) {
                try await inner.send(zpl)
            }
        }
    }

    func installFont(name: String, bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        try await lock.withLock {
            try await self.guard.guarded(.font, clear: { try await inner.send(ZebraCommands.cancelPartialFormat) }) {
                try await inner.installFont(name: name, bytes: bytes, progress: progress)
            }
        }
    }
}
