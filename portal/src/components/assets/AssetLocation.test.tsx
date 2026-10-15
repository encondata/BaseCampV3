// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import AssetLocation from './AssetLocation';

afterEach(cleanup);

const mount = (asset: React.ComponentProps<typeof AssetLocation>['asset'], className?: string) =>
  render(<MemoryRouter><AssetLocation asset={asset} className={className} /></MemoryRouter>);

it('renders the container and truck as links with the right hrefs', () => {
  const { container } = mount({
    location_detail: 'Bay 3', container_id: 'c1', container_name: 'ATL1-W1M-DC-01',
    truck_id: 't1', truck_name: 'ATL1-T01 (Wave 1)',
  });
  const c = screen.getByRole('link', { name: 'ATL1-W1M-DC-01' });
  const t = screen.getByRole('link', { name: 'ATL1-T01 (Wave 1)' });
  expect(c.getAttribute('href')).toBe('/logistics/containers?open=c1');
  expect(t.getAttribute('href')).toBe('/logistics/trucks/t1');
  expect(container.textContent).toBe('ATL1-W1M-DC-01 · on ATL1-T01 (Wave 1)');
});

it('renders only the container link when there is no truck', () => {
  const { container } = mount({ location_detail: 'Bay 3', container_id: 'c1', container_name: 'Crate A' });
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(container.textContent).toBe('Crate A');
});

it('falls back to the location text without a container', () => {
  const { container } = mount({ location_detail: 'Rack 3' });
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(container.textContent).toBe('Rack 3');
});

it('shows a dash when there is nothing to show', () => {
  const a = mount({ location_detail: '' });
  expect(a.container.textContent).toBe('—');
  cleanup();
  const b = mount({ location_detail: null });
  expect(b.container.textContent).toBe('—');
});

it('applies the className to the wrapper', () => {
  const { container } = mount({ location_detail: 'Rack 3' }, 'cell-top cell-line');
  expect((container.firstChild as HTMLElement).className).toBe('cell-top cell-line');
});

it('a click on a link does not bubble to a row handler', () => {
  const onRow = vi.fn();
  render(
    <MemoryRouter>
      <div onClick={onRow}>
        <AssetLocation asset={{ container_id: 'c1', container_name: 'Crate A', truck_id: 't1', truck_name: 'T1' }} />
      </div>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Crate A' }));
  fireEvent.click(screen.getByRole('link', { name: 'T1' }));
  expect(onRow).not.toHaveBeenCalled();
});
