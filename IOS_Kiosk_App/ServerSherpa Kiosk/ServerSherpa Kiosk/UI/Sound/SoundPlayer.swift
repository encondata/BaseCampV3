import AVFoundation
import Foundation

/// The five built-ins, synthesized exactly as kiosk/src/lib/sound.ts describes
/// them (Android `Tones` in `ui/sound/SoundPlayer.kt`), as mono Float samples.
enum Tones {
    private enum Wave { case sine, square, sawtooth }

    private struct Tone {
        let wave: Wave
        let freq: Double
        let atMs: Int
        let ms: Int
        var endFreq: Double? = nil
    }

    private static func defs(_ sound: BuiltinSound) -> [Tone] {
        switch sound {
        case .chime: [Tone(wave: .sine, freq: 880, atMs: 0, ms: 90), Tone(wave: .sine, freq: 1318, atMs: 90, ms: 90)]
        case .beep: [Tone(wave: .square, freq: 880, atMs: 0, ms: 120)]
        case .doubleBeep: [Tone(wave: .square, freq: 880, atMs: 0, ms: 70), Tone(wave: .square, freq: 880, atMs: 130, ms: 70)]
        case .buzz: [Tone(wave: .sawtooth, freq: 150, atMs: 0, ms: 300)]
        case .bonk: [Tone(wave: .sine, freq: 440, atMs: 0, ms: 220, endFreq: 160)]
        }
    }

    static func samples(_ sound: BuiltinSound, volume: Double, sampleRate: Double = 44_100) -> [Float] {
        let rate = Int(sampleRate)
        let tones = defs(sound)
        let totalMs = tones.map { $0.atMs + $0.ms }.max() ?? 0
        var out = [Double](repeating: 0, count: rate * totalMs / 1000)
        let gain = min(max(volume, 0), 1) * 0.6
        // 12 ms attack, then an exponential decay to the end of the note.
        let attackN = rate * 12 / 1000
        for t in tones {
            let start = rate * t.atMs / 1000
            let n = rate * t.ms / 1000
            var phase = 0.0
            for i in 0..<n {
                let frac = Double(i) / Double(n)
                let f = t.endFreq.map { t.freq * pow($0 / t.freq, frac) } ?? t.freq
                phase += 2 * .pi * f / Double(rate)
                let raw: Double
                switch t.wave {
                case .sine: raw = sin(phase)
                case .square: raw = sin(phase) >= 0 ? 1 : -1
                case .sawtooth: raw = 2 * (phase / (2 * .pi)).truncatingRemainder(dividingBy: 1) - 1
                }
                let env = i < attackN ? Double(i) / Double(attackN) : exp(-4 * Double(i - attackN) / Double(max(n - attackN, 1)))
                out[start + i] += raw * env * gain
            }
        }
        return out.map { Float(min(max($0, -1), 1)) }
    }
}

/// Plays the configured sound for a scan outcome through one AVAudioEngine.
/// Never throws: a scan is recorded whether or not the device made a noise.
@MainActor
final class SoundPlayer {
    enum Kind { case good, notFound, duplicate }

    private static let sampleRate = 44_100.0

    private let prefs: KioskPrefs
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private let format = AVAudioFormat(standardFormatWithSampleRate: SoundPlayer.sampleRate, channels: 1)

    init(prefs: KioskPrefs) {
        self.prefs = prefs
    }

    func play(_ kind: Kind) {
        let s = prefs.sound
        let choice: SoundChoice = switch kind {
        case .good: s.good
        case .notFound: s.notFound
        case .duplicate: s.duplicate
        }
        guard case .builtin(let sound) = choice else { return }
        playSamples(Tones.samples(sound, volume: s.volume, sampleRate: Self.sampleRate))
    }

    func preview(_ sound: BuiltinSound, volume: Double) {
        playSamples(Tones.samples(sound, volume: volume, sampleRate: Self.sampleRate))
    }

    private func playSamples(_ samples: [Float]) {
        guard !samples.isEmpty, let format, let player = readyPlayer(),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts)
        if !player.isPlaying { player.play() }
    }

    /// Builds the engine and activates the audio session on first use; restarts
    /// an engine the system stopped (an interruption or a route change).
    private func readyPlayer() -> AVAudioPlayerNode? {
        if engine == nil {
            guard let format else { return nil }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, options: [.mixWithOthers])
                try session.setActive(true)
            } catch {
                return nil
            }
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            self.engine = engine
            self.player = player
        }
        guard let engine, let player else { return nil }
        if !engine.isRunning {
            do { try engine.start() } catch { return nil }
        }
        return player
    }
}
