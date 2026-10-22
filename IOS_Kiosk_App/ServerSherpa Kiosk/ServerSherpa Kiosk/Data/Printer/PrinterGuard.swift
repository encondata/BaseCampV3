import Foundation

/**
 What a printer may be left holding after a write went wrong, and what the next call to it does
 about it. The container owns one, shared like `PrinterLock` by Print Labels (`lockedSender`) and
 Printer Setup (`LockedZebra`), and every rule runs inside the lock, so nothing reaches the printer
 between a check and its write. Each mark belongs to the printer it happened on (its identity: the
 network host or the Bluetooth serial, never the iPad's identifier for it, which can change), so a
 late failure of a printer no longer saved never applies to the one that is, and saving another
 printer drops none (A→B→A keeps A's marks: Ruling 16).

 - `needsClear`: a send failed part-way, so the printer may hold the start of a label the next one
   would merge into (D16). The next call to it (a send, a font install, or a Printer Setup query)
   first sends `~JX` (cancel the partially received format; labels already received still print,
   so never `~JA`), then its own bytes. The mark clears once `~JX` is delivered; a clear that fails
   is `PrinterClearFailed` (the job itself never went out). Normal calls never carry it.
 - `fontCut`: a font install failed after its bytes started going out. `~DY` announces its byte
   count, so the printer takes everything after it as font data until that many bytes arrive (D8):
   sends and font installs are refused with `PrinterNeedsRestart` until a check finds the printer
   answering `~HI` (it was restarted). Queries still go out, with no clear (it would be font data).
   The printer keeps waiting through an app relaunch, so these stops are kept in `PrinterStopsStore`
   and restored at launch; `needsClear` lives in memory (D16).

 No check, poll or wait of its own: the only extra byte it ever sends is that one `~JX`.
 */
actor PrinterGuard {
    enum State: Equatable, Sendable { case clean, needsClear, fontCut }

    private var marks: [PrinterIdentity: State] = [:]
    /// Where the `fontCut` stops are kept across launches (nil keeps them in memory only).
    private let stops: PrinterStopsStore?

    /// `stops` restores the printers stopped after a cut font install in an earlier launch, and
    /// keeps every later change (the container passes `KioskPrefs.printerStops`).
    init(stops: PrinterStopsStore? = nil) {
        self.stops = stops
        for identity in stops?.load() ?? [] { marks[identity] = .fontCut }
    }

    func state(for connection: PrinterConnection) -> State { marks[connection.identity] ?? .clean }

    /// A send failed part-way: the next call clears first. A cut font stays the stronger state.
    func markSendFailed(for connection: PrinterConnection) {
        if state(for: connection) == .clean { marks[connection.identity] = .needsClear }
    }

    /// A font install was cut off: nothing more is sent until the printer answers a check, in this
    /// launch or a later one.
    func markFontCut(for connection: PrinterConnection) {
        marks[connection.identity] = .fontCut
        saveStops()
    }

    /// `~HI` was answered: a printer waiting for the rest of a font couldn't have, so the stop
    /// lifts (for later launches too). A pending clear stays (answering says nothing about a half
    /// label).
    func printerAnswered(_ connection: PrinterConnection) {
        guard marks[connection.identity] == .fontCut else { return }
        marks[connection.identity] = nil
        saveStops()
    }

    private func saveStops() {
        stops?.save(Set(marks.filter { $0.value == .fontCut }.keys))
    }

    /// A query (call it holding the printer lock): `clear` (which sends `~JX`) first when the
    /// printer needs it. Never refused, and a failed query marks nothing.
    nonisolated func asking<T>(for connection: PrinterConnection, clear: () async throws -> Void,
                               _ ask: () async throws -> T) async throws -> T {
        try await clearIfNeeded(connection, refuseWhileCut: false, clear)
        return try await ask()
    }

    /// A label or test label (call it holding the printer lock): refused while the font is cut,
    /// `clear` first when needed; a send that fails marks the printer for a clear.
    nonisolated func sending(for connection: PrinterConnection, clear: () async throws -> Void,
                             _ send: () async throws -> Void) async throws {
        try await clearIfNeeded(connection, refuseWhileCut: true, clear)
        do {
            try await send()
        } catch {
            await markSendFailed(for: connection)
            throw error
        }
    }

    /// A font install (call it holding the printer lock): refused while the font is cut, `clear`
    /// first when needed. `install` gets the progress callback to write through (passing reports
    /// on to `progress`); one that fails after the transport's first report, which comes once its
    /// bytes start going out, cuts the font. One that never started (nothing listening, a refused
    /// font name) leaves the state as it was.
    nonisolated func installing(for connection: PrinterConnection, clear: () async throws -> Void,
                                progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?,
                                _ install: (_ progress: @escaping @Sendable (_ sent: Int, _ total: Int) -> Void) async throws -> Void)
        async throws {
        try await clearIfNeeded(connection, refuseWhileCut: true, clear)
        let started = WriteStarted()
        do {
            try await install { sent, total in
                started.mark()
                progress?(sent, total)
            }
        } catch {
            if started.value { await markFontCut(for: connection) }
            throw error
        }
    }

    /// `clear` when `connection` needs one (its mark lifts once `~JX` is delivered); while its
    /// font is cut, `PrinterNeedsRestart` when `refuseWhileCut`, else nothing.
    private nonisolated func clearIfNeeded(_ connection: PrinterConnection, refuseWhileCut: Bool,
                                           _ clear: () async throws -> Void) async throws {
        switch await state(for: connection) {
        case .clean:
            return
        case .fontCut:
            if refuseWhileCut { throw PrinterNeedsRestart() }
        case .needsClear:
            do {
                try await clear()
            } catch let cancelled as CancellationError {
                throw cancelled
            } catch {
                throw PrinterClearFailed(host: (error as? PrinterError)?.host ?? "", cause: error)
            }
            await cleared(connection)
        }
    }

    private func cleared(_ connection: PrinterConnection) {
        if marks[connection.identity] == .needsClear { marks[connection.identity] = nil }
    }
}

/// The `~JX` clear before a call failed: the job or query itself never went out, so a label
/// can't have printed. `cause` is why the clear failed.
struct PrinterClearFailed: PrinterError {
    var host: String
    var cause: Error
    var errorDescription: String? { "Couldn't clear the printer at \(host) before sending" }
}

/// Whether a write reported any progress: its bytes started going out.
private final class WriteStarted: @unchecked Sendable {
    private let lock = NSLock()
    private var started = false

    func mark() { lock.withLock { started = true } }
    var value: Bool { lock.withLock { started } }
}
