// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ runCheck: vi.fn(), startReader: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, ...apiMock };
});

import { ApiError, type CheckName } from '../../lib/api';
import ConfirmStep from './ConfirmStep';

const SETUP = {
  initiativeName: 'NAP11 Move', siteName: 'NAP22 Hall', siteRole: 'destination' as const,
  scanLabel: 'RFID 1 - Cage Exit',
};
const READER = { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600',
                 endpoint_url: 'http://10.0.0.9:8091/rfid/1234ABCD/…' };
const ok = (name: CheckName) => ({ name, ok: true, state: 'ok' as const, detail: '' });

beforeEach(() => {
  apiMock.runCheck.mockReset().mockImplementation((n: CheckName) => Promise.resolve(ok(n)));
  apiMock.startReader.mockReset().mockResolvedValue({ reading: true });
});
afterEach(cleanup);

async function settle() { await act(async () => { await Promise.resolve(); }); }

function setup(props: Partial<React.ComponentProps<typeof ConfirmStep>> = {}) {
  const fns = { onBack: vi.fn(), onStarted: vi.fn(), onPairAgain: vi.fn() };
  render(<ConfirmStep setup={SETUP} reader={READER} {...fns} {...props} />);
  return fns;
}

describe('ConfirmStep', () => {
  it('shows the summary card', async () => {
    setup();
    await settle();
    for (const text of ['NAP11 Move', 'NAP22 Hall (destination)', 'RFID 1 - Cage Exit',
      'FX9600 1234ABCD at 10.0.0.5', 'http://10.0.0.9:8091/rfid/1234ABCD/…']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it('shows dashes with no reader', async () => {
    setup({ reader: null });
    await settle();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('runs reader, portal, setup in order; Start Reader enables when all pass', async () => {
    setup();
    await settle();
    expect(apiMock.runCheck.mock.calls.map((c) => c[0])).toEqual(['reader', 'portal', 'setup']);
    expect(screen.getAllByLabelText('passed')).toHaveLength(3);
    expect((screen.getByRole('button', { name: 'Start Reader' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('Start Reader is disabled while checks are pending', async () => {
    apiMock.runCheck.mockReturnValue(new Promise(() => {}));
    setup();
    await settle();
    expect((screen.getByRole('button', { name: 'Start Reader' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('a click starts the reader and then reports started', async () => {
    const { onStarted } = setup();
    await settle();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start Reader' }));
    expect(apiMock.startReader).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('shows Starting… while starting', async () => {
    apiMock.startReader.mockReturnValue(new Promise(() => {}));
    setup();
    await settle();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start Reader' }));
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeTruthy();
  });

  it('a start error shows the alert and does not report started', async () => {
    apiMock.startReader.mockRejectedValue(new ApiError(502, 'reader_unreachable'));
    const { onStarted } = setup();
    await settle();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start Reader' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Can't reach 10.0.0.5.");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('an unknown start error names its code', async () => {
    apiMock.startReader.mockRejectedValue(new ApiError(500, 'weird'));
    setup();
    await settle();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start Reader' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't start the reader (weird).");
  });

  it('reader_required offers the pair-again button', async () => {
    apiMock.startReader.mockRejectedValue(new ApiError(409, 'reader_required'));
    const { onPairAgain, onStarted } = setup();
    await settle();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start Reader' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Pair a reader first');
    await user.click(screen.getByRole('button', { name: 'Back to the reader step' }));
    expect(onPairAgain).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('a failed check shows Run again, which reruns', async () => {
    apiMock.runCheck.mockImplementation((n: CheckName) => Promise.resolve(
      n === 'portal' ? { name: n, ok: false, state: 'fail' as const, detail: 'down' } : ok(n)));
    setup();
    await settle();
    expect((screen.getByRole('button', { name: 'Start Reader' }) as HTMLButtonElement).disabled)
      .toBe(true);
    apiMock.runCheck.mockImplementation((n: CheckName) => Promise.resolve(ok(n)));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Run again' }));
    await settle();
    expect(apiMock.runCheck).toHaveBeenCalledTimes(6);
    expect((screen.getByRole('button', { name: 'Start Reader' }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });

  it('Back calls onBack', async () => {
    const { onBack } = setup();
    await settle();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });
});
