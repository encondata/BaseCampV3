/** One app and platform on the Apps page: its icon, name and platform, the
 *  current version and who uploaded it, what's new, the install control
 *  for this device, and the way to its previous versions. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { PLATFORM_LABEL, versionLabel, type AppOut } from '../lib/appsApi';
import { day } from '../lib/dates';
import { devicesFetch } from '../lib/devicesApi';
import InstallButton from './InstallButton';

/** The icon as an object URL: the icon route takes the bearer, which a
 *  bare <img src> can't send. null while loading, or when there is none. */
function useIcon(iconUrl: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!iconUrl) return;
    let objectUrl: string | null = null;
    let live = true;
    devicesFetch(iconUrl)
      .then((resp) => resp.blob())
      .then((blob) => {
        if (!live) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {});   // the neutral tile stays
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [iconUrl]);
  return src;
}

export function AppIcon({ iconUrl }: { iconUrl: string | null }) {
  const src = useIcon(iconUrl);
  return src
    ? <img className="devices-app-icon" src={src} alt="" />
    : <div className="devices-app-icon placeholder" aria-hidden="true" />;
}

export default function AppCard({ app, deviceRef, onChanged }: {
  app: AppOut;
  deviceRef: string | null;
  onChanged: () => void;
}) {
  const current = app.current;
  return (
    <article className="devices-card">
      <div className="devices-card-main">
        <AppIcon iconUrl={app.icon_url} />
        <div className="devices-card-text">
          <div className="devices-card-title">
            <h2>{app.name}</h2>
            <span className="chip tag">{PLATFORM_LABEL[app.platform]}</span>
            {current && <span className="mono devices-card-version">{versionLabel(current)}</span>}
          </div>
          {current ? (
            <>
              <p className="page-hint">{`Uploaded ${day(current.uploaded_at)} by ${current.uploaded_by_name}`}</p>
              {current.notes && (
                <p className="devices-notes"><b>What's new:</b> <span>{current.notes}</span></p>
              )}
            </>
          ) : (
            <p className="page-hint">No version yet.</p>
          )}
        </div>
        <InstallButton app={app} deviceRef={deviceRef} onChanged={onChanged} />
      </div>
      <Link className="collapse-head devices-card-more" to={`/apps/${app.id}`}>
        <span className="eyebrow-sm">Previous versions</span>
        <svg className="collapse-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </Link>
    </article>
  );
}
