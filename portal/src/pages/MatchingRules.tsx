/**
 * Developer › Matching rules — one flow per place (Printing, Scanning) for
 * how a scanned or typed value finds its asset. This page manages the
 * versions: pick one, see its check against today's test set, edit the
 * test set, and save as standby, deploy or roll back. The flow editor
 * itself is /dev/matching-rules/versions/:id.
 *
 * The place lives in ?place= (printing by default). The selection defaults
 * to the place's live version. The check panel shows the selected version's
 * check from its detail (always today's), or, after a refused standby,
 * deploy or roll back, the check that came back with the refusal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import CheckPanel from '../components/matching/CheckPanel';
import StateChangeModal, { type StateChangeKind } from '../components/matching/StateChangeModal';
import TestAssetModal, { DeleteTestAssetModal } from '../components/matching/TestAssetModal';
import TestAssetsPanel from '../components/matching/TestAssetsPanel';
import VersionsTable from '../components/matching/VersionsTable';
import {
  getMatchingVersion, listMatchingTestAssets, listMatchingVersions,
  type MatchingCheck, type MatchingPlace, type MatchingTestAsset, type MatchingVersion,
} from '../lib/api';
import { PLACES } from '../lib/matchingRules';
import '../styles/directory.css';
import '../styles/profile.css'; /* .btn-solid */
import '../styles/reports.css'; /* .sr-only, the dialogs' header */
import '../styles/matching-rules.css';

const isPlace = (v: string | null): v is MatchingPlace => v === 'printing' || v === 'scanning';

export default function MatchingRules() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = params.get('place');
  const place: MatchingPlace = isPlace(raw) ? raw : 'printing';
  const placeLabel = PLACES.find((p) => p.key === place)?.label ?? place;

  const [versions, setVersions] = useState<MatchingVersion[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [check, setCheck] = useState<MatchingCheck | null>(null);
  const [assets, setAssets] = useState<MatchingTestAsset[] | null>(null);
  // One error per source, each cleared only by its own success.
  const [versionsError, setVersionsError] = useState('');
  const [checkError, setCheckError] = useState('');
  const [assetsError, setAssetsError] = useState('');
  const [stateChange, setStateChange] = useState<{ kind: StateChangeKind; version: MatchingVersion } | null>(null);
  const [editing, setEditing] = useState<{ asset: MatchingTestAsset | null } | null>(null);
  const [deleting, setDeleting] = useState<MatchingTestAsset | null>(null);
  // Bumped by every detail request and by a refusal's check, so a late
  // answer never overwrites what the panel shows now.
  const detailSeq = useRef(0);
  // Bumped by every versions request, so a slow answer for the place the
  // page just left never lands after the new place's list.
  const versionsSeq = useRef(0);

  const loadVersions = useCallback(async () => {
    const seq = ++versionsSeq.current;
    try {
      const list = await listMatchingVersions(place);
      if (seq !== versionsSeq.current) return;
      setVersions(list);
      setVersionsError('');
      setSelectedId((cur) => (cur && list.some((v) => v.id === cur)
        ? cur
        : (list.find((v) => v.state === 'live') ?? list[0])?.id ?? null));
    } catch {
      if (seq === versionsSeq.current) setVersionsError("Couldn't load the versions.");
    }
  }, [place]);

  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    setCheck(null);
    try {
      const d = await getMatchingVersion(id);
      if (seq === detailSeq.current) {
        setCheck(d.check);
        setCheckError('');
      }
    } catch {
      if (seq === detailSeq.current) setCheckError("Couldn't load the check.");
    }
  }, []);

  const loadAssets = useCallback(async () => {
    try {
      setAssets(await listMatchingTestAssets());
      setAssetsError('');
    } catch {
      setAssetsError("Couldn't load the test assets.");
    }
  }, []);

  useEffect(() => {
    setVersions(null);
    setSelectedId(null);
    setCheck(null);
    void loadVersions();
  }, [loadVersions]);

  useEffect(() => { void loadAssets(); }, [loadAssets]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selected = versions?.find((v) => v.id === selectedId) ?? null;
  const live = versions?.find((v) => v.state === 'live') ?? null;

  const select = (v: MatchingVersion) => setSelectedId(v.id);
  const openEditor = (v: MatchingVersion) => navigate(`/dev/matching-rules/versions/${v.id}`);
  const askState = (kind: StateChangeKind, v: MatchingVersion) => {
    select(v);
    setStateChange({ kind, version: v });
  };

  /** After the test set changes: today's results move for every version. */
  const reloadAll = () => {
    void loadAssets();
    void loadVersions();
    if (selectedId) void loadDetail(selectedId);
  };

  const switchPlace = (key: MatchingPlace) => {
    if (key === place) return;
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('place', key);
      return next;
    }, { replace: true });
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Developer</div>
          <h1 className="page-title">Matching rules</h1>
          <p className="page-hint">
            One flow per place for how a scanned or typed value finds its asset. Deploying marks a version
            live; the kiosks and apps don&apos;t follow it yet.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist" aria-label="Place">
          {PLACES.map((p) => (
            <button key={p.key} type="button" role="tab" aria-selected={place === p.key}
                    className={place === p.key ? 'on' : ''} onClick={() => switchPlace(p.key as MatchingPlace)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <button type="button" className="mini-btn" disabled={!selected}
                  onClick={() => { if (selected) openEditor(selected); }}>
            Edit flow
          </button>
          <button type="button" className="mini-btn" disabled={!selected}
                  onClick={() => { if (selected) void loadDetail(selected.id); }}>
            Run tests
          </button>
          <button type="button" className="mini-btn" disabled={selected?.state !== 'draft'}
                  onClick={() => { if (selected) askState('standby', selected); }}>
            Save as standby
          </button>
          <button type="button" className="btn-solid"
                  disabled={selected?.state !== 'draft' && selected?.state !== 'standby'}
                  onClick={() => { if (selected) askState('deploy', selected); }}>
            Deploy
          </button>
        </div>
      </div>

      <div className="mr-layout">
        <section className="mr-panel mr-scroll" aria-labelledby="mr-versions-title">
          <h2 className="mr-panel-title" id="mr-versions-title">Versions</h2>
          {versionsError && <p className="pf-error" role="alert">{versionsError}</p>}
          {versions === null ? (
            !versionsError && <p className="page-hint">Loading…</p>
          ) : (
            <VersionsTable versions={versions} selectedId={selectedId} onSelect={select} onOpen={openEditor}
                           onDeploy={(v) => askState('deploy', v)} onRollback={(v) => askState('rollback', v)} />
          )}
        </section>

        <div className="mr-lower">
          <CheckPanel version={selected} check={check} error={checkError} />
          <TestAssetsPanel place={place} assets={assets ?? []} results={check?.tests ?? []}
                           loading={assets === null} error={assetsError}
                           onAdd={() => setEditing({ asset: null })}
                           onEdit={(a) => setEditing({ asset: a })}
                           onDelete={setDeleting} />
        </div>
      </div>

      {stateChange && (
        <StateChangeModal
          kind={stateChange.kind}
          version={stateChange.version}
          liveVersion={live?.version ?? null}
          placeLabel={placeLabel}
          onClose={() => setStateChange(null)}
          onDone={() => {
            setStateChange(null);
            void loadVersions();
            if (selectedId) void loadDetail(selectedId);
          }}
          onCheckFailed={(c) => {
            detailSeq.current += 1;
            setCheck(c);
            setCheckError('');
          }}
        />
      )}

      {editing && (
        <TestAssetModal asset={editing.asset} onClose={() => setEditing(null)}
                        onSaved={() => { setEditing(null); reloadAll(); }} />
      )}

      {deleting && (
        <DeleteTestAssetModal asset={deleting} onClose={() => setDeleting(null)}
                              onDone={() => { setDeleting(null); reloadAll(); }} />
      )}
    </div>
  );
}
