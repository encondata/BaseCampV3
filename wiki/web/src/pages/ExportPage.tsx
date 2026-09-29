/** `/exports/:jobId` — where an export's inbox notification leads: its
 *  status, and a Download button (with a fresh link) once it's done. Only
 *  the person who asked for the export can see it. */
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

import ExportProgress from '../components/ExportProgress';
import { useWikiShell } from '../layout/shellContext';

export default function ExportPage() {
  const { jobId = '' } = useParams();
  const { setCurrentNode } = useWikiShell();
  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  return (
    <div className="portal-page wiki-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Wiki</div>
          <h1 className="page-title">Your export</h1>
          <p className="page-hint">An export you asked for, ready to download for a week.</p>
        </div>
      </div>
      <div className="wiki-export-page"><ExportProgress jobId={jobId} /></div>
    </div>
  );
}
