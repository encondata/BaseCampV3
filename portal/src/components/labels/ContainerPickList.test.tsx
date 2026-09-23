// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { ContainerItem } from '../../lib/api';
import ContainerPickList from './ContainerPickList';

afterEach(cleanup);

function container(over: Partial<ContainerItem> = {}): ContainerItem {
  return {
    id: 'c1', name: 'Rack Cart 1', rfid_tag: null,
    container_type: 'cart', type_label: 'Cart', type_color: '#1890ff',
    status: 'available', status_label: 'Available', status_color: '#22aa55',
    site_id: null, site_name: null, location_detail: '', asset_count: 3,
    last_audit_at: null, last_validated_at: null,
    archived_at: null, created_at: '2026-09-01T00:00:00Z',
    initiative_id: null, initiative_name: null,
    ...over,
  };
}

const ROWS: ContainerItem[] = [
  container({ id: 'c1', name: 'Rack Cart 1', type_label: 'Cart', asset_count: 3 }),
  container({ id: 'c2', name: 'Server Bin', type_label: 'Bin', asset_count: 5 }),
  container({ id: 'c3', name: 'Cable Tote', type_label: 'Tote', asset_count: 1 }),
];

it('filters rows by name and type as the search term changes', async () => {
  const user = userEvent.setup();
  render(<ContainerPickList containers={ROWS} selected={[]} tags={{}}
                             onSelectedChange={() => {}} onTagsChange={() => {}} />);
  expect(screen.getByText('Rack Cart 1')).toBeTruthy();
  expect(screen.getByText('Server Bin')).toBeTruthy();
  expect(screen.getByText('Cable Tote')).toBeTruthy();

  await user.type(screen.getByPlaceholderText('Search containers…'), 'tote');
  expect(screen.queryByText('Rack Cart 1')).toBeNull();
  expect(screen.queryByText('Server Bin')).toBeNull();
  expect(screen.getByText('Cable Tote')).toBeTruthy();
});

it('header select-all REPLACES the selection with the filtered ids when checked, and CLEARS it entirely when unchecked (V2 parity)', async () => {
  const user = userEvent.setup();
  // Dedicated fixture (rather than the shared ROWS) so the search term
  // unambiguously matches exactly two of the three rows.
  const AB_ROWS = [
    container({ id: 'c1', name: 'Zulu One' }),
    container({ id: 'c2', name: 'Zulu Two' }),
    container({ id: 'c3', name: 'Yankee Three' }),
  ];
  const onSelectedChange = vi.fn();
  // A selection made OUTSIDE the current filter ('x') does not survive
  // checking select-all — V2 replaces, it doesn't merge.
  const { rerender } = render(
    <ContainerPickList containers={AB_ROWS} selected={['x']} tags={{}}
                       onSelectedChange={onSelectedChange} onTagsChange={() => {}} />,
  );

  await user.type(screen.getByPlaceholderText('Search containers…'), 'zulu'); // matches c1 + c2, not c3
  const headerBox = screen.getByLabelText('Select all filtered containers') as HTMLInputElement;
  fireEvent.click(headerBox);
  expect(onSelectedChange).toHaveBeenCalledWith(['c1', 'c2']);

  rerender(
    <ContainerPickList containers={AB_ROWS} selected={['c1', 'c2', 'c3']} tags={{}}
                       onSelectedChange={onSelectedChange} onTagsChange={() => {}} />,
  );
  // search still "zulu" (rerender preserves the ContainerPickList's own
  // state) — the header checkbox's own checked/indeterminate state stays
  // intersection-based even though the ACTION below is replace/clear.
  const headerBox2 = screen.getByLabelText('Select all filtered containers') as HTMLInputElement;
  expect(headerBox2.checked).toBe(true);
  fireEvent.click(headerBox2);
  // Unchecking clears EVERYTHING, including c3 (outside the filter) — not
  // just the filtered ids.
  expect(onSelectedChange).toHaveBeenLastCalledWith([]);
});

it('header checkbox is indeterminate when some but not all filtered rows are selected', () => {
  render(<ContainerPickList containers={ROWS} selected={['c1']} tags={{}}
                             onSelectedChange={() => {}} onTagsChange={() => {}} />);
  const headerBox = screen.getByLabelText('Select all filtered containers') as HTMLInputElement;
  expect(headerBox.indeterminate).toBe(true);
  expect(headerBox.checked).toBe(false);
});

it('clicking a row toggles its selection', () => {
  const onSelectedChange = vi.fn();
  render(<ContainerPickList containers={ROWS} selected={[]} tags={{}}
                             onSelectedChange={onSelectedChange} onTagsChange={() => {}} />);
  fireEvent.click(screen.getByText('Rack Cart 1'));
  expect(onSelectedChange).toHaveBeenCalledWith(['c1']);
});

it('shows a selection counter and a bulk Set tag control only once something is selected', () => {
  const { rerender } = render(
    <ContainerPickList containers={ROWS} selected={[]} tags={{}}
                        onSelectedChange={() => {}} onTagsChange={() => {}} />,
  );
  expect(screen.queryByText(/selected/)).toBeNull();
  expect(screen.queryByRole('group', { name: /Set tag/ })).toBeNull();

  rerender(
    <ContainerPickList containers={ROWS} selected={['c1', 'c2']} tags={{}}
                        onSelectedChange={() => {}} onTagsChange={() => {}} />,
  );
  expect(screen.getByText('2 selected')).toBeTruthy();
  expect(screen.getByRole('group', { name: /Set tag/ })).toBeTruthy();
});

it('bulk Set tag applies the chosen tag to every selected id, leaving others untouched', () => {
  const onTagsChange = vi.fn();
  render(<ContainerPickList containers={ROWS} selected={['c1', 'c2']} tags={{ c3: 'ewaste' }}
                             onSelectedChange={() => {}} onTagsChange={onTagsChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Vendor' }));
  expect(onTagsChange).toHaveBeenCalledWith({ c1: 'vendor', c2: 'vendor', c3: 'ewaste' });
});

it('bulk "None" clears the tag for every selected id', () => {
  const onTagsChange = vi.fn();
  render(<ContainerPickList containers={ROWS} selected={['c1', 'c3']}
                             tags={{ c1: 'priority', c2: 'vendor', c3: 'priority' }}
                             onSelectedChange={() => {}} onTagsChange={onTagsChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'None' }));
  expect(onTagsChange).toHaveBeenCalledWith({ c2: 'vendor' });
});

it('a per-row tag change only affects that row, and never toggles the row\'s own selection', async () => {
  const user = userEvent.setup();
  const onTagsChange = vi.fn();
  const onSelectedChange = vi.fn();
  render(<ContainerPickList containers={ROWS} selected={[]} tags={{ c2: 'vendor' }}
                             onSelectedChange={onSelectedChange} onTagsChange={onTagsChange} />);
  const trigger = screen.getByLabelText('Tag for Rack Cart 1');

  await user.click(trigger);
  expect(onSelectedChange).not.toHaveBeenCalled();   // opening the popover must not bubble into the row

  const item = await screen.findByRole('menuitem', { name: /Priority/ });
  await user.click(item);
  expect(onTagsChange).toHaveBeenCalledWith({ c1: 'priority', c2: 'vendor' });
  expect(onSelectedChange).not.toHaveBeenCalled();   // nor must picking the tag

  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(onSelectedChange).not.toHaveBeenCalled();   // nor dismissing it via Escape
});

it('reports the filtered id list via onFilteredChange as the search term changes', async () => {
  const user = userEvent.setup();
  const onFilteredChange = vi.fn();
  render(<ContainerPickList containers={ROWS} selected={[]} tags={{}}
                             onSelectedChange={() => {}} onTagsChange={() => {}}
                             onFilteredChange={onFilteredChange} />);
  expect(onFilteredChange).toHaveBeenLastCalledWith(['c1', 'c2', 'c3']);
  await user.type(screen.getByPlaceholderText('Search containers…'), 'tote');
  expect(onFilteredChange).toHaveBeenLastCalledWith(['c3']);
});

it('column floors, shared template + minimum, sideways-scroll card', () => {
  render(<ContainerPickList containers={ROWS} selected={[]} tags={{}}
                             onSelectedChange={() => {}} onTagsChange={() => {}} />);
  const row = screen.getByText('Rack Cart 1').closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^32px /);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Fit: default columns + trailing ≤ 578px (the narrowest of this
  // component's two mount points — see ContainerPickList.tsx's own note).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(578);
});
