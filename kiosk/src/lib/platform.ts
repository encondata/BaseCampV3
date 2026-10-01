/**
 * Which of the kiosk's run modes this is. The laptop edition's edge serves
 * `config.js` with `mode: 'laptop'`; everything else is web. `mode` is what
 * the heartbeat reports as the Device sub_type (the edge also forces it).
 */

export type KioskMode = 'web' | 'laptop' | 'pi' | 'android' | 'ios';

export function platform(): { mode: KioskMode; label: string } {
  const mode = typeof window !== 'undefined' ? window.__KIOSK_CONFIG__?.mode : undefined;
  return mode === 'laptop' ? { mode: 'laptop', label: 'Laptop' } : { mode: 'web', label: 'Web' };
}

export function isLaptop(): boolean {
  return platform().mode === 'laptop';
}
