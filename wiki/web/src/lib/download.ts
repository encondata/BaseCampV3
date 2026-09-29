/** Starts a browser download of a presigned attachment URL (served with
 *  Content-Disposition: attachment, so the page stays where it is). A
 *  separate module so tests can stand in for the navigation. */
export function openDownload(url: string): void {
  window.location.assign(url);
}
