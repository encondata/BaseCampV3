// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { makeNode } from '../testing/fixtures';
import { NodeChips, PrivateMark } from './NodeMarks';

afterEach(cleanup);

describe('PrivateMark', () => {
  it('is a lock named "Private" on a private item, and nothing on any other', () => {
    const { rerender } = render(<PrivateMark node={makeNode('n1', { is_private: true })} />);
    expect(screen.getByRole('img', { name: 'Private' })).toBeTruthy();
    rerender(<PrivateMark node={makeNode('n1')} />);
    expect(screen.queryByRole('img', { name: 'Private' })).toBeNull();
  });
});

describe('NodeChips', () => {
  it('shows nothing for an ordinary item', () => {
    const { container } = render(<NodeChips node={makeNode('n1')} />);
    expect(container.textContent).toBe('');
  });

  it('shows Private and Printing off, each only when it applies', () => {
    const { rerender } = render(<NodeChips node={makeNode('n1', { is_private: true })} />);
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.queryByText('Printing off')).toBeNull();

    rerender(<NodeChips node={makeNode('n1', { can_print: false })} />);
    expect(screen.getByText('Printing off').closest('.chip')?.getAttribute('title'))
      .toBe('Printing is turned off for this page.');
    expect(screen.queryByText('Private')).toBeNull();

    rerender(<NodeChips node={makeNode('n1', { kind: 'folder', page: null, can_print: false, is_private: true })} />);
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText('Printing off').closest('.chip')?.getAttribute('title'))
      .toBe('Printing is turned off for this folder.');
  });
});
