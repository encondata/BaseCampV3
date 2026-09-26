// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  createTemplate: vi.fn(),
}));

import { clearWikiMe } from '../lib/useWikiMe';
import { createTemplate, getMe } from '../lib/wikiApi';
import { makeDetail, makeMe } from '../testing/fixtures';
import SaveAsTemplateDialog from './SaveAsTemplateDialog';

function renderDialog(over: Parameters<typeof makeDetail>[1] = {}, admin = false) {
  vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: admin }));
  const node = makeDetail('p1', { title: 'Cutover plan', ...over });
  const onClose = vi.fn();
  const utils = render(<SaveAsTemplateDialog node={node} onClose={onClose} />);
  return { onClose, node, ...utils };
}

beforeEach(() => {
  clearWikiMe();
  toast.mockReset();
  vi.mocked(createTemplate).mockReset();
});
afterEach(cleanup);

describe('SaveAsTemplateDialog', () => {
  it('defaults the name to the page title and scope to the space, when the caller manages it', async () => {
    renderDialog({ space: { ...makeDetail('p1').space, my_level: 'manage' } });
    expect(await screen.findByLabelText('Name')).toHaveProperty('value', 'Cutover plan');
    expect(screen.getByRole('button', { name: 'This library' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('saves to the space with a custom name and description', async () => {
    vi.mocked(createTemplate).mockResolvedValue({
      id: 't-1', space_id: 'space-1', space_key: 'ops', name: 'Move runbook', description: 'For moves',
      icon: '', is_builtin: false, created_by: null, created_at: '2026-09-26T00:00:00Z', updated_at: '2026-09-26T00:00:00Z',
    });
    const { onClose } = renderDialog({ space: { ...makeDetail('p1').space, my_level: 'manage' } });
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Move runbook' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'For moves' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as template' }));
    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith({
      space_id: 'space-1', name: 'Move runbook', description: 'For moves', icon: undefined, from_node_id: 'p1',
    }));
    expect(toast).toHaveBeenCalledWith('Saved “Move runbook” as a template.');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers Global to a wiki admin and saves with a null space', async () => {
    vi.mocked(createTemplate).mockResolvedValue({
      id: 't-2', space_id: null, space_key: null, name: 'Cutover plan', description: '', icon: '',
      is_builtin: false, created_by: null, created_at: '2026-09-26T00:00:00Z', updated_at: '2026-09-26T00:00:00Z',
    });
    renderDialog({ space: { ...makeDetail('p1').space, my_level: 'view' } }, true);
    const globalBtn = await screen.findByRole('button', { name: 'Global' });
    expect(globalBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'This library' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Save as template' }));
    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith(expect.objectContaining({ space_id: null })));
  });

  it('shows a message and disables Save when there is no scope available', async () => {
    renderDialog({ space: { ...makeDetail('p1').space, my_level: 'view' } }, false);
    expect(await screen.findByText(/You need manage rights/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as template' })).toHaveProperty('disabled', true);
  });

  it('reports a failed save and keeps the dialog open', async () => {
    vi.mocked(createTemplate).mockRejectedValue(new Error('nope'));
    const { onClose } = renderDialog({ space: { ...makeDetail('p1').space, my_level: 'manage' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save as template' }));
    expect(await screen.findByText(/Couldn't save this as a template/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
