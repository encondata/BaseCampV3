// @vitest-environment jsdom
// Note: this project does not register @testing-library/jest-dom matchers
// (no setupFiles/expect.extend), so assertions use `.toBeTruthy()` and read
// DOM properties (`.disabled`, `.value`) directly, matching the rest of the
// suite (see SecurityControls.test.tsx / CascadeDeleteModal.test.tsx).
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getAiLookupConfig: vi.fn(),
  updateAiLookupConfig: vi.fn(),
  ApiError: class ApiError extends Error { code = ''; },
}));
vi.mock('../../lib/api', () => api);

const { default: AiLookupControls } = await import('./AiLookupControls');

const CFG = {
  background_enabled: false, auto_apply: false, fields_specs: true,
  fields_mounting: false, fields_knowledge: false, retry_after_days: 90,
  effort: 'medium' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getAiLookupConfig.mockResolvedValue({ ...CFG });
});
afterEach(cleanup);

const switches = () => screen.getAllByRole('checkbox') as HTMLInputElement[];

it('renders every setting from the server', async () => {
  render(<AiLookupControls canChange />);
  expect(await screen.findByText('Background search')).toBeTruthy();
  for (const label of ['Auto-apply confident matches', 'Specs', 'Mounting', 'Knowledge', 'Retry after']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect((screen.getByLabelText('Retry after (days)') as HTMLInputElement).value).toBe('90');
});

it('saves a toggle as a partial update', async () => {
  const upd = api.updateAiLookupConfig.mockResolvedValue({ ...CFG, auto_apply: true });
  render(<AiLookupControls canChange />);
  await screen.findByText('Auto-apply confident matches');
  await userEvent.click(switches()[1]);
  await waitFor(() => expect(upd).toHaveBeenCalledWith({ auto_apply: true }));
});

it('is read-only without settings:change', async () => {
  render(<AiLookupControls canChange={false} />);
  await screen.findByText('Background search');
  switches().forEach((s) => expect(s.disabled).toBe(true));
});

const effortButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

it('shows the current lookup effort', async () => {
  render(<AiLookupControls canChange />);
  expect(await screen.findByText('Lookup effort')).toBeTruthy();
  await waitFor(() => expect(effortButton('Medium').className).toContain('on'));
  expect(effortButton('Low').className).not.toContain('on');
  expect(effortButton('High').className).not.toContain('on');
  expect(effortButton('Medium').getAttribute('aria-pressed')).toBe('true');
});

it('saves a new lookup effort', async () => {
  const upd = api.updateAiLookupConfig.mockResolvedValue({ ...CFG, effort: 'high' });
  render(<AiLookupControls canChange />);
  await waitFor(() => expect(effortButton('Medium').className).toContain('on'));
  await userEvent.click(effortButton('High'));
  await waitFor(() => expect(upd).toHaveBeenCalledWith({ effort: 'high' }));
  await waitFor(() => expect(effortButton('High').className).toContain('on'));
});

it('locks the lookup effort without settings:change', async () => {
  render(<AiLookupControls canChange={false} />);
  await screen.findByText('Lookup effort');
  for (const n of ['Low', 'Medium', 'High']) expect(effortButton(n).disabled).toBe(true);
});
