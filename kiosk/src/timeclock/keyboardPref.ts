/** Whether this kiosk shows the Enter Your Name on-screen keyboard. A
 *  laptop is assumed to have a physical keyboard, so the default is
 *  hidden; a touchscreen kiosk turns it on once and the choice is kept.
 *  Storage can be blocked or throw, so every touch is guarded. */

export const TC_KEYBOARD_KEY = 'ss.kiosk.tcKeyboard';

export function readKeyboardShown(): boolean {
  try {
    return window.localStorage.getItem(TC_KEYBOARD_KEY) === 'shown';
  } catch {
    return false;
  }
}

export function writeKeyboardShown(shown: boolean): void {
  try {
    window.localStorage.setItem(TC_KEYBOARD_KEY, shown ? 'shown' : 'hidden');
  } catch {
    /* not remembered; the choice still holds until the page reloads */
  }
}
