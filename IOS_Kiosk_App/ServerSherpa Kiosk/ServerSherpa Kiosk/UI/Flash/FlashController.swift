import Observation
import SwiftUI

/// kiosk/src/lib/flash.ts: one overlay for the whole kiosk; a newer flash owns the screen.
@MainActor @Observable
final class FlashController {
    struct FlashState: Equatable {
        let id: Int
        let color: Color
        let ms: Int
    }

    private(set) var state: FlashState?

    @ObservationIgnored private var nextId = 0
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private let sleep: (Int) async -> Void

    init(sleep: @escaping (Int) async -> Void = { try? await Task.sleep(for: .milliseconds($0)) }) {
        self.sleep = sleep
    }

    func flash(_ color: Color, ms: Int) {
        timer?.cancel()
        nextId += 1
        let mine = FlashState(id: nextId, color: color, ms: ms)
        state = mine
        let sleep = self.sleep
        timer = Task { [weak self] in
            await sleep(ms)
            guard let self, !Task.isCancelled, self.state?.id == mine.id else { return }
            self.state = nil
        }
    }

    func clear() {
        timer?.cancel()
        timer = nil
        state = nil
    }
}
