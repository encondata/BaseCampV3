/** Leaves the page for an install link: an APK download, an iOS
 *  `itms-services://` manifest or the add-this-iPhone profile. */
export function goTo(url: string): void {
  window.location.href = url;
}
