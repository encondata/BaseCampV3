/** Everything the wiki caches per signed-in person, cleared together at
 *  sign-out so the next person never sees the last one's answers. */
import { clearAssetUrls } from './assetUrls';
import { clearNodeTitles } from './nodeTitles';
import { clearPersonNames } from './personNames';
import { clearWikiMe } from './useWikiMe';

export function clearSessionCaches(): void {
  clearWikiMe();
  clearAssetUrls();
  clearNodeTitles();
  clearPersonNames();
}
