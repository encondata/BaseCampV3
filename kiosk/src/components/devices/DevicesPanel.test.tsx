// @vitest-environment jsdom
/** Settings › Devices: the panel's grid of device cards and the shared
 *  card shell (title, pill, details, a bottom-pinned button row). */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getReaderStatus: vi.fn(), getReaderDevice: vi.fn(), runCheck: vi.fn(),
}));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, ...api };
});

import DeviceCard from './DeviceCard';
import DevicesPanel from './DevicesPanel';

afterEach(cleanup);

describe('DeviceCard', () => {
  it('button_rows_use_the_bottom_pinned_actions_slot', () => {
    render(
      <DeviceCard title="Thing" pill={{ label: 'Ready', tone: 'green' }}
                  actions={<button type="button" className="mini-btn">Go</button>}>
        <p>Body</p>
      </DeviceCard>,
    );
    const card = document.querySelector('.device-card') as HTMLElement;
    expect(screen.getByRole('heading', { name: 'Thing' })).toBeTruthy();
    const chip = card.querySelector('.device-card-head .chip') as HTMLElement;
    expect(chip.textContent).toBe('Ready');
    expect(chip.className).toContain('c-green');
    const actions = card.lastElementChild as HTMLElement;
    expect(actions.className).toBe('device-card-actions');
    expect(actions.contains(screen.getByRole('button', { name: 'Go' }))).toBe(true);
  });

  it('no pill and no actions render neither', () => {
    render(<DeviceCard title="Thing" pill={null}><p>Body</p></DeviceCard>);
    expect(document.querySelector('.chip')).toBeNull();
    expect(document.querySelector('.device-card-actions')).toBeNull();
  });
});

describe('DevicesPanel', () => {
  it('lays out the reader and scanner cards (web mode: no edge calls)', () => {
    render(<MemoryRouter><DevicesPanel /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'RFID reader' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Barcode scanner' })).toBeTruthy();
    expect(document.querySelector('.devices-grid')).toBeTruthy();
    expect(api.getReaderStatus).not.toHaveBeenCalled();
    expect(api.getReaderDevice).not.toHaveBeenCalled();
  });
});
