// @vitest-environment jsdom
import '../testing/pmDom';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  listSpaces: vi.fn(),
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));

import { clearWikiMe } from '../lib/useWikiMe';
import {
  createTemplate, deleteTemplate, getMe, getTemplate, listSpaces, listTemplates, updateTemplate,
} from '../lib/wikiApi';
import { makeMe, makeSpace } from '../testing/fixtures';
import TemplatesPage from './TemplatesPage';

const BUILTIN = {
  id: 'b-1', space_id: null, space_key: null, name: 'Runbook', description: 'Standard runbook', icon: '📋',
  is_builtin: true, created_by: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};
const GLOBAL_TPL = {
  id: 'g-1', space_id: null, space_key: null, name: 'Meeting notes', description: '', icon: '',
  is_builtin: false, created_by: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};
const SPACE_TPL = {
  id: 's-1', space_id: 'space-1', space_key: 'ops', name: 'Move plan', description: '', icon: '',
  is_builtin: false, created_by: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};

function renderPage() {
  return render(<MemoryRouter><TemplatesPage /></MemoryRouter>);
}

beforeEach(() => {
  clearWikiMe();
  toast.mockReset();
  vi.mocked(listSpaces).mockReset().mockResolvedValue([makeSpace()]);
  vi.mocked(listTemplates).mockReset().mockResolvedValue([BUILTIN, GLOBAL_TPL]);
  vi.mocked(getTemplate).mockReset();
  vi.mocked(createTemplate).mockReset();
  vi.mocked(updateTemplate).mockReset();
  vi.mocked(deleteTemplate).mockReset();
});
afterEach(cleanup);

describe('TemplatesPage — list', () => {
  it('lists global templates by default, without a New button for a non-admin', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: false }));
    renderPage();
    const list = await screen.findByRole('list', { name: 'Templates' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual(['📋 Runbook', 'Meeting notes']);
    expect(within(rows[0]).getByText('Built in')).toBeTruthy();
    expect(within(rows[0]).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(rows[1]).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(rows[1]).getByRole('button', { name: 'View' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'New template' }) as HTMLButtonElement).disabled).toBe(true);
    expect(listTemplates).toHaveBeenCalledWith(undefined);
  });

  it('lets a wiki admin manage global templates and add one', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: true }));
    vi.mocked(createTemplate).mockResolvedValue({ ...GLOBAL_TPL, id: 'g-2', name: 'Untitled template' });
    vi.mocked(getTemplate).mockResolvedValue({ ...GLOBAL_TPL, id: 'g-2', name: 'Untitled template', content_json: { type: 'doc', content: [] } });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Templates' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[1]).getByRole('button', { name: 'Edit' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith({
      space_id: null, name: 'Untitled template', content_json: { type: 'doc', content: [{ type: 'paragraph' }] },
    }));
    expect(await screen.findByLabelText('Name')).toHaveProperty('value', 'Untitled template');
  });

  it('lists a space\'s own templates once picked, and lets a space manager add one', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: false }));
    vi.mocked(listSpaces).mockResolvedValue([makeSpace({ my_level: 'manage' })]);
    vi.mocked(listTemplates).mockResolvedValue([BUILTIN, GLOBAL_TPL, SPACE_TPL]);
    renderPage();
    await screen.findByRole('list', { name: 'Templates' });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Scope' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Operations' }));
    await waitFor(() => expect(listTemplates).toHaveBeenCalledWith('ops'));
    const list = await screen.findByRole('list', { name: 'Templates' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual(['📋 Runbook', 'Meeting notes', 'Move plan']);
    // manages the space's own, but not the other global one
    expect(within(rows[1]).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(rows[2]).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'New template' }) as HTMLButtonElement).disabled).toBe(false);
    // the picked space's own templates read "This space", like the picker
    expect(within(rows[2]).getByText('This library')).toBeTruthy();
  });

  it('names another space\'s template by the space\'s name, not its key', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: false }));
    vi.mocked(listSpaces).mockResolvedValue([
      makeSpace({ my_level: 'manage' }),
      makeSpace({ id: 'space-2', key: 'net', name: 'Networking' }),
    ]);
    vi.mocked(listTemplates).mockResolvedValue([
      BUILTIN, { ...SPACE_TPL, id: 's-2', space_id: 'space-2', space_key: 'net', name: 'Switch swap' },
    ]);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Templates' });
    await waitFor(() => expect(within(list).getByText('Networking')).toBeTruthy());
    expect(within(list).queryByText('net')).toBeNull();
  });

  it('deletes a template after confirming', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: true }));
    vi.mocked(deleteTemplate).mockResolvedValue(undefined);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Templates' });
    fireEvent.click(within(list).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith('g-1'));
    expect(toast).toHaveBeenCalledWith('Deleted “Meeting notes”.');
  });
});

describe('TemplatesPage — edit', () => {
  it('edits a template\'s fields and content, then saves', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: true }));
    vi.mocked(getTemplate).mockResolvedValue({
      ...GLOBAL_TPL, content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] },
    });
    vi.mocked(updateTemplate).mockResolvedValue({ ...GLOBAL_TPL, name: 'Weekly notes' });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Templates' });
    fireEvent.click(within(list).getByRole('button', { name: 'Edit' }));
    const name = await screen.findByLabelText('Name');
    expect(name).toHaveProperty('value', 'Meeting notes');
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    fireEvent.change(name, { target: { value: 'Weekly notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateTemplate).toHaveBeenCalledWith('g-1', {
      name: 'Weekly notes', description: '', icon: '',
      content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] },
    }));
    expect(toast).toHaveBeenCalledWith('Template saved.');
  });

  it('shows content read-only, with no Save, for someone without rights', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: false }));
    vi.mocked(getTemplate).mockResolvedValue({
      ...GLOBAL_TPL, content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read only body' }] }] },
    });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Templates' });
    const rows = within(list).getAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'View' }));
    expect(await screen.findByText('Read only body')).toBeTruthy();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Delete template' })).toBeNull();
    expect(screen.getByText(/don't have rights to change this template/)).toBeTruthy();
  });

  it('goes back to the list', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: true }));
    vi.mocked(getTemplate).mockResolvedValue({ ...GLOBAL_TPL, content_json: { type: 'doc', content: [] } });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Templates' });
    fireEvent.click(within(list).getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: '← Back to templates' }));
    expect(await screen.findByRole('list', { name: 'Templates' })).toBeTruthy();
  });
});
