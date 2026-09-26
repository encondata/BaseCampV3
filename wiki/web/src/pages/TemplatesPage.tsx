/** /templates — every template a page can start from: the built-ins, other
 *  global templates (added by a wiki admin), and — once a space is picked —
 *  that space's own. List, create, edit (name/description/icon plus its
 *  content, in a standalone, non-collaborative editor) and delete, each
 *  gated the way the API gates them: a space template needs manage on its
 *  space, a global one needs a wiki admin, and a builtin is read-only for
 *  everyone. */
import type { JSONContent } from '@tiptap/core';
import { useEffect, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';
import { useToast } from '@portal/lib/notificationsContext';

import ConfirmDialog from '../components/ConfirmDialog';
import { atLeast } from '../components/RowMenu';
import ReadOnlyDoc from '../editor/ReadOnlyDoc';
import { EMPTY_DOC } from '../editor/schema';
import TemplateEditor from '../editor/TemplateEditor';
import { useWikiShell } from '../layout/shellContext';
import type { Level, SpaceOut, TemplateDetail, TemplateOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import {
  createTemplate, deleteTemplate, errorMessage, getTemplate, listSpaces, listTemplates, updateTemplate,
} from '../lib/wikiApi';

const GLOBAL = '__global__';
const GRID = { gridTemplateColumns: 'minmax(200px, 3fr) minmax(100px, 1fr) minmax(110px, 1fr) 160px' };

/** Like the template picker: "This space" for the space being browsed,
 *  else that space's name (its key only while the spaces load). */
function scopeLabel(t: TemplateOut, current: SpaceOut | null, spaces: SpaceOut[] | null): string {
  if (t.is_builtin) return 'Built in';
  if (t.space_id === null) return 'Global';
  if (t.space_id === current?.id) return 'This space';
  return spaces?.find((s) => s.id === t.space_id)?.name ?? t.space_key ?? 'Another space';
}

/** Whether the caller may change (or delete) `t` — a builtin never; a
 *  global template needs a wiki admin; a space template needs manage on
 *  its space (the one currently browsed — the only one a listing can
 *  ever mix in, since `listTemplates` scopes space templates to it). */
function canManageTemplate(
  t: Pick<TemplateOut, 'is_builtin' | 'space_id'>, isAdmin: boolean, spaceLevel: Level | null | undefined,
): boolean {
  if (t.is_builtin) return false;
  return t.space_id === null ? isAdmin : atLeast(spaceLevel, 'manage');
}

type ListState = TemplateOut[] | 'loading' | 'error';

function ListView({ scope, space, spaces, isAdmin, canCreate, onEdit, onCreated }: {
  scope: string;
  space: SpaceOut | null;
  spaces: SpaceOut[] | null;
  isAdmin: boolean;
  canCreate: boolean;
  onEdit: (id: string) => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<ListState>('loading');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ template: TemplateOut; busy: boolean; error: string } | null>(null);

  const load = () => {
    setTemplates('loading');
    listTemplates(scope === GLOBAL ? undefined : scope).then(setTemplates).catch(() => setTemplates('error'));
  };
  useEffect(load, [scope]);

  const canManage = (t: TemplateOut) => canManageTemplate(t, isAdmin, space?.my_level);

  const create = async () => {
    setCreating(true);
    try {
      const t = await createTemplate({
        space_id: scope === GLOBAL ? null : space?.id,
        name: 'Untitled template',
        content_json: EMPTY_DOC,
      });
      onCreated(t.id);
    } catch (err) {
      toast(errorMessage(err, 'Couldn\'t create the template.'));
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: '' });
    try {
      await deleteTemplate(deleting.template.id);
      setTemplates((cur) => (Array.isArray(cur) ? cur.filter((t) => t.id !== deleting.template.id) : cur));
      setDeleting(null);
      toast(`Deleted “${deleting.template.name}”.`);
    } catch (err) {
      setDeleting({ ...deleting, busy: false, error: errorMessage(err, 'Couldn\'t delete this template.') });
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="toolbar-right wiki-toolbar">
          <button type="button" className="btn-ghost" disabled={!canCreate || creating} onClick={() => void create()}
                  title={canCreate ? undefined : 'You need manage rights here to add a template'}>
            {creating ? 'Creating…' : 'New template'}
          </button>
        </div>
      </div>
      <div className="dir-list list-scroll wiki-templates-list">
        <div className="list-head" style={GRID} aria-hidden="true">
          <span>Name</span><span>Scope</span><span>Updated</span><span />
        </div>
        <div role="list" aria-label="Templates">
          {Array.isArray(templates) && templates.map((t) => (
            <div className="dir-row" role="listitem" key={t.id}>
              <div className="row-main wiki-template-row" style={GRID}>
                <div className="cell cell-primary">
                  <div className="pn"><b title={t.name}>{t.icon ? `${t.icon} ` : ''}{t.name}</b>
                    {t.description && <span className="cell-sub">{t.description}</span>}
                  </div>
                </div>
                <div className="cell"><span className="cell-top cell-line">{scopeLabel(t, space, spaces)}</span></div>
                <div className="cell"><span className="cell-top cell-line">{new Date(t.updated_at).toLocaleDateString()}</span></div>
                <div className="cell wiki-template-actions">
                  {canManage(t) ? (
                    <>
                      <button type="button" className="btn-ghost" onClick={() => onEdit(t.id)}>Edit</button>
                      <button type="button" className="btn-ghost wiki-danger"
                              onClick={() => setDeleting({ template: t, busy: false, error: '' })}>Delete</button>
                    </>
                  ) : (
                    <button type="button" className="btn-ghost" onClick={() => onEdit(t.id)}>View</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {templates === 'loading' && <div className="dir-empty">Loading…</div>}
        {templates === 'error' && <div className="dir-empty"><b>Couldn't load templates</b>Refresh to try again.</div>}
        {Array.isArray(templates) && templates.length === 0 && (
          <div className="dir-empty"><b>No templates yet</b>Add one, or save a page as a template.</div>
        )}
      </div>

      {deleting && (
        <ConfirmDialog
          eyebrow="Templates"
          title={`Delete “${deleting.template.name}”?`}
          description="Pages already made from it keep their content; it just stops showing up as a starting point."
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          busy={deleting.busy}
          error={deleting.error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function EditView({ templateId, isAdmin, space, onBack, onDeleted }: {
  templateId: string;
  isAdmin: boolean;
  space: SpaceOut | null;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [template, setTemplate] = useState<TemplateDetail | 'loading' | 'error'>('loading');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [content, setContent] = useState<JSONContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<{ busy: boolean; error: string } | null>(null);

  useEffect(() => {
    let live = true;
    getTemplate(templateId).then((t) => {
      if (!live) return;
      setTemplate(t);
      setName(t.name);
      setDescription(t.description);
      setIcon(t.icon);
      setContent(t.content_json);
    }).catch(() => { if (live) setTemplate('error'); });
    return () => { live = false; };
  }, [templateId]);

  if (template === 'loading') return <p className="page-hint">Loading…</p>;
  if (template === 'error') return <p className="pf-error">Couldn't load this template.</p>;

  const canManage = canManageTemplate(template, isAdmin, space?.my_level);
  const trimmed = name.trim();
  const dirty = trimmed !== template.name || description !== template.description || icon !== template.icon
    || JSON.stringify(content) !== JSON.stringify(template.content_json);
  const canSave = canManage && !!trimmed && dirty && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError('');
    try {
      const saved = await updateTemplate(templateId, {
        name: trimmed, description, icon, content_json: content ?? EMPTY_DOC,
      });
      setTemplate({ ...template, ...saved, content_json: content ?? EMPTY_DOC });
      toast('Template saved.');
    } catch (err) {
      setError(errorMessage(err, 'Couldn\'t save this template.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting({ busy: true, error: '' });
    try {
      await deleteTemplate(templateId);
      onDeleted();
    } catch (err) {
      setDeleting({ busy: false, error: errorMessage(err, 'Couldn\'t delete this template.') });
    }
  };

  return (
    <div className="wiki-template-edit">
      <button type="button" className="mini-btn" onClick={onBack}>← Back to templates</button>
      <div className="pf-form wiki-template-edit-fields">
        <div>
          <label htmlFor="wiki-tpl-name">Name</label>
          <input id="wiki-tpl-name" value={name} disabled={!canManage || busy} maxLength={200}
                 onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="wiki-tpl-icon">Icon</label>
          <input id="wiki-tpl-icon" value={icon} disabled={!canManage || busy} placeholder="📋" maxLength={8}
                 onChange={(e) => setIcon(e.target.value)} />
        </div>
        <div className="full">
          <label htmlFor="wiki-tpl-desc">Description</label>
          <input id="wiki-tpl-desc" value={description} disabled={!canManage || busy}
                 onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      {error && <p className="pf-error">{error}</p>}
      {!canManage && <p className="page-hint">You can look, but you don't have rights to change this template.</p>}
      <div className="wiki-template-edit-actions">
        <button type="button" className="btn-solid" disabled={!canSave} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        {canManage && (
          <button type="button" className="btn-ghost wiki-danger"
                  onClick={() => setDeleting({ busy: false, error: '' })}>Delete template</button>
        )}
      </div>
      {content && (
        canManage ? <TemplateEditor content={content} onChange={setContent} /> : <ReadOnlyDoc content={content} />
      )}

      {deleting && (
        <ConfirmDialog
          eyebrow="Templates"
          title={`Delete “${template.name}”?`}
          description="Pages already made from it keep their content; it just stops showing up as a starting point."
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          busy={deleting.busy}
          error={deleting.error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

export default function TemplatesPage() {
  const me = useWikiMe();
  const { setCurrentNode } = useWikiShell();
  const [spaces, setSpaces] = useState<SpaceOut[] | null>(null);
  const [scope, setScope] = useState(GLOBAL);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);
  useEffect(() => { listSpaces().then(setSpaces).catch(() => setSpaces([])); }, []);

  const space = spaces?.find((s) => s.key === scope) ?? null;
  const isAdmin = !!me?.is_admin;
  const canCreate = scope === GLOBAL ? isAdmin : atLeast(space?.my_level, 'manage');

  const options = [
    { value: GLOBAL, label: 'Global templates' },
    ...(spaces ?? []).map((s) => ({ value: s.key, label: s.name })),
  ];

  return (
    <div className="portal-page wiki-page wiki-templates-page" data-testid="templates-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Wiki</div>
          <h1 className="page-title">Templates</h1>
          <p className="page-hint">Starting points a new page can pick from.</p>
        </div>
        {!editingId && (
          <ComboBox options={options} value={scope} onChange={(v) => { setScope(v); }}
                    ariaLabel="Scope" placeholder="Choose a space" />
        )}
      </div>

      {editingId ? (
        <EditView templateId={editingId} isAdmin={isAdmin} space={space}
                  onBack={() => setEditingId(null)}
                  onDeleted={() => setEditingId(null)} />
      ) : (
        <ListView scope={scope} space={space} spaces={spaces} isAdmin={isAdmin} canCreate={canCreate}
                  onEdit={setEditingId} onCreated={setEditingId} />
      )}
    </div>
  );
}
