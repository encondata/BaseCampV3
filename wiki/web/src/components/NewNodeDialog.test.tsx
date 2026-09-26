// @vitest-environment jsdom
import '../testing/pmDom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  createNode: vi.fn(),
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
}));
vi.mock('../lib/treeStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/treeStore')>()),
  noteCreated: vi.fn(),
}));

import { noteCreated } from '../lib/treeStore';
import { createNode, listTemplates } from '../lib/wikiApi';
import { makeNode } from '../testing/fixtures';
import NewNodeDialog from './NewNodeDialog';

const RUNBOOK = {
  id: 't-1', space_id: null, space_key: null, name: 'Runbook', description: '', icon: '',
  is_builtin: true, created_by: null, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
};

function Probe() {
  const loc = useLocation();
  return <div>at {loc.pathname}{loc.search}</div>;
}

function renderDialog(props: Partial<Parameters<typeof NewNodeDialog>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <MemoryRouter initialEntries={['/n/f1']}>
      <Routes>
        <Route path="*" element={(
          <>
            <NewNodeDialog kind="page" spaceId="space-1" spaceKey="ops" parentId="f1" parentTitle="Guides"
                           onClose={onClose} {...props} />
            <Probe />
          </>
        )} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose, ...utils };
}

beforeEach(() => {
  vi.mocked(createNode).mockReset();
  vi.mocked(listTemplates).mockReset().mockResolvedValue([RUNBOOK]);
  vi.mocked(noteCreated).mockReset();
});
afterEach(cleanup);

describe('NewNodeDialog — folder', () => {
  it('requires a title and creates a folder with no template step', async () => {
    vi.mocked(createNode).mockResolvedValue(makeNode('new-f', { kind: 'folder', title: 'Racks' }));
    const { onClose } = renderDialog({ kind: 'folder' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    const create = screen.getByRole('button', { name: 'Create folder' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Racks' } });
    fireEvent.click(create);
    expect(await screen.findByText('at /n/new-f')).toBeTruthy();
    expect(createNode).toHaveBeenCalledWith({ space_id: 'space-1', parent_id: 'f1', kind: 'folder', title: 'Racks' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('NewNodeDialog — page, title step', () => {
  it('offers "Start from a template…" and creates a blank page by title alone', async () => {
    vi.mocked(createNode).mockResolvedValue(makeNode('new-p', { title: 'Cutover plan' }));
    renderDialog();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Cutover plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    expect(await screen.findByText('at /n/new-p?edit=1')).toBeTruthy();
    expect(createNode).toHaveBeenCalledWith({
      space_id: 'space-1', parent_id: 'f1', kind: 'page', title: 'Cutover plan',
    });
  });

  it('switches to the template step and back, keeping the picked template', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Start from a template…' }));
    expect(await screen.findByRole('radiogroup', { name: 'Starting point' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('radio', { name: /Runbook/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('button', { name: 'Change starting point…' })).toBeTruthy();
  });

  it('creates from a template with a blank title, letting the server default the name', async () => {
    vi.mocked(createNode).mockResolvedValue(makeNode('new-p2', { title: 'Runbook' }));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Start from a template…' }));
    fireEvent.click(await screen.findByRole('radio', { name: /Runbook/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Change starting point…' });
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    expect(await screen.findByText('at /n/new-p2?edit=1')).toBeTruthy();
    expect(createNode).toHaveBeenCalledWith({
      space_id: 'space-1', parent_id: 'f1', kind: 'page', template_id: 't-1',
    });
  });
});

describe('NewNodeDialog — startStep', () => {
  it('opens straight on the template picker for "From template…"', async () => {
    renderDialog({ startStep: 'template' });
    expect(await screen.findByRole('radiogroup', { name: 'Starting point' })).toBeTruthy();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });
});
