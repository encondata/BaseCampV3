// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import DataTable from './DataTable';

afterEach(cleanup);

describe('DataTable', () => {
  it('renders head/body with alignment and mono classes', () => {
    render(<DataTable ariaLabel="Leases"
      columns={[{ key: 'host', label: 'Hostname' }, { key: 'mac', label: 'MAC', mono: true, align: 'right', width: '140px' }]}
      rows={[{ key: 'r1', cells: ['nas-1', 'AA:BB'] }]} />);
    const table = screen.getByRole('table', { name: 'Leases' });
    expect(table.className).toContain('data-table');
    expect(screen.getByText('Hostname').tagName).toBe('TH');
    expect(screen.getByText('Hostname').getAttribute('scope')).toBe('col');
    const mac = screen.getByText('AA:BB');
    expect(mac.tagName).toBe('TD');
    expect(mac.className).toContain('mono');
    expect(mac.className).toContain('right');
    // the 'mac' column carries width: '140px'; 'host' has none, so its
    // <col> renders without a style attribute (querySelector('col') alone
    // would hit that first, styleless <col> instead).
    expect(table.querySelector('col[style]')?.getAttribute('style')).toContain('140px');
  });
  it('renders the empty row', () => {
    render(<DataTable columns={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]} rows={[]} emptyText="No leases." />);
    const empty = screen.getByText('No leases.');
    expect(empty.getAttribute('colspan')).toBe('2');
  });
  it('renders an extra cell beyond the column count without throwing', () => {
    render(<DataTable columns={[{ key: 'a', label: 'A' }]}
      rows={[{ key: 'r1', cells: ['x', 'y'] }]} />);
    const extra = screen.getByText('y');
    expect(extra.tagName).toBe('TD');
    expect(extra.className).toBe('');
  });
  it('wraps the table in a sideways-scroll block', () => {
    const { container } = render(<DataTable columns={[{ key: 'a', label: 'A' }]} rows={[{ key: '1', cells: ['x'] }]} />);
    const wrap = container.querySelector('.data-table-scroll') as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.querySelector('table.data-table')).not.toBeNull();
  });
});
