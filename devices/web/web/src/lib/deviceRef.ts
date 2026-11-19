/** Which registered iPhone this browser is: the ios_devices id the
 *  add-this-iPhone callback sends back as `?added=`. Kept in localStorage,
 *  which can be missing or throw (private mode, blocked site data); then
 *  the page simply treats the phone as not added yet. */
const KEY = 'devices.iosDeviceRef';

export function readDeviceRef(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function storeDeviceRef(ref: string): void {
  try {
    localStorage.setItem(KEY, ref);
  } catch {
    // not remembered: the next visit asks to add this iPhone again
  }
}
