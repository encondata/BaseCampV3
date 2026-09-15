package com.serversherpa.kiosk.ui.sound

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.serversherpa.kiosk.core.settings.BuiltinSound
import com.serversherpa.kiosk.core.settings.DEFAULT_SOUND_SETTINGS
import com.serversherpa.kiosk.core.settings.SoundChoice
import com.serversherpa.kiosk.core.settings.SoundSettings
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

enum class ScanSoundKind { GOOD, NOT_FOUND, DUPLICATE }

private enum class Wave { SINE, SQUARE, SAWTOOTH }
private data class Tone(val wave: Wave, val freq: Double, val atMs: Int, val ms: Int, val endFreq: Double? = null)

/** The five built-ins, synthesized exactly as kiosk/src/lib/sound.ts describes them. */
object Tones {
    private val DEFS: Map<BuiltinSound, List<Tone>> = mapOf(
        BuiltinSound.CHIME to listOf(Tone(Wave.SINE, 880.0, 0, 90), Tone(Wave.SINE, 1318.0, 90, 90)),
        BuiltinSound.BEEP to listOf(Tone(Wave.SQUARE, 880.0, 0, 120)),
        BuiltinSound.DOUBLE_BEEP to listOf(Tone(Wave.SQUARE, 880.0, 0, 70), Tone(Wave.SQUARE, 880.0, 130, 70)),
        BuiltinSound.BUZZ to listOf(Tone(Wave.SAWTOOTH, 150.0, 0, 300)),
        BuiltinSound.BONK to listOf(Tone(Wave.SINE, 440.0, 0, 220, endFreq = 160.0)),
    )

    fun pcm(id: BuiltinSound, volume: Double, sampleRate: Int = 44_100): ShortArray {
        val tones = DEFS.getValue(id)
        val totalMs = tones.maxOf { it.atMs + it.ms }
        val out = DoubleArray(sampleRate * totalMs / 1000)
        val gain = volume.coerceIn(0.0, 1.0) * 0.6
        for (t in tones) {
            val start = sampleRate * t.atMs / 1000
            val n = sampleRate * t.ms / 1000
            var phase = 0.0
            for (i in 0 until n) {
                val frac = i.toDouble() / n
                val f = if (t.endFreq != null) t.freq * (t.endFreq / t.freq).pow(frac) else t.freq
                phase += 2 * PI * f / sampleRate
                val raw = when (t.wave) {
                    Wave.SINE -> sin(phase)
                    Wave.SQUARE -> if (sin(phase) >= 0) 1.0 else -1.0
                    Wave.SAWTOOTH -> 2 * ((phase / (2 * PI)) % 1.0) - 1
                }
                // 12 ms attack, then an exponential decay to the end of the note.
                val attackN = sampleRate * 12 / 1000
                val env = if (i < attackN) i.toDouble() / attackN else exp(-4.0 * (i - attackN) / (n - attackN).coerceAtLeast(1))
                out[start + i] += raw * env * gain
            }
        }
        return ShortArray(out.size) { (out[it].coerceIn(-1.0, 1.0) * Short.MAX_VALUE).toInt().toShort() }
    }
}

/** Plays the configured sound for a scan outcome. Never throws. */
class SoundPlayer(prefs: KioskPrefs, private val scope: CoroutineScope) {
    @Volatile private var settings: SoundSettings = DEFAULT_SOUND_SETTINGS

    init { scope.launch { prefs.sound.collect { settings = it } } }

    fun play(kind: ScanSoundKind) {
        val s = settings
        val choice = when (kind) { ScanSoundKind.GOOD -> s.good; ScanSoundKind.NOT_FOUND -> s.notFound; ScanSoundKind.DUPLICATE -> s.duplicate }
        playChoice(choice, s.volume)
    }

    fun preview(choice: SoundChoice) = playChoice(choice, settings.volume)

    private fun playChoice(choice: SoundChoice, volume: Double) {
        val id = (choice as? SoundChoice.Builtin)?.id ?: return
        scope.launch(Dispatchers.IO) {
            try {
                val pcm = Tones.pcm(id, volume)
                val track = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(44_100).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(pcm.size * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                track.write(pcm, 0, pcm.size)
                track.play()
                Thread.sleep((pcm.size * 1000L / 44_100) + 50)
                track.release()
            } catch (e: Exception) { /* a scan is recorded whether or not the device made a noise */ }
        }
    }
}
