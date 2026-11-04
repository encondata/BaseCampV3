/**
 * Templates (More › Templates…): the saved plan templates, one card each
 * (its name, description, task count, who saved it and when it last
 * changed), by name. A card's Actions menu (RowActionsMenu, with its Tip)
 * holds Rename and Edit description (`project_plans:change`), each editing
 * in place in the card and sent as one PATCH, and Delete…
 * (`project_plans:delete`), which asks first in a confirm on top
 * (PlanConfirmModals' DeleteTemplateModal). Someone without either sees
 * the list alone. A list that fails to load says “Couldn’t load
 * templates.” beside Try again.
 *
 * In an editor Enter saves the name (the description is a textarea: its
 * Save button saves), Escape cancels without closing the dialog, and an
 * unchanged value sends nothing. A refusal (a taken name: 409
 * `template_exists`) keeps the editor and what was typed, with the reason.
 * Templates belong to no plan, so nothing here goes through the
 * PlanController.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { longDate } from '../../lib/format';
import { naturalCompare } from '../../lib/naturalSort';
import { useToast } from '../../lib/notificationsContext';
import {
  deletePlanTemplate, listPlanTemplates, patchPlanTemplate, type PlanPermissions, type PlanTemplate,
  type PlanTemplatePatch,
} from '../../lib/plans/api';
import { COMMAND_TIPS } from '../../lib/plans/commandTips';
import { TEMPLATES_UNLOADED, planErrorText } from '../../lib/plans/errors';
import { DotsIcon, RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import Tip from '../Tip';
import { DeleteTemplateModal } from './PlanConfirmModals';
import PlanModal from './PlanModal';
import { MAX_TEMPLATE_DESCRIPTION, MAX_TEMPLATE_NAME, NAME_REQUIRED, templateErrorText } from './SaveTemplateModal';

import '../../styles/profile.css';   // .pf-form, .btn-solid

export const TEMPLATE_DELETED = 'Template deleted.';

type Field = 'name' | 'description';
type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; templates: PlanTemplate[] };

const byName = (list: PlanTemplate[]) => [...list].sort((a, b) => naturalCompare(a.name, b.name));

/** "12 tasks · Saved by Jimmy Henderson · Nov 2, 2026" */
function metaText(t: PlanTemplate): string {
  const parts = [t.task_count === 1 ? '1 task' : `${t.task_count.toLocaleString('en-US')} tasks`];
  if (t.created_by_name) parts.push(`Saved by ${t.created_by_name}`);
  parts.push(longDate(t.updated_at));
  return parts.join(' · ');
}

export default function TemplatesModal({ permissions, onClose }: {
  permissions: Pick<PlanPermissions, 'change' | 'delete'>;
  onClose(): void;
}) {
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [editing, setEditing] = useState<{ id: string; field: Field } | null>(null);
  const [deleting, setDeleting] = useState<PlanTemplate | null>(null);
  const alive = useRef(true);
  // set on every mount: StrictMode's dev remount runs the cleanup first
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const fetchList = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const templates = await listPlanTemplates();
      if (alive.current) setLoad({ state: 'ready', templates: byName(templates) });
    } catch {
      if (alive.current) setLoad({ state: 'error' });
    }
  }, []);
  useEffect(() => { void fetchList(); }, [fetchList]);

  const replace = (saved: PlanTemplate) => setLoad((now) => (now.state === 'ready'
    ? { state: 'ready', templates: byName(now.templates.map((t) => (t.id === saved.id ? saved : t))) }
    : now));

  /** One PATCH; the refusal in words, or null once saved. */
  const patch = async (id: string, body: PlanTemplatePatch): Promise<string | null> => {
    try {
      replace(await patchPlanTemplate(id, body));
    } catch (err) {
      return templateErrorText(err);
    }
    setEditing(null);
    return null;
  };

  const remove = async (template: PlanTemplate): Promise<string | null> => {
    try {
      await deletePlanTemplate(template.id);
    } catch (err) {
      return planErrorText(err);
    }
    setLoad((now) => (now.state === 'ready'
      ? { state: 'ready', templates: now.templates.filter((t) => t.id !== template.id) }
      : now));
    toast(TEMPLATE_DELETED);
    return null;
  };

  let body;
  if (load.state === 'loading') {
    body = <p className="pln-note">Loading templates…</p>;
  } else if (load.state === 'error') {
    body = (
      <div className="pln-tmpl-problem">
        <p className="pf-error" role="alert">{TEMPLATES_UNLOADED}</p>
        <button type="button" className="mini-btn" onClick={() => void fetchList()}>Try again</button>
      </div>
    );
  } else if (load.templates.length === 0) {
    body = (
      <p className="pln-note pln-tmpl-none">
        No templates yet. Make one with Save as template… in a plan’s More menu.
      </p>
    );
  } else {
    body = (
      <ul className="pln-tmpls" aria-label="Templates">
        {load.templates.map((t) => (
          <TemplateCard key={t.id} template={t} permissions={permissions}
                        editing={editing?.id === t.id ? editing.field : null}
                        onEdit={(field) => setEditing({ id: t.id, field })}
                        onCancel={() => setEditing(null)}
                        onSave={(body) => patch(t.id, body)}
                        onDelete={() => setDeleting(t)} />
        ))}
      </ul>
    );
  }

  return (
    <>
      <PlanModal title="Templates" onClose={onClose}
                 description="The saved plans a new project plan can start from."
                 footer={<button type="button" className="btn-solid" onClick={onClose}>Done</button>}>
        {body}
      </PlanModal>
      {deleting && (
        <DeleteTemplateModal name={deleting.name} remove={() => remove(deleting)}
                             onClose={() => setDeleting(null)} />
      )}
    </>
  );
}

function TemplateCard({ template: t, permissions, editing, onEdit, onCancel, onSave, onDelete }: {
  template: PlanTemplate;
  permissions: Pick<PlanPermissions, 'change' | 'delete'>;
  editing: Field | null;
  onEdit(field: Field): void;
  onCancel(): void;
  onSave(body: PlanTemplatePatch): Promise<string | null>;
  onDelete(): void;
}) {
  const card = useRef<HTMLLIElement>(null);
  const was = useRef<Field | null>(editing);
  // an editor closing hands focus back to the card's Actions button
  useEffect(() => {
    if (was.current && !editing) {
      card.current?.querySelector<HTMLElement>('button[aria-haspopup="menu"]')?.focus();
    }
    was.current = editing;
  }, [editing]);

  const actions: RowAction[] = [];
  if (permissions.change) {
    actions.push(
      { key: 'rename', label: 'Rename', onSelect: () => onEdit('name') },
      { key: 'describe', label: 'Edit description', onSelect: () => onEdit('description') },
    );
  }
  if (permissions.delete) actions.push({ key: 'delete', label: 'Delete…', onSelect: onDelete, destructive: true });
  const tip = COMMAND_TIPS[permissions.change ? (permissions.delete ? 'templateActions' : 'templateActionsEdit')
    : 'templateActionsDelete'];
  const menuName = `Actions for ${t.name}`;

  return (
    <li className="pln-tmpl" ref={card}>
      <div className="pln-tmpl-main">
        {editing === 'name' ? (
          <FieldEditor field="name" initial={t.name} onSave={onSave} onCancel={onCancel} />
        ) : (
          <span className="pln-tmpl-name">{t.name}</span>
        )}
        {editing === 'description' ? (
          <FieldEditor field="description" initial={t.description ?? ''} onSave={onSave} onCancel={onCancel} />
        ) : (
          <span className={`pln-tmpl-desc${t.description ? '' : ' none'}`}>{t.description ?? 'No description'}</span>
        )}
        <span className="pln-note">{metaText(t)}</span>
      </div>
      {actions.length > 0 && !editing && (
        <Tip label={menuName} desc={tip.desc}>
          <RowActionsMenu label={menuName} icon={<DotsIcon />} triggerClassName="mini-btn pln-tmpl-menu"
                          actions={actions} />
        </Tip>
      )}
    </li>
  );
}

/** A name (input: Enter saves) or a description (textarea) edited in place. */
function FieldEditor({ field, initial, onSave, onCancel }: {
  field: Field;
  initial: string;
  onSave(body: PlanTemplatePatch): Promise<string | null>;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = input.current ?? area.current;
    el?.focus();
    el?.select();
  }, []);

  const save = async () => {
    const text = value.trim();
    if (field === 'name' && !text) {
      setError(NAME_REQUIRED);
      return;
    }
    if (text === initial.trim()) {
      onCancel();
      return;
    }
    setBusy(true);
    setError('');
    const refused = await onSave(field === 'name' ? { name: text } : { description: text || null });
    if (refused !== null) {
      setError(refused);
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) void save();
  };
  // Escape is the editor's: it cancels, and the dialog stays open
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || busy) return;
    e.preventDefault();
    onCancel();
  };

  const id = `pln-tmpl-${field}`;
  return (
    <form className="pf-form pln-tmpl-edit" onSubmit={onSubmit} onKeyDown={onKeyDown}>
      <div className="full">
        {field === 'name' ? (
          <input ref={input} id={id} type="text" aria-label="Template name" value={value} autoComplete="off"
                 maxLength={MAX_TEMPLATE_NAME} disabled={busy} aria-invalid={error ? true : undefined}
                 onChange={(e) => setValue(e.target.value)} />
        ) : (
          <textarea ref={area} id={id} className="pln-text-field" aria-label="Description" rows={3} value={value}
                    maxLength={MAX_TEMPLATE_DESCRIPTION} disabled={busy} aria-invalid={error ? true : undefined}
                    onChange={(e) => setValue(e.target.value)} />
        )}
      </div>
      <div className="full pln-tmpl-btns">
        <button type="submit" className="mini-btn accent" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="mini-btn" disabled={busy} onClick={onCancel}>Cancel</button>
        {error && <span className="pf-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
