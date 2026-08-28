/** Stub page for nav destinations that exist before their feature does.
 *  Same head structure as the real pages (eyebrow / title / hint) so the
 *  route feels planned rather than broken. */

export default function Placeholder({ eyebrow, title, hint }: {
  eyebrow: string;
  title: string;
  hint: string;
}) {
  return (
    <div className="portal-page">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="page-title">{title}</h1>
      <p className="page-hint">{hint}</p>
      <p className="page-hint">Coming soon — this page is a placeholder.</p>
    </div>
  );
}
