import Foundation

/**
 What the saved printer may be left holding after a send went wrong, and what the next send does
 about it. The container owns one, shared like `PrinterLock` by Print Labels (`lockedSender`) and
 Printer Setup (`LockedZebra`), and every rule runs inside the lock, so nothing reaches the printer
 between a check and its write. It starts clean on each launch and whenever the saved printer's
 connection changes (the container follows the settings).

 - `needsClear`: a send failed part-way, so the printer may hold the start of a label the next one
   would merge into (D16). The next send or font install first sends `~JX` (cancel the partially
   received format; labels already received still print, so never `~JA`), then its own bytes. The
   mark clears once `~JX` is delivered. Normal sends never carry it.
 - `fontCut`: a font install failed part-way. `~DY` announces its byte count, so the printer takes
   everything after it as font data until that many bytes arrive (D8): sends and font installs are
   refused with `PrinterNeedsRestart` until a check finds the printer answering `~HI` (it was
   restarted). Queries still go out.

 No check, poll or wait of its own: the only extra byte it ever sends is that one `~JX`.
 */
actor PrinterGuard {
    enum State: Equatable, Sendable { case clean, needsClear, fontCut }

    /// What a guarded write is: a failed label or test label leaves a half label behind; a failed
    /// font install leaves the printer waiting for the rest of the font.
    enum Write: Sendable { case send, font }

    private(set) var state: State = .clean

    /// A send failed part-way: the next send clears first. A cut font stays the stronger state.
    func markSendFailed() {
        if state == .clean { state = .needsClear }
    }

    /// A font install failed part-way: nothing more is sent until the printer answers a check.
    func markFontCut() { state = .fontCut }

    /// Another printer, or a fresh start.
    func reset() { state = .clean }

    /// `~HI` was answered: a printer waiting for the rest of a font couldn't have, so the stop
    /// lifts. A pending clear stays (answering says nothing about a half label).
    func printerAnswered() {
        if state == .fontCut { state = .clean }
    }

    /**
     `write` under the rules, as `kind`; call it holding the printer lock. While the font is cut
     it throws `PrinterNeedsRestart` and sends nothing. After a failed send `clear` (which sends
     `~JX`) runs first; if it fails the error is thrown and the mark stays. A `write` that fails
     marks the printer (a refused font name sends nothing and marks nothing) and rethrows.
     */
    nonisolated func guarded(_ kind: Write, clear: () async throws -> Void, _ write: () async throws -> Void) async throws {
        if try await clearFirst() {
            try await clear()
            await cleared()
        }
        do {
            try await write()
        } catch let refused as FontInstallRefused {
            throw refused // nothing was sent
        } catch {
            switch kind {
            case .send: await markSendFailed()
            case .font: await markFontCut()
            }
            throw error
        }
    }

    /// Whether `~JX` must go before the next write; throws while the font is cut.
    private func clearFirst() throws -> Bool {
        if state == .fontCut { throw PrinterNeedsRestart() }
        return state == .needsClear
    }

    private func cleared() {
        if state == .needsClear { state = .clean }
    }
}
