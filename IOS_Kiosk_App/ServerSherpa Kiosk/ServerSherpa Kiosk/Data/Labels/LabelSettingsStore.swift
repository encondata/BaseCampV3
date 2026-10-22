import Foundation
import Observation

/// Where the label settings come from (the kind from Kiosk Setup, the printer from Printer
/// Setup). Main-actor state, read and followed by the label builder off the main actor.
protocol LabelSettingsSource: Sendable {
    @MainActor func current() -> LabelSettings
    /// The current settings first, then each change (an unchanged value is never repeated).
    @MainActor func updates() -> AsyncStream<LabelSettings>
}

/// The label settings, read from two places: the kind (Top or Front) from the Kiosk Setup
/// selection, and the printer, offsets and peel/tear choice from the `ss.kiosk.labels` key.
/// Both live in `KioskPrefs`, so the first value is the stored one, never the defaults followed
/// by the stored one (which would start a label build for nothing).
@MainActor final class LabelSettingsStore: LabelSettingsSource {
    private let prefs: KioskPrefs

    init(prefs: KioskPrefs) {
        self.prefs = prefs
    }

    func current() -> LabelSettings { Self.read(prefs) }

    func updates() -> AsyncStream<LabelSettings> {
        let prefs = self.prefs
        return observationStream { Self.read(prefs) }
    }

    func setPrinter(_ printer: SavedPrinter?) { prefs.updateLabels { $0.printer = printer } }

    func setOffsets(x: Int, y: Int) {
        prefs.updateLabels {
            $0.offsetX = x
            $0.offsetY = y
        }
    }

    func setPeel(_ peel: Bool) { prefs.updateLabels { $0.peel = peel } }

    private static func read(_ prefs: KioskPrefs) -> LabelSettings {
        let options = prefs.labels
        return LabelSettings(kind: LabelKind.fromWire(prefs.setupSelection?.labelKind), printer: options.printer,
                             offsetX: options.offsetX, offsetY: options.offsetY, peel: options.peel)
    }
}

/// The current value of `read`, then each new value it takes as the observable state it reads
/// changes (Observation tracking), for followers off the main actor. A value equal to the last
/// one given is skipped. One stream per caller; it ends when its consumer stops.
@MainActor func observationStream<T: Equatable & Sendable>(_ read: @escaping @MainActor () -> T) -> AsyncStream<T> {
    let (stream, continuation) = AsyncStream.makeStream(of: T.self)
    let follower = ObservationFollower(read: read, continuation: continuation)
    continuation.onTermination = { _ in Task { @MainActor in follower.finish() } }
    follower.next()
    return stream
}

@MainActor private final class ObservationFollower<T: Equatable & Sendable> {
    private let read: @MainActor () -> T
    private let continuation: AsyncStream<T>.Continuation
    private var last: T?
    private var finished = false

    init(read: @escaping @MainActor () -> T, continuation: AsyncStream<T>.Continuation) {
        self.read = read
        self.continuation = continuation
    }

    /// Reads (and tracks) the value, gives it when it changed, and reads again after the next
    /// change. `onChange` fires before the new value is set, so the read waits for a main-actor turn.
    func next() {
        guard !finished else { return }
        let value = withObservationTracking { read() } onChange: { [weak self] in
            Task { @MainActor in self?.next() }
        }
        if value != last {
            last = value
            continuation.yield(value)
        }
    }

    func finish() { finished = true }
}
