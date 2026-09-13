/**
 * Which of the kiosk's run modes this build is. Web is the only one
 * today; Laptop Mode, RFID Middleware, and the Device App will supply
 * their own mode (and, later, a hardware serial and file-based config)
 * through this same seam. `mode` is what the heartbeat reports as the
 * Device sub_type.
 */

export type KioskMode = 'web' | 'laptop' | 'pi' | 'android' | 'ios';

export function platform(): { mode: KioskMode; label: string } {
  return { mode: 'web', label: 'Web' };
}
