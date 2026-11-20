import Foundation
import Observation

/// What `EnvironmentSwitcher.switchTo` answered (Android `SwitchResult`).
enum SwitchResult: Equatable, Sendable {
    /// Switched: the kiosk is signed out, cleared, and connects to the new environment.
    case done
    /// This many unsent scans: wait for them to send, or switch again discarding them.
    case pending(Int)
    /// A gate said no (`customNeedsSuperAdmin`, `discardNeedsAdmin` or `accessCheckOffline`).
    case refused(String)

    static let customNeedsSuperAdmin = "custom_needs_super_admin"
    static let discardNeedsAdmin = "discard_needs_admin"
    static let accessCheckOffline = "access_check_offline"
}

/// Why a switch threw before doing anything: the saved environment and everything else unchanged.
enum EnvironmentSwitchError: Error, Equatable {
    /// The outbox's store couldn't be read, so the unsent scans can't be counted.
    case outboxUnreadable
    /// The target wouldn't pass the saved environment's check (a Custom URL that isn't one).
    case invalidEnvironment
}

/// Moves the kiosk to another server (spec "Who can change what" and "What a switch does"), in the
/// same order as Android's `EnvironmentSwitcher` and the laptop edge's
/// (kiosk_laptop/edge/src/edge/environment_switch.py). The environment password is the chooser's
/// to ask for; everything else is checked here, one switch at a time:
///
/// - A Custom URL on a kiosk any server has registered needs the person signed in here to hold a
///   global role of rank 80 or higher; discarding unsent scans needs rank 60 or higher. Both come
///   live from `GET /auth/me` on the current server, asked once, and only when a gate needs it.
///   Nobody signed in, or a refused or unreadable answer, never passes; an unreachable server is
///   `accessCheckOffline`. A named switch with nothing unsent needs no check, so a kiosk stuck on
///   a dead server can always be moved.
/// - Unsent scans (the outbox's queued, sending and retrying, and failed) are `pending` unless
///   discarded.
///
/// Then: biometric sign-in is revoked on the old server while still signed in, and the kiosk signs
/// out (server calls best effort, offline is fine; they go to the old server with the old
/// credentials, captured before anything is cleared). The unsent count is taken again: work that
/// appeared meanwhile, beyond what was approved for discard, is `pending`, nothing cleared. The
/// heartbeat stops and drops any reply still on its way; the old API host's refresh cookie goes;
/// Reset app runs (setup, move data, label settings, print jobs, the Rolodex list and its offline
/// copy, the station key; a sync still on its way stores nothing); the outbox is discarded when
/// asked (a batch in flight keeps no outcome); the last sign-in method and Clear Setup record go;
/// and the new environment is saved. The kiosk's serial, name and has-been-registered flag stay,
/// and so do its appearance, sound and other device settings: iOS has no settings sync, so the
/// spec's reason for resetting them doesn't apply here. The heartbeat starts again at the next
/// sign-in.
@MainActor @Observable
final class EnvironmentSwitcher {
    @ObservationIgnored private let store: EnvironmentStore
    @ObservationIgnored private let config: KioskConfig
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let auth: KioskAuth
    @ObservationIgnored private let outbox: Outbox
    @ObservationIgnored private let biometric: BiometricSignIn
    @ObservationIgnored private let heartbeat: Heartbeat
    @ObservationIgnored private let cookies: RefreshCookie
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let resetApp: @MainActor () async throws -> Void
    /// The switch running now; the next one waits for it.
    @ObservationIgnored private var running: Task<SwitchResult, Error>?
    /// Switches started and not yet answered.
    @ObservationIgnored private var inFlight = 0
    /// A switch is running (or waiting for the one before it). A Time Clock station's sign-in
    /// page keeps its Settings sheet, and the chooser in it, up meanwhile.
    private(set) var isSwitching = false

    init(store: EnvironmentStore, config: KioskConfig, api: KioskApi, auth: KioskAuth, outbox: Outbox,
         biometric: BiometricSignIn, heartbeat: Heartbeat, cookies: RefreshCookie, prefs: KioskPrefs,
         resetApp: @escaping @MainActor () async throws -> Void) {
        self.store = store
        self.config = config
        self.api = api
        self.auth = auth
        self.outbox = outbox
        self.biometric = biometric
        self.heartbeat = heartbeat
        self.cookies = cookies
        self.prefs = prefs
        self.resetApp = resetApp
    }

    /// Scans not yet sent: the outbox's queued (with sending and retrying) and failed.
    var unsentCount: Int { outbox.snapshot.counts.queued + outbox.snapshot.counts.failed }

    /// Switches to `target`, discarding unsent scans when `discard` (an admin's call). Throws
    /// `EnvironmentSwitchError` before anything is done when the outbox can't be read (an
    /// unreadable outbox never counts as empty) or `target` can't be saved, and throws when the
    /// old server's data can't be cleared (storage); the saved environment is unchanged either way.
    /// Runs to the end once started, even if the caller is cancelled.
    func switchTo(_ target: SavedEnvironment, discard: Bool) async throws -> SwitchResult {
        let previous = running
        inFlight += 1
        isSwitching = true
        let task = Task { @MainActor in
            defer {
                self.inFlight -= 1
                self.isSwitching = self.inFlight > 0
            }
            _ = try? await previous?.value
            return try await self.run(target, discard: discard)
        }
        running = task
        return try await task.value
    }

    private func run(_ target: SavedEnvironment, discard: Bool) async throws -> SwitchResult {
        guard store.accepts(target) else { throw EnvironmentSwitchError.invalidEnvironment }
        // The recount below reads the same loaded snapshot, which every enqueue keeps current.
        guard await outbox.load() else { throw EnvironmentSwitchError.outboxUnreadable }
        let oldHost = URL(string: config.apiUrl)?.host
        let pending = unsentCount
        let customGate: Bool
        if case .custom = target { customGate = store.everRegistered } else { customGate = false }
        let discardGate = pending > 0 && discard
        var access: MeInfo?
        if customGate || discardGate {
            guard let answer = await liveAccess() else { return .refused(SwitchResult.accessCheckOffline) }
            access = answer.info
        }
        if customGate, !(access.map { $0.isGlobal && $0.maxRank >= SUPER_ADMIN_RANK } ?? false) {
            return .refused(SwitchResult.customNeedsSuperAdmin)
        }
        if pending > 0 && !discard { return .pending(pending) }
        if discardGate, !(access.map { $0.maxRank >= ADMIN_RANK } ?? false) {
            return .refused(SwitchResult.discardNeedsAdmin)
        }

        // Still signed in to the old server: revoke there, then sign out (its server calls carry
        // the credentials captured now, to the old server, whatever is saved next).
        var signedIn = false
        if case .authed = auth.state { signedIn = true }
        _ = await biometric.forget(signedIn: signedIn)
        await auth.logout()
        // Work queued while we waited on the old server is never discarded unseen.
        let unsent = unsentCount
        if unsent > (discard ? pending : 0) { return .pending(unsent) }

        heartbeat.stopAndDropReplies()
        if let oldHost { cookies.clear(host: oldHost) }
        try await resetApp()
        if discard { try await outbox.discardAll() }
        prefs.clearServerRecords()
        store.save(target)
        return .done
    }

    /// The live access check's answer: `info` is nil when nobody is signed in or the server
    /// refused to say (401/403, or a 2xx that didn't decode). Nil itself when the server couldn't
    /// be reached (or gave any other failure).
    private struct Access { var info: MeInfo? }

    private func liveAccess() async -> Access? {
        guard case .authed = auth.state else { return Access(info: nil) }
        do {
            return Access(info: try await api.me())
        } catch let e as ApiError {
            if e.status == 401 || e.status == 403 || (200..<300).contains(e.status) { return Access(info: nil) }
            return nil
        } catch {
            return nil
        }
    }
}
