import Foundation

enum ScanSource: Sendable { case keyboard, camera }

struct ScanEvent: Equatable, Sendable {
    let value: String
    let source: ScanSource
    let symbology: String?
}

/// Every scan source ends here; the screen on top listens. Values are trimmed
/// and blanks dropped so no screen has to repeat that. Only one listener is
/// live: a new `events()` call finishes the previous stream and replaces it,
/// and an event published with no listener is dropped.
@MainActor
final class ScanBus {
    private var continuation: AsyncStream<ScanEvent>.Continuation?
    private var currentId = 0

    func publish(_ event: ScanEvent) {
        let value = event.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return }
        continuation?.yield(ScanEvent(value: value, source: event.source, symbology: event.symbology))
    }

    func events() -> AsyncStream<ScanEvent> {
        continuation?.finish()
        currentId += 1
        let id = currentId
        let (stream, cont) = AsyncStream.makeStream(of: ScanEvent.self, bufferingPolicy: .bufferingNewest(64))
        continuation = cont
        cont.onTermination = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.currentId == id else { return }
                self.continuation = nil
            }
        }
        return stream
    }
}
