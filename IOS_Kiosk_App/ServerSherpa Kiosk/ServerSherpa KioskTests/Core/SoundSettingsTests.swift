import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct SoundSettingsTests {
    @Test func defaults() {
        #expect(DEFAULT_SOUND_SETTINGS.good == .builtin(.chime))
        #expect(DEFAULT_SOUND_SETTINGS.notFound == .builtin(.buzz))
        #expect(DEFAULT_SOUND_SETTINGS.duplicate == .builtin(.doubleBeep))
        #expect(abs(DEFAULT_SOUND_SETTINGS.volume - 0.8) < 1e-9)
        #expect(BuiltinSound.doubleBeep.label == "Double beep")
    }

    @Test func parseWebShapeWithFallbacks() {
        let s = parseSoundSettings(#"{"good":{"kind":"none"},"not_found":{"kind":"builtin","id":"bonk"},"duplicate":{"kind":"upload","id":"x"},"volume":7}"#)
        #expect(s.good == SoundChoice.none)
        #expect(s.notFound == .builtin(.bonk))
        #expect(s.duplicate == DEFAULT_SOUND_SETTINGS.duplicate)   // uploads unsupported here -> default
        #expect(abs(s.volume - 1.0) < 1e-9)
        #expect(parseSoundSettings(nil) == DEFAULT_SOUND_SETTINGS)
    }

    @Test func roundTrip() {
        let s = SoundSettings(good: .none, notFound: .builtin(.beep), duplicate: .builtin(.chime), volume: 0.25)
        #expect(parseSoundSettings(s.toJSON()) == s)
    }

    @Test func jsonMatchesAndroidShape() {
        let s = SoundSettings(good: .none, notFound: .builtin(.doubleBeep), duplicate: .builtin(.chime), volume: 0.25)
        #expect(s.toJSON() == #"{"duplicate":{"id":"chime","kind":"builtin"},"good":{"kind":"none"},"not_found":{"id":"double_beep","kind":"builtin"},"volume":0.25}"#)
    }

    @Test func quotedVolumeIsNotANumber() {
        #expect(abs(parseSoundSettings(#"{"volume":"0.2"}"#).volume - DEFAULT_SOUND_SETTINGS.volume) < 1e-9)
    }

    @Test func objectValuedFieldFallsBackWithoutLosingOtherFields() {
        let s = parseSoundSettings(#"{"good":{"kind":{"nested":"builtin"}},"volume":0.25}"#)
        #expect(s.good == DEFAULT_SOUND_SETTINGS.good)
        #expect(abs(s.volume - 0.25) < 1e-9)
    }

    @Test func arrayValuedFieldFallsBackWithoutLosingOtherFields() {
        let s = parseSoundSettings(#"{"good":{"kind":["builtin"]},"volume":0.25}"#)
        #expect(s.good == DEFAULT_SOUND_SETTINGS.good)
        #expect(abs(s.volume - 0.25) < 1e-9)
    }

    @Test func objectValuedIdFallsBackWithoutLosingOtherFields() {
        let s = parseSoundSettings(#"{"good":{"kind":"builtin","id":{"nested":"bonk"}},"not_found":{"kind":"none"}}"#)
        #expect(s.good == DEFAULT_SOUND_SETTINGS.good)
        #expect(s.notFound == SoundChoice.none)
    }
}
