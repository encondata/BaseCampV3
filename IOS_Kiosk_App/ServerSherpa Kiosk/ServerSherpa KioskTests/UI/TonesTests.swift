import Testing
@testable import ServerSherpa_Kiosk

/// Android TonesTest.kt, against the Float buffer the engine plays.
struct TonesTests {
    @Test func lengthsFollowTheWebDefinitions() {
        #expect(Tones.samples(.chime, volume: 1.0).count == 44_100 * 180 / 1000)        // 90 + 90 ms
        #expect(Tones.samples(.beep, volume: 1.0).count == 44_100 * 120 / 1000)
        #expect(Tones.samples(.doubleBeep, volume: 1.0).count == 44_100 * 200 / 1000)   // 130 + 70 ms
        #expect(Tones.samples(.buzz, volume: 1.0).count == 44_100 * 300 / 1000)
        #expect(Tones.samples(.bonk, volume: 1.0).count == 44_100 * 220 / 1000)
    }

    @Test func volumeScalesAndSilenceIsSilent() {
        let loud = Tones.samples(.beep, volume: 1.0).map { abs($0) }.max()!
        let quiet = Tones.samples(.beep, volume: 0.25).map { abs($0) }.max()!
        #expect(loud > quiet * 3)
        #expect(Tones.samples(.beep, volume: 0.0).allSatisfy { $0 == 0 })
    }

    @Test func samplesStayInRange() {
        for sound in BuiltinSound.allCases {
            #expect(Tones.samples(sound, volume: 1.0).allSatisfy { $0 >= -1 && $0 <= 1 })
        }
    }
}
