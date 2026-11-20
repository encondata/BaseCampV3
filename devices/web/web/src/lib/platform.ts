/** Which install flow the viewer's device gets: an APK on Android, an Ad
 *  Hoc install on an iPhone or iPad, and a QR code everywhere else. */

export type ViewerPlatform = 'android' | 'ios' | 'desktop';

type NavigatorLike = Pick<Navigator, 'userAgent' | 'maxTouchPoints'>;

export function viewerPlatform(nav: NavigatorLike = navigator): ViewerPlatform {
  const ua = nav.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  // iPadOS asks for desktop sites by default and then reports a Mac; a Mac
  // has no touch screen, so multi-touch gives the iPad away
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return 'ios';
  return 'desktop';
}

export type ViewerDevice = 'iPad' | 'iPhone';

/** What to call an iOS viewer's device: an iPad (its own user agent, or the
 *  Mac one iPadOS sends with multi-touch), else an iPhone (an iPod touch
 *  included). Only meaningful when viewerPlatform() is 'ios'. */
export function viewerDevice(nav: NavigatorLike = navigator): ViewerDevice {
  const ua = nav.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return 'iPad';
  return 'iPhone';
}
