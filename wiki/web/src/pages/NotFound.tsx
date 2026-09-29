/** Unknown routes, and nodes or spaces that don't exist or aren't visible
 *  (the API answers both with 404, so the copy doesn't tell them apart). */
import { Link } from 'react-router-dom';

export default function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="portal-page wiki-page">
      <div className="eyebrow">Wiki</div>
      <h1 className="page-title">Nothing here</h1>
      <p className="page-hint">
        This {what} doesn't exist, was moved to the trash, or you don't have access to it.
      </p>
      <p className="page-hint"><Link to="/" className="wiki-link">Back to the wiki home</Link></p>
    </div>
  );
}
