/**
 * Notification sounds — short tones synthesised with the Web Audio API, so
 * nothing ships as an asset and every option has a Preview. Browsers refuse
 * to start audio before a user gesture: `installAudioUnlock()` resumes the
 * context on the first pointer/key event, and until then `play*` is a
 * silent no-op (never an exception in the polling path).
 */

import type { NotificationSound } from './api';

export const NOTIFICATION_SOUNDS: { key: NotificationSound; label: string }[] = [
  { key: 'none', label: 'None' },
  { key: 'chime', label: 'Chime' },
  { key: 'ping', label: 'Ping' },
  { key: 'pop', label: 'Pop' },
  { key: 'bell', label: 'Bell' },
];

type Note = { freq: number; type: OscillatorType; at: number; dur: number; gain: number };

/** Each sound = a few enveloped oscillator notes (seconds are relative). */
const RECIPES: Record<Exclude<NotificationSound, 'none'>, Note[]> = {
  chime: [
    { freq: 880, type: 'sine', at: 0, dur: 0.35, gain: 0.18 },
    { freq: 1318.5, type: 'sine', at: 0.12, dur: 0.45, gain: 0.14 },
  ],
  ping: [{ freq: 1567.98, type: 'sine', at: 0, dur: 0.22, gain: 0.16 }],
  pop: [{ freq: 300, type: 'triangle', at: 0, dur: 0.12, gain: 0.22 }],
  bell: [
    { freq: 659.25, type: 'sine', at: 0, dur: 0.9, gain: 0.16 },
    { freq: 1318.5, type: 'sine', at: 0, dur: 0.6, gain: 0.06 },
    { freq: 1975.5, type: 'sine', at: 0, dur: 0.35, gain: 0.03 },
  ],
};

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** Resume the context on the first user gesture (autoplay policy). Idempotent. */
export function installAudioUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  const unlock = () => {
    const c = context();
    if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
}

/** Play a notification sound; silent no-op for 'none', without Web Audio,
 *  or while the context is still locked by the autoplay policy. */
export function playNotificationSound(sound: NotificationSound): boolean {
  if (sound === 'none') return false;
  const c = context();
  if (!c || c.state !== 'running') {
    if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
    return false;
  }
  const t0 = c.currentTime;
  for (const n of RECIPES[sound]) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = n.type;
    osc.frequency.setValueAtTime(n.freq, t0 + n.at);
    if (sound === 'pop') osc.frequency.exponentialRampToValueAtTime(n.freq / 2, t0 + n.at + n.dur);
    env.gain.setValueAtTime(0.0001, t0 + n.at);
    env.gain.exponentialRampToValueAtTime(n.gain, t0 + n.at + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(env).connect(c.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
  return true;
}
