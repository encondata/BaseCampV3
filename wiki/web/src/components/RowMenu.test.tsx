// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));

import { makeNode } from '../testing/fixtures';
import RowMenu from './RowMenu';

afterEach(() => { cleanup(); toast.mockReset(); });

function open(node = makeNode('n1'), handlers: Partial<Parameters<typeof RowMenu>[0]> = {}) {
  const props = {
    node,
    onNewChild: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onRequestMove: vi.fn(),
    onRequestPermissions: vi.fn(),
    ...handlers,
  };
  render(<RowMenu {...props} />);
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${node.title}` }));
  return props;
}

function items(): string[] {
  return screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
}

describe('RowMenu', () => {
  it('shows only Copy link to someone who can view', () => {
    open(makeNode('n1', { my_level: 'view' }));
    expect(items()).toEqual(['Copy link']);
  });

  it('shows the edit items at edit level, but not Permissions', () => {
    open(makeNode('n1', { kind: 'folder', my_level: 'edit' }));
    expect(items()).toEqual([
      'New page here', 'New folder here', 'Rename', 'Move…', 'Copy link', 'Delete',
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

  it('hands Move… and Permissions… to the caller', () => {
    const node = makeNode('n1', { kind: 'folder', my_level: 'manage' });
    const props = open(node);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move…' }));
    expect(props.onRequestMove).toHaveBeenCalledWith(node);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions…' }));
    expect(props.onRequestPermissions).toHaveBeenCalledWith(node);
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
