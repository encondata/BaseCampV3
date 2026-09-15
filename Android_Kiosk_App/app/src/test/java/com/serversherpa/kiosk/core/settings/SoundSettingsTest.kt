package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class SoundSettingsTest {
    @Test fun defaults() {
        assertEquals(SoundChoice.Builtin(BuiltinSound.CHIME), DEFAULT_SOUND_SETTINGS.good)
        assertEquals(SoundChoice.Builtin(BuiltinSound.BUZZ), DEFAULT_SOUND_SETTINGS.notFound)
        assertEquals(SoundChoice.Builtin(BuiltinSound.DOUBLE_BEEP), DEFAULT_SOUND_SETTINGS.duplicate)
        assertEquals(0.8, DEFAULT_SOUND_SETTINGS.volume, 1e-9)
    }

    @Test fun parseWebShapeWithFallbacks() {
        val s = parseSoundSettings("""{"good":{"kind":"none"},"not_found":{"kind":"builtin","id":"bonk"},"duplicate":{"kind":"upload","id":"x"},"volume":7}""")
        assertEquals(SoundChoice.None, s.good)
        assertEquals(SoundChoice.Builtin(BuiltinSound.BONK), s.notFound)
        assertEquals(DEFAULT_SOUND_SETTINGS.duplicate, s.duplicate)   // uploads unsupported here → default
        assertEquals(1.0, s.volume, 1e-9)
        assertEquals(DEFAULT_SOUND_SETTINGS, parseSoundSettings(null))
    }

    @Test fun roundTrip() {
        val s = SoundSettings(SoundChoice.None, SoundChoice.Builtin(BuiltinSound.BEEP), SoundChoice.Builtin(BuiltinSound.CHIME), 0.25)
        assertEquals(s, parseSoundSettings(s.toJson()))
    }

    @Test fun quotedVolumeIsNotANumber() {
        assertEquals(DEFAULT_SOUND_SETTINGS.volume, parseSoundSettings("""{"volume":"0.2"}""").volume, 1e-9)
    }
}
