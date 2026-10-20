/**
 * The label builder (spec §3.5, §4.5–4.8): /labels/templates/new and
 * /labels/templates/:id/edit, rank 80 and up (App.tsx).
 *
 * New: the New template dialog over an empty page; the builder then opens
 * on the template it made. Edit: a builder template — a parent, designed
 * in inches and shown at one of its DPIs (300 unless switched), or one DPI
 * child edited on its own. A code template goes to its code editor.
 *
 * The page composes the builder: the top bar, the fields on the left, the
 * canvas with the placed-fields table under it, the properties and the
 * printer preview on the right. It holds the design in an undo history
 * (labels/builder/history.ts), the samples, the selection and the view,
 * and runs the keys the canvas leaves to it (useBuilderShortcuts): undo
 * and redo, the clipboard, Enter (a text element's content), ⌘B, ⌘⇧I,
 * ⌘S, ⌘P, `/` (field search) and ⌘/ (the shortcut sheet). While a dialog
 * is open the canvas doesn't listen and the page only keeps ⌘S and ⌘P from
 * the browser.
 *
 * Save (⌘S) sends the design (and a parent's samples, which belong to the
 * parent: a child shows them read-only). A parent's
 * save lists the customized children it passed by, and the page asks about
 * each one. Unsaved changes are guarded: in-app links ask first and a
 * reload gets the browser's prompt. Test print (⌘P) compiles the label with
 * its samples at the DPI shown and sends it to a USB Zebra printer.
 *
 * Versions' Open on the templates list lands here with that version in the
 * navigation state (`openVersion`), and the page opens on it, read-only; a
 * child's Test print… there lands with `testPrint`, and the page runs its
 * test print once (connecting a printer first if none is).
 *
 * Fonts load as they are needed (useBuilderFonts). A text element whose
 * font changed before that font's metrics arrived is refit when they do,
 * so its box is one line of the new font tall.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import BuilderTopBar from '../components/labels/builder/BuilderTopBar';
import {
  CloneModal, LeaveModal, OutOfDateModal, type OutOfDateChild,
} from '../components/labels/builder/BuilderDialogs';
import { fontOf, isTypeset, patchElements, refit } from '../components/labels/builder/builderEdits';
import Canvas, { DEFAULT_VIEW, type CanvasView } from '../components/labels/builder/Canvas';
import { deleteSelection, selected } from '../components/labels/builder/canvasActions';
import { fieldLabel } from '../components/labels/builder/fieldCatalog';
import FieldPanel, { type FieldPanelHandle } from '../components/labels/builder/FieldPanel';
import LoadFromAssetModal, { fillSamples } from '../components/labels/builder/LoadFromAssetModal';
import NewTemplateModal from '../components/labels/builder/NewTemplateModal';
import PlacedFieldsTable from '../components/labels/builder/PlacedFieldsTable';
import PreviewPanel from '../components/labels/builder/PreviewPanel';
import PropertiesPanel from '../components/labels/builder/PropertiesPanel';
import ShortcutSheet from '../components/labels/builder/ShortcutSheet';
import { useBuilderFonts } from '../components/labels/builder/useBuilderFonts';
import { useBuilderShortcuts, type ShortcutHandlers } from '../components/labels/builder/useBuilderShortcuts';
import VersionsModal from '../components/labels/builder/VersionsModal';
import { metricsFile } from '../labels/builder/fonts';
import { clampToLabel } from '../labels/builder/geometry';
import { createHistory } from '../labels/builder/history';
import {
  addElement, DesignError, nextId, parseDesign, replaceElements, serializeDesign, validate,
  type DesignV2, type ElementV2,
} from '../labels/builder/model';
import { detectPlatform } from '../labels/builder/shortcuts';
import {
  ApiError, compileLabel, getLabelTemplate, listLabelFields, listLabelFonts, listLabelTemplateTree,
  listLabelVocab, restoreLabelTemplateVersion, templateVersionLabel, updateLabelTemplate,
  type LabelFields, type LabelFont, type LabelTemplate, type LabelTemplateSaved, type LabelTemplateTreeNode,
  type LabelTemplateVersionDetail, type LabelVocab,
} from '../lib/api';
import { dpiDots, vocabLabel } from '../lib/labels';
import { naturalCompare } from '../lib/naturalSort';
import { useLeaveGuard } from '../lib/useLeaveGuard';
import { useZebraPrinter } from '../lib/useZebraPrinter';
import '../styles/directory.css';
import '../styles/labelBuilder.css';

const TEMPLATES = '/labels/templates';
/** The DPI a parent shows unless switched (spec §4.5). */
const PARENT_DPI = '300';
/** How far each paste lands from the copied elements. */
const PASTE_STEP_IN = 0.05;

export default function LabelBuilder() {
  const { id } = useParams();
  return id ? <EditTemplate key={id} id={id} /> : <NewTemplate />;
}

// ── /labels/templates/new ───────────────────────────────────────────

function NewTemplate() {
  const navigate = useNavigate();
  const [vocab, setVocab] = useState<LabelVocab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listLabelVocab()
      .then((rows) => { if (live) setVocab(rows); })
      .catch(() => { if (live) setError("Couldn't load the label types and sizes."); });
    return () => { live = false; };
  }, []);
  if (error) return <PageMessage title="New template" message={error} />;
  return (
    <div className="portal-page lbb-page">
      {vocab && (
        <NewTemplateModal vocab={vocab}
          onCreated={(t) => navigate(`${TEMPLATES}/${t.id}/edit`, { replace: true })}
          onCancel={() => navigate(TEMPLATES)} />
      )}
    </div>
  );
}

function PageMessage({ title, message, children }: { title: string; message: string; children?: ReactNode }) {
  return (
    <div className="portal-page">
      <div className="eyebrow">Label builder</div>
      <h1 className="page-title">{title}</h1>
      <p className="page-hint">{message}</p>
      {children ?? <p className="page-hint"><Link to={TEMPLATES}>Back to the templates</Link></p>}
    </div>
  );
}

// ── /labels/templates/:id/edit ──────────────────────────────────────

interface Loaded {
  template: LabelTemplate;
  design: DesignV2;
  /** The parent's tree node: the template itself, or a child's parent. */
  node: LabelTemplateTreeNode | null;
  vocab: LabelVocab[];
  fonts: LabelFont[];
}

function loadError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return 'This template no longer exists.';
  if (err instanceof ApiError && err.status === 403) return "You don't have access to label templates.";
  return "Couldn't load the template.";
}

/** What the templates list hands over in the navigation state: a version
 *  its Versions panel opened (`openVersion`; the builder opens on it,
 *  read-only), or a child's Test print… (`testPrint`; the builder prints
 *  it once on arrival). */
interface Handed { version: LabelTemplateVersionDetail | null; testPrint: boolean }

const NOTHING_HANDED: Handed = { version: null, testPrint: false };

function handedOver(state: unknown): Handed {
  const s = state as { openVersion?: unknown; testPrint?: unknown } | null;
  const v = s?.openVersion;
  return {
    version: v && typeof v === 'object' && typeof (v as LabelTemplateVersionDetail).label === 'string'
      ? v as LabelTemplateVersionDetail : null,
    testPrint: s?.testPrint === true,
  };
}

function EditTemplate({ id }: { id: string }) {
  const location = useLocation();
  const [handed] = useState(() => handedOver(location.state));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [code, setCode] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([getLabelTemplate(id), listLabelVocab(), listLabelFonts(), listLabelTemplateTree()])
      .then(([template, vocab, fonts, tree]) => {
        if (!live) return;
        if (template.kind === 'code') {
          setCode(true);
          return;
        }
        let design: DesignV2;
        try {
          design = parseDesign(template.design);
        } catch (err) {
          setError({
            title: template.name,
            message: err instanceof DesignError && (template.design as { schema?: unknown } | null)?.schema !== 2
              ? 'This template was made before the label builder, so the builder can’t open it. '
                + 'From Templates, “Edit as raw ZPL” turns it into a code template.'
              : 'This template’s design can’t be read.',
          });
          return;
        }
        const top = template.parent_id ?? template.id;
        setLoaded({ template, design, node: tree.find((n) => n.id === top) ?? null, vocab, fonts });
      })
      .catch((err) => { if (live) setError({ title: 'Label builder', message: loadError(err) }); });
    return () => { live = false; };
  }, [id]);
  if (code) return <Navigate to={`${TEMPLATES}/${id}/code`} replace />;
  if (error) return <PageMessage title={error.title} message={error.message} />;
  if (!loaded) return <div className="portal-page lbb-page"><p className="page-hint">Loading the template…</p></div>;
  return <Builder initial={loaded} handed={handed} />;
}

type Notice = { type: 'success' | 'info' | 'warning' | 'error'; message: string };
type Modal = 'versions' | 'clone' | 'sheet' | 'asset';
interface Viewing { label: string; version: number; childEdits: number; design: DesignV2; samples: Record<string, string> }

const json = (v: unknown) => JSON.stringify(v);

function saveError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'bad_design') {
      const problems = (err.detail as { problems?: string[] } | undefined)?.problems;
      return problems?.length ? `Not saved: ${problems[0]}` : 'Not saved: the design has a problem.';
    }
    if (err.code === 'forbidden') return 'Not saved: only a super admin or a developer can edit templates.';
    if (err.status === 404) return 'Not saved: this template no longer exists.';
    return `Not saved (${err.code}).`;
  }
  return 'Not saved: the server could not be reached.';
}

function printError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'bad_design') {
      const problems = (err.detail as { problems?: string[] } | undefined)?.problems;
      return problems?.length ? `Can't print yet: ${problems[0]}` : "Can't print yet: the design has a problem.";
    }
    return `Couldn't compile the label (${err.code}).`;
  }
  if (err instanceof Error && err.message === 'Printer not connected') return 'Connect a USB printer to test print.';
  return err instanceof Error && err.message ? `Couldn't print: ${err.message}` : "Couldn't print.";
}

/** The DPIs a parent can be shown at: its children's, and always 300. */
function parentDpis(t: LabelTemplate): string[] {
  return [...new Set([...(t.dpis ?? []), PARENT_DPI])].sort(naturalCompare);
}

function staleChildren(node: LabelTemplateTreeNode | null, ids: readonly string[]): OutOfDateChild[] {
  return ids.map((cid) => {
    const child = node?.children.find((c) => c.id === cid);
    return { id: cid, name: child?.name ?? 'A DPI version', version: child ? templateVersionLabel(child) : '' };
  });
}

function Builder({ initial, handed = NOTHING_HANDED }: { initial: Loaded; handed?: Handed }) {
  const navigate = useNavigate();
  const location = useLocation();
  const platform = useMemo(() => detectPlatform(), []);
  const printer = useZebraPrinter();
  const { vocab, fonts: library } = initial;

  const [template, setTemplate] = useState<LabelTemplate>(initial.template);
  const [node, setNode] = useState<LabelTemplateTreeNode | null>(initial.node);
  const isChild = !!template.parent_id;
  const history = useRef(createHistory<DesignV2>(initial.design));
  const [design, setDesign] = useState<DesignV2>(initial.design);
  const [, setHistoryTick] = useState(0);
  const [saved, setSaved] = useState(() => ({
    design: json(serializeDesign(initial.design)),
    samples: json(initial.template.samples ?? {}),
  }));
  const [samples, setSamples] = useState<Record<string, string>>(
    () => ({ ...(isChild ? initial.node?.samples : initial.template.samples) ?? {} }));
  const [selection, setSelection] = useState<string[]>([]);
  const [view, setView] = useState<CanvasView>(DEFAULT_VIEW);
  const [viewDpi, setViewDpi] = useState(isChild ? template.dpi_key : PARENT_DPI);
  const [fields, setFields] = useState<LabelFields | null>(null);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [outOfDate, setOutOfDate] = useState<OutOfDateChild[] | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const panelRef = useRef<FieldPanelHandle>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const clipboard = useRef<{ els: ElementV2[]; pastes: number }>({ els: [], pastes: 0 });
  const { metricsFor, failed: fontsFailed } = useBuilderFonts(library);

  useEffect(() => {
    let live = true;
    listLabelFields(template.label_type)
      .then((f) => { if (live) setFields(f); })
      .catch(() => { if (live) setFieldsError("Couldn't load the fields."); });
    return () => { live = false; };
  }, [template.label_type]);

  // a success or info notice fades on its own
  useEffect(() => {
    if (!notice || notice.type === 'error' || notice.type === 'warning') return undefined;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // the printer's own connect and disconnect messages
  useEffect(() => {
    if (!printer.notice) return;
    setNotice(printer.notice);
    printer.clearNotice();
  }, [printer.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = viewing !== null;
  const shownDesign = viewing?.design ?? design;
  const shownSamples = viewing && Object.keys(viewing.samples).length ? viewing.samples : samples;
  const dpiKey = isChild ? template.dpi_key : viewDpi;
  const dpi = dpiDots(vocab, dpiKey);
  const designJson = useMemo(() => json(serializeDesign(design)), [design]);
  const dirty = designJson !== saved.design || (!isChild && json(samples) !== saved.samples);
  const version = templateVersionLabel(template);
  const isZpl = template.language_key === 'zpl';
  const modalOpen = modal !== null || outOfDate !== null || leaveTo !== null;

  // ── the history ────────────────────────────────────────────────────

  /** Elements whose font changed before its metrics arrived. */
  const pendingRefit = useRef(new Set<string>());
  const gestureOpen = useRef(false);
  const [gestures, setGestures] = useState(0);

  const markPending = useCallback((prev: DesignV2, next: DesignV2) => {
    const before = new Map(prev.elements.map((e) => [e.id, e]));
    for (const el of next.elements) {
      if (!isTypeset(el)) continue;
      const was = before.get(el.id);
      const f = metricsFile(fontOf(el));
      if (was && isTypeset(was) && json(metricsFile(fontOf(was))) === json(f)) continue;
      if (!metricsFor(fontOf(el).family, fontOf(el).weight)) pendingRefit.current.add(el.id);
    }
  }, [metricsFor]);

  const apply = useCallback((next: DesignV2) => {
    const h = history.current;
    if (next === h.present) return;
    markPending(h.present, next);
    h.push(next);
    setDesign(next);
    setHistoryTick((n) => n + 1);
  }, [markPending]);

  const onGesture = useCallback((phase: 'begin' | 'end') => {
    if (phase === 'begin') {
      gestureOpen.current = true;
      history.current.beginGesture();
    } else {
      history.current.endGesture();
      gestureOpen.current = false;
      setGestures((n) => n + 1);
    }
    setHistoryTick((n) => n + 1);
  }, []);

  // refit what was waiting on a font, once the font is here (not while an
  // old version is shown: the edit would land unseen; it runs on return)
  useEffect(() => {
    const pending = pendingRefit.current;
    if (!pending.size || gestureOpen.current || viewing) return;
    const d = history.current.present;
    const ready: ElementV2[] = [];
    for (const id of [...pending]) {
      const el = d.elements.find((e) => e.id === id);
      if (!el || !isTypeset(el)) {
        pending.delete(id);
        continue;
      }
      if (!metricsFor(fontOf(el).family, fontOf(el).weight)) continue;
      pending.delete(id);
      ready.push(refit(el, null, metricsFor));
    }
    if (!ready.length) return;
    const next = replaceElements(d, ready);
    if (json(next) !== json(d)) apply(next);
  }, [metricsFor, gestures, apply, viewing]);

  // every font the design uses starts loading, and the default one
  useEffect(() => {
    metricsFor('swiss721-cond-bold', 'regular');
    for (const el of shownDesign.elements) {
      if (isTypeset(el)) metricsFor(fontOf(el).family, fontOf(el).weight);
    }
  }, [shownDesign, metricsFor]);

  const keepSelection = (d: DesignV2) => setSelection((sel) => sel.filter((sid) => d.elements.some((e) => e.id === sid)));

  const undo = (): boolean => {
    const h = history.current;
    if (readOnly || !h.canUndo()) return false;
    const d = h.undo();
    setDesign(d);
    keepSelection(d);
    setHistoryTick((n) => n + 1);
    return true;
  };

  const redo = (): boolean => {
    const h = history.current;
    if (readOnly || !h.canRedo()) return false;
    const d = h.redo();
    setDesign(d);
    keepSelection(d);
    setHistoryTick((n) => n + 1);
    return true;
  };

  /** A whole new state from the server (a restore): no undo past it.
   *  False when its design can't be read here: the row (version, samples)
   *  is still the server's, and the canvas keeps what it showed. */
  const adopt = (row: LabelTemplateSaved): boolean => {
    setTemplate(row);
    setViewing(null);
    setConfirmRestore(false);
    if (!isChild) setSamples({ ...(row.samples ?? {}) });
    let d: DesignV2;
    try {
      d = parseDesign(row.design);
    } catch (err) {
      console.error('label builder: the restored design cannot be read', err);
      setSaved((prev) => ({ ...prev, samples: isChild ? prev.samples : json(row.samples ?? {}) }));
      return false;
    }
    history.current.reset(d);
    pendingRefit.current.clear();
    setDesign(d);
    setSelection([]);
    setSaved((prev) => ({ design: json(serializeDesign(d)), samples: isChild ? prev.samples : json(row.samples ?? {}) }));
    setHistoryTick((n) => n + 1);
    return true;
  };

  // ── save, out-of-date children ────────────────────────────────────

  const askAboutStale = async (s: LabelTemplateSaved) => {
    const ids = (s.out_of_date ?? []).filter((cid) => cid !== s.id);
    if (isChild || !ids.length) return;
    const tree = await listLabelTemplateTree().catch(() => null);
    const fresh = tree?.find((n) => n.id === s.id) ?? node;
    if (fresh) setNode(fresh);
    setOutOfDate(staleChildren(fresh, ids));
  };

  const save = async () => {
    if (readOnly || saving) return;
    if (!dirty) {
      setNotice({ type: 'info', message: 'No changes to save.' });
      return;
    }
    const problems = validate(design);
    if (problems.length) {
      const p = problems[0];
      setNotice({ type: 'error', message: `Not saved: ${p.elementId ? `${p.elementId}: ` : ''}${p.message}` });
      return;
    }
    const sent = serializeDesign(design);
    const sentSamples = { ...samples };
    setSaving(true);
    try {
      const result = await updateLabelTemplate(template.id, isChild ? { design: sent } : { design: sent, samples: sentSamples });
      setTemplate(result);
      setSaved((prev) => ({ design: json(sent), samples: isChild ? prev.samples : json(sentSamples) }));
      setNotice({ type: 'success', message: `Saved ${templateVersionLabel(result)}.` });
      await askAboutStale(result);
    } catch (err) {
      setNotice({ type: 'error', message: saveError(err) });
    } finally {
      setSaving(false);
    }
  };

  // ── test print ─────────────────────────────────────────────────────

  const testPrint = async () => {
    if (printing || !isZpl) return;
    setPrinting(true);
    try {
      const { code } = await compileLabel({
        kind: 'design', design: serializeDesign(shownDesign), size_key: template.size_key, dpi_key: dpiKey,
        language_key: 'zpl', mode: 'sample', samples: { ...shownSamples }, label_type: template.label_type,
      });
      if (!printer.connected) await printer.connect();
      await printer.send(code);
      setNotice({ type: 'success', message: `Sent a test label at ${dpiKey} DPI.` });
    } catch (err) {
      setNotice({ type: 'error', message: printError(err) });
    } finally {
      setPrinting(false);
    }
  };

  // ── versions ───────────────────────────────────────────────────────

  const openVersion = (v: LabelTemplateVersionDetail) => {
    setModal(null);
    try {
      setViewing({
        label: v.label, version: v.version, childEdits: v.child_edits,
        design: parseDesign(v.design), samples: { ...v.samples },
      });
      setSelection([]);
    } catch {
      setNotice({ type: 'error', message: `${v.label} can't be shown: its design can't be read.` });
    }
  };

  // what the templates list handed over happens once — the ref holds
  // across StrictMode's second mount — and the state is dropped, so a reload
  // or Back lands on the template itself
  const handedDone = useRef(false);
  useEffect(() => {
    if (handedDone.current || (!handed.version && !handed.testPrint)) return;
    handedDone.current = true;
    if (handed.version) openVersion(handed.version);
    if (handed.testPrint) void testPrint();
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const restored = async (s: LabelTemplateSaved) => {
    setModal(null);
    const label = templateVersionLabel(s);
    setNotice(adopt(s)
      ? { type: 'success', message: `Restored as ${label}.` }
      : { type: 'warning', message: `Restored as ${label}, but its design can't be shown here. Reload the page to see it.` });
    await askAboutStale(s);
  };

  const restoreViewed = async () => {
    if (!viewing || restoring) return;
    if (dirty && !confirmRestore) {
      setConfirmRestore(true);
      return;
    }
    setRestoring(true);
    try {
      await restored(await restoreLabelTemplateVersion(template.id, viewing.version, viewing.childEdits));
    } catch {
      setNotice({ type: 'error', message: `Couldn't restore ${viewing.label}.` });
    } finally {
      setRestoring(false);
    }
  };

  // ── leaving ────────────────────────────────────────────────────────

  useLeaveGuard(dirty, setLeaveTo);
  const leave = (to: string) => (dirty ? setLeaveTo(to) : navigate(to));

  // ── the page's keys ────────────────────────────────────────────────

  const copy = (): boolean => {
    const els = selected(shownDesign, selection);
    if (!els.length) return false;
    clipboard.current = { els: JSON.parse(json(els)) as ElementV2[], pastes: 0 };
    return true;
  };

  const paste = (): boolean => {
    const clip = clipboard.current;
    if (readOnly || !clip.els.length) return false;
    clip.pastes += 1;
    const off = PASTE_STEP_IN * clip.pastes;
    let d = design;
    const ids: string[] = [];
    for (const el of clip.els) {
      const id = nextId(d, el.type);
      d = addElement(d, clampToLabel({ ...el, id, x: el.x + off, y: el.y + off } as ElementV2, d.size));
      ids.push(id);
    }
    apply(d);
    setSelection(ids);
    return true;
  };

  const cut = (): boolean => {
    if (readOnly || !copy()) return false;
    apply(deleteSelection(design, selection));
    setSelection([]);
    return true;
  };

  /** ⌘B / ⌘⇧I on the selection's text: on for all, or off when all have it. */
  const toggleFormat = (what: 'bold' | 'inverted'): boolean => {
    const els = selected(design, selection).filter(isTypeset);
    if (readOnly || !els.length) return false;
    const ids = els.map((e) => e.id);
    if (what === 'bold') {
      const weight = els.every((e) => fontOf(e).weight === 'bold') ? 'regular' : 'bold';
      apply(patchElements(design, ids, (el) => (isTypeset(el) ? { font: { ...fontOf(el), weight } } : null), metricsFor));
    } else {
      const inverted = !els.every((e) => !!e.inverted);
      apply(patchElements(design, ids, (el) => (isTypeset(el) ? { inverted } : null), metricsFor));
    }
    return true;
  };

  /** Enter: into the selected text element's content. */
  const editContent = (): boolean => {
    const els = selected(design, selection);
    if (readOnly || els.length !== 1 || els[0].type !== 'text') return false;
    const box = sideRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Content"]');
    if (!box) return false;
    box.focus();
    box.select();
    return true;
  };

  const handlers: ShortcutHandlers = {
    'edit.undo': undo,
    'edit.redo': redo,
    'edit.copy': copy,
    'edit.cut': cut,
    'edit.paste': paste,
    'edit.content': editContent,
    'format.bold': () => toggleFormat('bold'),
    'format.inverted': () => toggleFormat('inverted'),
    'workflow.save': () => { void save(); },
    'workflow.testPrint': () => { void testPrint(); },
    'workflow.fieldSearch': () => {
      if (!panelRef.current) return false;
      panelRef.current.focusSearch();
      return true;
    },
    'workflow.shortcutSheet': () => { setModal('sheet'); },
  };
  // under a dialog only ⌘S and ⌘P are held, so the browser's own save and
  // print dialogs stay away; nothing else runs
  useBuilderShortcuts(modalOpen ? { 'workflow.save': () => {}, 'workflow.testPrint': () => {} } : handlers,
    { platform });

  // ── the page ───────────────────────────────────────────────────────

  const typeSize = `${vocabLabel(vocab, 'type', template.label_type)} · ${vocabLabel(vocab, 'size', template.size_key)}`;
  const fieldName = useCallback((key: string) => fieldLabel(fields, key), [fields]);
  const onSelect = useCallback((ids: string[]) => setSelection(ids), []);
  const editChange = readOnly ? () => {} : apply;

  return (
    <div className="portal-page lbb-page">
      <BuilderTopBar
        name={template.name} typeSize={typeSize} version={version} dirty={dirty} platform={platform}
        role={isChild
          ? { kind: 'child', dpi: template.dpi_key }
          : { kind: 'parent', dpis: parentDpis(template), viewDpi, onViewDpi: setViewDpi }}
        canUndo={history.current.canUndo()} canRedo={history.current.canRedo()}
        onUndo={() => { undo(); }} onRedo={() => { redo(); }}
        onBack={() => leave(TEMPLATES)}
        onVersions={() => setModal('versions')}
        onClone={isChild ? undefined : () => setModal('clone')}
        cloneBlocked={dirty ? 'Save your changes first: a clone copies the saved template.' : null}
        onTestPrint={() => { void testPrint(); }}
        printBlocked={isZpl ? null : 'Test print is for ZPL templates.'}
        onSave={() => { void save(); }}
        saving={saving} printing={printing} readOnly={readOnly} />

      {notice && (
        <div className={`lbb-notice is-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          <span>{notice.message}</span>
          <button type="button" className="lbb-notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      {fontsFailed.length > 0 && (
        <div className="lbb-notice is-warning" role="status">
          <span>
            Couldn&apos;t load {fontsFailed.length === 1 ? 'a font' : `${fontsFailed.length} fonts`} from the font
            library ({fontsFailed.join(', ')}): text in it is measured roughly.
          </span>
        </div>
      )}
      {viewing && (
        <div className="lbb-viewing" role="status">
          <span>
            Viewing <b>{viewing.label}</b>, read-only.
            {confirmRestore && ' Restoring it discards your unsaved changes.'}
          </span>
          <button type="button" className="btn-solid" disabled={restoring} onClick={() => void restoreViewed()}>
            {confirmRestore ? 'Discard and restore' : 'Restore this version'}
          </button>
          <button type="button" className="mini-btn" disabled={restoring}
            onClick={() => { setViewing(null); setConfirmRestore(false); }}>Back to editing</button>
        </div>
      )}

      <div className="lbb-body">
        <FieldPanel ref={panelRef} fields={fields} design={shownDesign} samples={shownSamples} onSamples={setSamples}
          onChange={editChange} onSelect={onSelect} metricsFor={metricsFor} labelType={template.label_type}
          onLoadFromAsset={() => setModal('asset')} loadError={fieldsError} readOnly={readOnly}
          samplesFromParent={isChild} />
        <div className="lbb-center">
          <Canvas design={shownDesign} dpi={dpi} view={view} onView={setView} samples={shownSamples}
            selection={selection} onSelect={onSelect} onChange={editChange} onGesture={onGesture}
            metricsFor={metricsFor} fieldName={fieldName} readOnly={readOnly} keyboard={!modalOpen}
            platform={platform} />
          <PlacedFieldsTable design={shownDesign} fields={fields} samples={shownSamples} selection={selection}
            onSelect={onSelect} onChange={editChange} metricsFor={metricsFor} readOnly={readOnly} />
        </div>
        <div className="lbb-side" ref={sideRef}>
          <PropertiesPanel design={shownDesign} selection={selection} samples={shownSamples} fields={fields} dpi={dpi}
            metricsFor={metricsFor} onChange={editChange} onSelect={onSelect} labelType={template.label_type}
            readOnly={readOnly} />
          <PreviewPanel design={shownDesign} dpi={dpi} samples={shownSamples} library={library}
            sizeKey={template.size_key} labelType={template.label_type} disabled={!isZpl} />
        </div>
      </div>

      {modal === 'versions' && (
        <VersionsModal templateId={template.id} templateName={template.name} current={version} dirty={dirty}
          onOpen={openVersion} onRestored={(s) => { void restored(s); }} onClose={() => setModal(null)} />
      )}
      {modal === 'clone' && (
        <CloneModal template={template} onClose={() => setModal(null)}
          onCloned={(copyRow) => navigate(`${TEMPLATES}/${copyRow.id}/edit`)} />
      )}
      {modal === 'sheet' && <ShortcutSheet platform={platform} onClose={() => setModal(null)} />}
      {modal === 'asset' && (
        <LoadFromAssetModal onClose={() => setModal(null)} onLoad={(values) => {
          const filled = fillSamples(samples, values);
          setSamples(filled.samples);
          setModal(null);
          setNotice({ type: 'success', message: `Filled ${filled.filled} sample${filled.filled === 1 ? '' : 's'} from the asset.` });
        }} />
      )}
      {outOfDate && (
        <OutOfDateModal parentVersion={version} items={outOfDate} onDone={(updated) => {
          setOutOfDate(null);
          if (updated) void listLabelTemplateTree().then((tree) => setNode(tree.find((n) => n.id === template.id) ?? null)).catch(() => {});
        }} />
      )}
      {leaveTo !== null && (
        <LeaveModal onStay={() => setLeaveTo(null)} onLeave={() => navigate(leaveTo)} />
      )}
    </div>
  );
}
