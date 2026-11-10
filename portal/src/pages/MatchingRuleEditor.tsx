/**
 * Developer › Matching rules › v{n} — the flow editor for one version:
 * the palette (left), the canvas (middle), the selected step's or wire's
 * settings (right), and a slot at the bottom for the test bar.
 *
 * A draft saves in place. Any other version (standby, live, retired) is
 * never changed: saving it makes a new draft based on it, and the page
 * moves to that draft's address.
 *
 * Live warnings: 400 ms after the last edit the flow is checked
 * (`checkMatchingFlow`). The steps a failing structure item names are
 * marked on the canvas, and a strip above it lists the problems and the
 * test set result. An answer for an older flow is dropped. The loaded
 * flow's check comes with the version, so loading or Discard needs none.
 *
 * Leaving with unsaved changes through an in-app link asks first; a reload
 * or a closed tab gets the browser's own prompt (useLeaveGuard).
 *
 * Lazy-loaded (App.tsx), which keeps React Flow out of the main bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import StandardModal from '../components/StandardModal';
import FlowCanvas, { type CanvasSelection, type FlowCanvasHandle } from '../components/matching/FlowCanvas';
import NodePalette from '../components/matching/NodePalette';
import NodeSettings from '../components/matching/NodeSettings';
import TestBar from '../components/matching/TestBar';
import {
  checkMatchingFlow, createMatchingDraft, getMatchingVersion, updateMatchingDraft,
  type MatchingCheck, type MatchingRun, type MatchingVersionDetail,
} from '../lib/api';
import {
  addNode, litPath, PLACES, removeEdge, removeNode, sameFlow, setSettings, STATE_CHIP, STATE_LABELS,
  type Flow, type NodeKind,
} from '../lib/matchingRules';
import { useLeaveGuard } from '../lib/useLeaveGuard';
import '../styles/directory.css';
import '../styles/profile.css'; /* .btn-solid, .pf-form, .pf-error */
import '../styles/reports.css'; /* the dialog's header */
import '../styles/matching-rules.css';

const CHECK_DELAY_MS = 400;
/** About half a step's size, so a clicked-in step sits on the center. */
const HALF_STEP = { x: 90, y: 30 };

export default function MatchingRuleEditor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const [loaded, setLoaded] = useState<MatchingVersionDetail | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<CanvasSelection | null>(null);
  const [check, setCheck] = useState<MatchingCheck | null>(null);
  const [checkError, setCheckError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  // The test bar's last run; its path is lit on the canvas.
  const [run, setRun] = useState<MatchingRun | null>(null);

  const canvas = useRef<FlowCanvasHandle>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  // The id whose detail the page holds; a save that made a new draft
  // already has it, so the move to its address loads nothing.
  const heldId = useRef<string | null>(null);
  // Bumped by every check scheduled and by every flow adopted, so a late
  // answer never overwrites what the strip shows now.
  const checkSeq = useRef(0);

  const adopt = useCallback((d: MatchingVersionDetail, keepFlow = false) => {
    heldId.current = d.id;
    checkSeq.current += 1;
    setLoaded(d);
    if (!keepFlow) setFlow(d.flow);
    setCheck(d.check);
    setCheckError('');
  }, []);

  useEffect(() => {
    if (heldId.current === id) return undefined;
    let current = true;
    heldId.current = null;
    setLoaded(null);
    setFlow(null);
    setSelected(null);
    setLoadError('');
    setSavedNote('');
    getMatchingVersion(id).then(
      (d) => { if (current) adopt(d); },
      () => { if (current) setLoadError("Couldn't load this version."); },
    );
    return () => { current = false; };
  }, [id, adopt]);

  const dirty = !!loaded && !!flow && !sameFlow(flow, loaded.flow);
  useLeaveGuard(dirty, (to) => setLeaveTo(to));

  // Live warnings for an edited flow.
  useEffect(() => {
    if (!loaded || !flow || flow === loaded.flow) return undefined;
    const seq = ++checkSeq.current;
    const place = loaded.place;
    const timer = setTimeout(() => {
      checkMatchingFlow(place, flow).then(
        (c) => { if (seq === checkSeq.current) { setCheck(c); setCheckError(''); } },
        () => { if (seq === checkSeq.current) setCheckError("Couldn't check the flow."); },
      );
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [flow, loaded]);

  const failing = useMemo(() => (check?.structure ?? []).filter((item) => !item.ok), [check]);
  const warnings = useMemo(
    () => new Set(failing.flatMap((item) => item.problems.flatMap((p) => p.node_ids))),
    [failing],
  );
  const problems = failing.flatMap((item) => (item.problems.length
    ? item.problems.map((p) => p.message)
    : [item.label]));

  const lit = useMemo(() => (run && flow ? litPath(run.trace, flow) : null), [run, flow]);

  const edit = useCallback((next: Flow) => {
    setFlow(next);
    setSavedNote('');
    setSaveError('');
  }, []);

  if (!loaded || !flow) {
    return (
      <div className="portal-page">
        {loadError ? <p className="pf-error" role="alert">{loadError}</p> : <div className="dir-empty">Loading…</div>}
      </div>
    );
  }

  const placeLabel = PLACES.find((p) => p.key === loaded.place)?.label ?? loaded.place;
  const stateLabel = STATE_LABELS.find((s) => s.key === loaded.state)?.label ?? loaded.state;
  const selNode = selected?.kind === 'node' ? flow.nodes.find((n) => n.id === selected.id) ?? null : null;
  const selEdge = selected?.kind === 'edge' ? flow.edges.find((e) => e.id === selected.id) ?? null : null;
  const hasScanInput = flow.nodes.some((n) => n.kind === 'scan_input');

  const place = (kind: NodeKind, position: { x: number; y: number }) => {
    if (kind === 'scan_input' && hasScanInput) return;
    const added = addNode(flow, kind, position);
    edit(added.flow);
    setSelected({ kind: 'node', id: added.id });
  };
  const addAtCenter = (kind: NodeKind) => {
    const c = canvas.current?.center() ?? { x: 0, y: 0 };
    // a few clicks in a row fan out instead of stacking exactly
    const nudge = (flow.nodes.length % 5) * 24;
    place(kind, { x: c.x - HALF_STEP.x + nudge, y: c.y - HALF_STEP.y + nudge });
  };

  const discard = () => {
    checkSeq.current += 1;
    setFlow(loaded.flow);
    setCheck(loaded.check);
    setCheckError('');
    setSaveError('');
    setSelected(null);
  };

  const save = async () => {
    const sent = flow;
    setSaving(true);
    setSaveError('');
    try {
      const d = loaded.state === 'draft'
        ? await updateMatchingDraft(loaded.id, sent)
        : await createMatchingDraft({ place: loaded.place, flow: sent, based_on_id: loaded.id });
      // an edit made while the save was out stays (and stays unsaved)
      const editedSince = !!flowRef.current && !sameFlow(flowRef.current, sent);
      adopt(d, editedSince);
      setSavedNote(`Saved v${d.version}.`);
      if (d.id !== loaded.id) navigate(`/dev/matching-rules/versions/${d.id}`, { replace: true });
    } catch {
      setSaveError(`Couldn't save v${loaded.version}. Try again.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="portal-page mr-editor-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Matching rules · {placeLabel}</div>
          <h1 className="page-title">
            v{loaded.version} <span className={STATE_CHIP[loaded.state]}>{stateLabel}</span>
          </h1>
          {loaded.state !== 'draft' && <p className="page-hint">Saving makes a new draft from v{loaded.version}.</p>}
        </div>
        <div className="mr-editor-actions">
          {saveError && <span className="pf-error" role="alert">{saveError}</span>}
          {savedNote && !dirty && <span className="mr-saved" role="status">{savedNote}</span>}
          <button type="button" className="mini-btn" disabled={!dirty || saving} onClick={discard}>Discard</button>
          <button type="button" className="btn-solid" disabled={!dirty || saving} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>

      {(check || checkError) && (
        <div className={`mr-warnings ${problems.length ? 'is-bad' : 'is-ok'}`} role="status" aria-label="Live check">
          {checkError && <p className="pf-error">{checkError}</p>}
          {problems.length > 0 && (
            <ul className="mr-warn-list">
              {problems.map((m, i) => <li key={`${i}:${m}`}>{m}</li>)}
            </ul>
          )}
          {check && (
            <span className={`mr-warn-tests ${check.tests_ok ? 'mr-pass' : 'mr-fail'}`}>
              Test set: {check.passed} of {check.total}
            </span>
          )}
        </div>
      )}

      <div className="mr-editor">
        <NodePalette hasScanInput={hasScanInput} onAdd={addAtCenter} />
        <div className="mr-canvas">
          <FlowCanvas flow={flow} selected={selected} warnings={warnings} lit={lit} handle={canvas}
                      onChange={edit} onSelect={setSelected} onDropKind={place} />
        </div>
        <NodeSettings
          flow={flow}
          node={selNode}
          edge={selEdge}
          onFlowChange={edit}
          onChange={(settings) => { if (selNode) edit(setSettings(flow, selNode.id, settings)); }}
          onDeleteNode={() => {
            if (!selNode) return;
            edit(removeNode(flow, selNode.id));
            setSelected(null);
          }}
          onDeleteEdge={() => {
            if (!selEdge) return;
            edit(removeEdge(flow, selEdge.id));
            setSelected(null);
          }}
        />
        <TestBar place={loaded.place} flow={flow} onRun={setRun} />
      </div>

      {leaveTo !== null && (
        <StandardModal eyebrow="Matching rules" title="Leave without saving?"
          description={`Your changes to v${loaded.version} aren't saved.`}
          cardClass="mr-confirm-card" onClose={() => setLeaveTo(null)}
          footer={(
            <>
              <button type="button" className="btn-solid" onClick={() => navigate(leaveTo)}>Leave</button>
              <button type="button" className="mini-btn" autoFocus onClick={() => setLeaveTo(null)}>Stay</button>
            </>
          )}
        />
      )}
    </div>
  );
}
