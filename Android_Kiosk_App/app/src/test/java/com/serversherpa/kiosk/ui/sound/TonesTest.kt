package com.serversherpa.kiosk.ui.sound

import com.serversherpa.kiosk.core.settings.BuiltinSound
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TonesTest {
    @Test fun lengthsFollowTheWebDefinitions() {
        assertEquals(44_100 * 180 / 1000, Tones.pcm(BuiltinSound.CHIME, 1.0).size)      // 90 + 90 ms
        assertEquals(44_100 * 120 / 1000, Tones.pcm(BuiltinSound.BEEP, 1.0).size)
        assertEquals(44_100 * 200 / 1000, Tones.pcm(BuiltinSound.DOUBLE_BEEP, 1.0).size) // 130 + 70 ms
        assertEquals(44_100 * 300 / 1000, Tones.pcm(BuiltinSound.BUZZ, 1.0).size)
        assertEquals(44_100 * 220 / 1000, Tones.pcm(BuiltinSound.BONK, 1.0).size)
    }

    @Test fun volumeScalesAndSilenceIsSilent() {
        val loud = Tones.pcm(BuiltinSound.BEEP, 1.0).maxOf { kotlin.math.abs(it.toInt()) }
        val quiet = Tones.pcm(BuiltinSound.BEEP, 0.25).maxOf { kotlin.math.abs(it.toInt()) }
        assertTrue(loud > quiet * 3)
        assertTrue(Tones.pcm(BuiltinSound.BEEP, 0.0).all { it.toInt() == 0 })
    }
}
