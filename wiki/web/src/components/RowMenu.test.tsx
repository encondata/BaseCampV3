// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));

import { ShellContext, type ShellValue } from '../layout/shellContext';
import { makeNode } from '../testing/fixtures';
import RowMenu from './RowMenu';

afterEach(() => { cleanup(); toast.mockReset(); });

function fakeShell(): ShellValue {
  return {
    setCurrentNode: vi.fn(),
    setCurrentSpace: vi.fn(),
    openNewNode: vi.fn(),
    requestDelete: vi.fn(),
    requestMove: vi.fn(),
    requestCopy: vi.fn(),
    requestPermissions: vi.fn(),
    requestShare: vi.fn(),
    requestExport: vi.fn(),
  };
}

function open(node = makeNode('n1'), handlers: Partial<Parameters<typeof RowMenu>[0]> = {}) {
  const props = { node, onNewChild: vi.fn(), onRename: vi.fn(), ...handlers };
  const shell = fakeShell();
  render(<ShellContext.Provider value={shell}><RowMenu {...props} /></ShellContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${node.title}` }));
  return { props, shell };
}

function items(): string[] {
  return screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
}

describe('RowMenu', () => {
  it('shows Copy… and Copy link to someone who can view', () => {
    open(makeNode('n1', { my_level: 'view' }));
    expect(items()).toEqual(['Copy…', 'Copy link']);
  });

  it('shows the edit items at edit level, but not Permissions', () => {
    open(makeNode('n1', { kind: 'folder', my_level: 'edit' }));
    expect(items()).toEqual([
      'New page here', 'New folder here', 'Rename', 'Move…', 'Copy…', 'Copy link', 'Export…', 'Delete',
    ]);
  });

  it('adds Permissions at manage level', () => {
    open(makeNode('n1', { kind: 'folder', my_level: 'manage' }));
    expect(items()).toContain('Permissions…');
  });

  it('never offers New … here on a file, nor Delete on the space home', () => {
    open(makeNode('f', { kind: 'file', my_level: 'manage' }));
    expect(items()).not.toContain('New page here');
    cleanup();
    open(makeNode('home', {
      my_level: 'manage',
      page: { is_home: true, published_version_id: null, published_at: null, has_unpublished_changes: false },
    }));
    expect(items()).not.toContain('Delete');
  });

  it('hands Move…, Copy…, Permissions… and Delete to the shell', () => {
    const node = makeNode('n1', { kind: 'folder', my_level: 'manage' });
    const { shell } = open(node);
    const pick = (name: string) => {
      if (!screen.queryByRole('menu')) fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }));
      fireEvent.click(screen.getByRole('menuitem', { name }));
    };
    pick('Move…');
    expect(shell.requestMove).toHaveBeenCalledWith(node);
    pick('Copy…');
    expect(shell.requestCopy).toHaveBeenCalledWith(node);
    pick('Permissions…');
    expect(shell.requestPermissions).toHaveBeenCalledWith(node);
    pick('Delete');
    expect(shell.requestDelete).toHaveBeenCalledWith(node);
  });

  it('offers Share… on a page or file to a manager, and hands it to the shell', () => {
    const page = makeNode('n1', { kind: 'page', my_level: 'manage' });
    const { shell } = open(page);
    expect(items()).toContain('Share…');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share…' }));
    expect(shell.requestShare).toHaveBeenCalledWith(page);
    cleanup();
    open(makeNode('f1', { kind: 'file', my_level: 'manage' }));
    expect(items()).toContain('Share…');
    cleanup();
    open(makeNode('d1', { kind: 'folder', my_level: 'manage' }));
    expect(items()).not.toContain('Share…');
    cleanup();
    open(makeNode('n2', { kind: 'page', my_level: 'edit' }));
    expect(items()).not.toContain('Share…');
  });

  it('offers Save as template… only for a page with edit and the handler given', () => {
    open(makeNode('n1', { kind: 'page', my_level: 'edit' }));
    expect(items()).not.toContain('Save as template…');
    cleanup();
    const onSaveAsTemplate = vi.fn();
    open(makeNode('n1', { kind: 'page', my_level: 'edit' }), { onSaveAsTemplate });
    expect(items()).toContain('Save as template…');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as template…' }));
    expect(onSaveAsTemplate).toHaveBeenCalled();
    cleanup();
    open(makeNode('n1', { kind: 'page', my_level: 'view' }), { onSaveAsTemplate });
    expect(items()).not.toContain('Save as template…');
    cleanup();
    open(makeNode('n1', { kind: 'folder', my_level: 'manage' }), { onSaveAsTemplate });
    expect(items()).not.toContain('Save as template…');
  });

  it('offers Use as help for… on a page or file only where the caller passes it (wiki admins)', () => {
    open(makeNode('n1', { kind: 'page', my_level: 'manage' }));
    expect(items()).not.toContain('Use as help for…');
    cleanup();
    const onUseAsHelp = vi.fn();
    // a wiki admin's level anywhere is manage, but the handler is the gate
    open(makeNode('n1', { kind: 'page', my_level: 'view' }), { onUseAsHelp });
    expect(items()).toContain('Use as help for…');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use as help for…' }));
    expect(onUseAsHelp).toHaveBeenCalled();
    cleanup();
    open(makeNode('f1', { kind: 'file', my_level: 'manage' }), { onUseAsHelp });
    expect(items()).toContain('Use as help for…');
    cleanup();
    open(makeNode('d1', { kind: 'folder', my_level: 'manage' }), { onUseAsHelp });
    expect(items()).not.toContain('Use as help for…');
  });

  it('offers Export… on a folder, and on a page once published or with subpages — never a file', () => {
    const published = { is_home: false, published_version_id: 'v1', published_at: null, has_unpublished_changes: false };
    const folder = makeNode('f', { kind: 'folder', my_level: 'view' });
    const { shell } = open(folder);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    expect(shell.requestExport).toHaveBeenCalledWith({ kind: 'node', node: folder });
    cleanup();

    open(makeNode('p', { my_level: 'view', page: published }));
    expect(items()).toContain('Export…');
    cleanup();
    open(makeNode('p', { my_level: 'edit', has_children: true }));
    expect(items()).toContain('Export…');
    cleanup();
    // a never-published page on its own has nothing to export
    open(makeNode('p', { my_level: 'edit' }));
    expect(items()).not.toContain('Export…');
    cleanup();
    open(makeNode('f', { kind: 'file', my_level: 'manage' }));
    expect(items()).not.toContain('Export…');
  });

  it('copies the canonical link and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open(makeNode('n1', { my_level: 'view' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/n/n1`);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Link copied.'));
  });
});
