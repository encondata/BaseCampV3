import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

/// A virtual clock: `sleep` suspends until `advance` moves past its deadline.
@MainActor private final class VirtualClock {
    private var now = 0
    private var waiters: [(deadline: Int, continuation: CheckedContinuation<Void, Never>)] = []

    func sleep(_ ms: Int) async {
        await withCheckedContinuation { waiters.append((now + ms, $0)) }
    }

    func advance(_ ms: Int) async {
        now += ms
        let due = waiters.filter { $0.deadline <= now }
        waiters.removeAll { $0.deadline <= now }
        for w in due { w.continuation.resume() }
        for _ in 0..<10 { await Task.yield() }
    }
}

/// Android FlashControllerTest.kt.
@MainActor
struct FlashControllerTests {
    @Test func aNewerFlashOwnsTheScreen() async {
        let clock = VirtualClock()
        let c = FlashController(sleep: { await clock.sleep($0) })
        c.flash(Color(hex: 0x00FF00), ms: 350)
        await clock.advance(0)   // let the timer task start its sleep
        let first = c.state!
        await clock.advance(200)
        c.flash(Color(hex: 0xFF0000), ms: 350)
        await clock.advance(0)
        #expect(c.state?.id == first.id + 1)
        await clock.advance(200)
        #expect(c.state?.color == Color(hex: 0xFF0000))   // the first flash's timer did not clear the second
        await clock.advance(200)
        #expect(c.state == nil)
    }

    @Test func clearRemovesTheFlash() async {
        let clock = VirtualClock()
        let c = FlashController(sleep: { await clock.sleep($0) })
        c.flash(Color(hex: 0x00FF00), ms: 350)
        #expect(c.state?.ms == 350)
        c.clear()
        #expect(c.state == nil)
        await clock.advance(400)
        #expect(c.state == nil)
    }
}
