/** An empty list or panel that reads as intentional: a quiet round icon, a
 *  title line and a hint, centered. Home sets it inside its panels; Training
 *  and History set it in a bordered card (`dash-panel`) of their own. */
import Icon from '../layout/Icon';

export const CHECK = 'M8.5 12.2l2.4 2.4 4.7-4.9M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z';
export const LOCK = 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3';
export const DOCS = 'M7 3.5h7l4 4V20.5H7zM14 3.5v4h4M9.5 12.5h5M9.5 16h5';

export default function EmptyState({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="learn-empty">
      <span className="learn-empty-icon"><Icon d={icon} /></span>
      <div className="dash-panel-empty">{title}</div>
      <p className="learn-empty-hint">{hint}</p>
    </div>
  );
}
