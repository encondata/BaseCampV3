// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReportDefinition, TimesheetPreview } from '../../lib/api';

const api = vi.hoisted(() => ({
  getTimesheetPreview: vi.fn(), listWorkerOptions: vi.fn(), listInitiatives: vi.fn(),
  getPunchOptions: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../lib/api');
const { default: TimesheetOptions } = await import('./TimesheetOptions');

const DEF: ReportDefinition = {
  id: 'd9', name: 'Timesheet', description: '', report_type: 'timesheet', is_system: true,
  updated_at: '2026-10-06T10:00:00Z',
  options: { default_format: 'xlsx', default_views: ['day', 'punch'], default_statuses: ['approved', 'pending'] },
};
const PREVIEW = (over: Partial<TimesheetPreview> = {}): TimesheetPreview => ({
  entries: 42, people: 7, days: 12, approved_minutes: 3000, pending_minutes: 90,
  flagged_entries: 5, too_many: false, ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 6, 12, 0));      // Tue 2026-10-06 local
  api.getTimesheetPreview.mockResolvedValue(PREVIEW());
  api.listWorkerOptions.mockResolvedValue([
    { person_id: 'p10', display_name: 'Worker 10' }, { person_id: 'p2', display_name: 'Worker 2' },
  ]);
  api.listInitiatives.mockResolvedValue([
    { id: 'j1', name: 'NAP11 Move', archived_at: null },
    { id: 'j2', name: 'Old Job', archived_at: '2026-01-01T00:00:00Z' },
  ]);
  api.getPunchOptions.mockResolvedValue({ initiatives: [], sites: [{ id: 's1', name: 'NAP11' }] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const lastPreview = () => api.getTimesheetPreview.mock.calls.at(-1)?.[0];
const card = (name: RegExp) => screen.getByRole('checkbox', { name });
const radio = (name: RegExp) => screen.getByRole('radio', { name });
async function pickCombo(label: string, option: string) {
  const input = screen.getByLabelText(label, { selector: 'input' });
  fireEvent.focus(input);
  fireEvent.mouseDown(await screen.findByText(option));
}
const dateInput = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

it('defaults to this month, the definition statuses/views/format, and previews them', async () => {
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  expect(dateInput('From').value).toBe('2026-10-01');
  expect(dateInput('To').value).toBe('2026-10-06');
  expect(card(/^Approved/).getAttribute('aria-checked')).toBe('true');
  expect(card(/^Pending/).getAttribute('aria-checked')).toBe('true');
  expect(card(/^Rejected/).getAttribute('aria-checked')).toBe('false');
  expect(card(/^On the clock/).getAttribute('aria-checked')).toBe('false');
  expect(card(/^Day view/).getAttribute('aria-checked')).toBe('true');
  expect(card(/^Punch view/).getAttribute('aria-checked')).toBe('true');
  expect(radio(/Excel workbook/).getAttribute('aria-checked')).toBe('true');

  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalled(), { timeout: 2000 });
  expect(lastPreview()).toEqual({
    from: '2026-10-01', to: '2026-10-06', statuses: ['approved', 'pending'], format: 'xlsx',
  });
});

it('shows the preview tiles, formatting hours', async () => {
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  const tiles = (await screen.findByText('50h')).closest('.dash-kpis') as HTMLElement;
  const t = within(tiles);
  for (const label of ['Entries', 'People', 'Days', 'Approved', 'Pending', 'Flagged']) {
    expect(t.getByText(label)).toBeTruthy();
  }
  expect(t.getByText('42')).toBeTruthy();
  expect(t.getByText('7')).toBeTruthy();
  expect(t.getByText('12')).toBeTruthy();
  expect(t.getByText('1h 30m')).toBeTruthy();
  expect(t.getByText('5')).toBeTruthy();
});

it('defaults come from the definition (PDF, punch only, rejected only)', async () => {
  render(<TimesheetOptions definition={{
    ...DEF, options: { default_format: 'pdf', default_views: ['punch'], default_statuses: ['rejected'] },
  }} onGenerate={() => {}} />);
  expect(radio(/PDF document/).getAttribute('aria-checked')).toBe('true');
  expect(card(/^Day view/).getAttribute('aria-checked')).toBe('false');
  expect(card(/^Punch view/).getAttribute('aria-checked')).toBe('true');
  expect(card(/^Rejected/).getAttribute('aria-checked')).toBe('true');
  expect(card(/^Approved/).getAttribute('aria-checked')).toBe('false');
});

it('the quick picks set the dates', async () => {
  const user = userEvent.setup();
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'This week' }));
  expect([dateInput('From').value, dateInput('To').value]).toEqual(['2026-10-05', '2026-10-11']);
  await user.click(screen.getByRole('button', { name: 'Last week' }));
  expect([dateInput('From').value, dateInput('To').value]).toEqual(['2026-09-28', '2026-10-04']);
  await user.click(screen.getByRole('button', { name: 'Last month' }));
  expect([dateInput('From').value, dateInput('To').value]).toEqual(['2026-09-01', '2026-09-30']);
  await user.click(screen.getByRole('button', { name: 'This month' }));
  expect([dateInput('From').value, dateInput('To').value]).toEqual(['2026-10-01', '2026-10-06']);
});

it('toggling a status refreshes the preview with the new statuses', async () => {
  const user = userEvent.setup();
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await user.click(card(/^Rejected/));
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(lastPreview().statuses).toEqual(['approved', 'pending', 'rejected']);
});

it('debounces: several quick changes make one preview request', async () => {
  const user = userEvent.setup();
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await user.click(card(/^Rejected/));
  await user.click(card(/^On the clock/));
  await new Promise((r) => setTimeout(r, 700));
  expect(api.getTimesheetPreview).toHaveBeenCalledTimes(2);
  expect(lastPreview().statuses).toEqual(['approved', 'pending', 'rejected', 'open']);
});

it('person, job and site filters go into the preview and the payload', async () => {
  const onGenerate = vi.fn();
  render(<TimesheetOptions definition={DEF} onGenerate={onGenerate} />);
  await pickCombo('Person', 'Worker 2');
  await pickCombo('Job', 'NAP11 Move');
  await pickCombo('Site', 'NAP11');
  await waitFor(() => expect(lastPreview()).toMatchObject({
    person_id: 'p2', initiative_id: 'j1', site_id: 's1',
  }), { timeout: 2000 });

  fireEvent.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: 'j1', notify: false,
    options: {
      from: '2026-10-01', to: '2026-10-06', person_id: 'p2', site_id: 's1',
      statuses: ['approved', 'pending'], views: ['day', 'punch'], format: 'xlsx',
    },
  });
});

it('offers Everyone / All jobs / All sites as the empty choice, naturally sorted, without archived jobs', async () => {
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  const person = screen.getByLabelText('Person', { selector: 'input' });
  fireEvent.focus(person);
  await screen.findByText('Worker 2');
  const items = Array.from(document.querySelectorAll('.combo-menu .kbar-item')).map((e) => e.textContent);
  expect(items).toEqual(['Everyone', 'Worker 2', 'Worker 10']);
  fireEvent.keyDown(person, { key: 'Escape' });

  const job = screen.getByLabelText('Job', { selector: 'input' });
  fireEvent.focus(job);
  await screen.findByText('NAP11 Move');
  expect(Array.from(document.querySelectorAll('.combo-menu .kbar-item')).map((e) => e.textContent))
    .toEqual(['All jobs', 'NAP11 Move']);
});

it('picking Everyone after a person clears the filter', async () => {
  const onGenerate = vi.fn();
  render(<TimesheetOptions definition={DEF} onGenerate={onGenerate} />);
  await pickCombo('Person', 'Worker 2');
  await pickCombo('Person', 'Everyone');
  fireEvent.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate.mock.calls[0][0].options.person_id).toBeUndefined();
});

it('Generate is disabled without a valid range, a status, or a view', async () => {
  const user = userEvent.setup();
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  const gen = screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement;
  expect(gen.disabled).toBe(false);

  fireEvent.change(dateInput('From'), { target: { value: '' } });
  expect(gen.disabled).toBe(true);
  fireEvent.change(dateInput('From'), { target: { value: '2026-11-01' } });   // after To
  expect(gen.disabled).toBe(true);
  expect(screen.getByText('The From date must be on or before the To date.')).toBeTruthy();
  fireEvent.change(dateInput('From'), { target: { value: '2026-10-01' } });
  expect(gen.disabled).toBe(false);

  await user.click(card(/^Approved/));
  await user.click(card(/^Pending/));
  expect(gen.disabled).toBe(true);
  await user.click(card(/^Approved/));
  expect(gen.disabled).toBe(false);

  await user.click(card(/^Day view/));
  await user.click(card(/^Punch view/));
  expect(gen.disabled).toBe(true);
});

it('does not ask for a preview while the options are invalid', async () => {
  const user = userEvent.setup();
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await user.click(card(/^Approved/));
  await user.click(card(/^Pending/));
  await new Promise((r) => setTimeout(r, 700));
  expect(api.getTimesheetPreview).toHaveBeenCalledTimes(1);
});

it('too_many shows the message and disables Generate', async () => {
  api.getTimesheetPreview.mockResolvedValue(PREVIEW({
    entries: 0, people: 0, days: 0, approved_minutes: 0, pending_minutes: 0,
    flagged_entries: 0, too_many: true,
  }));
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await screen.findByText(/more than 20,000 entries/, undefined, { timeout: 2000 });
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled).toBe(true);
});

it('the preview carries the format and re-requests when it changes', async () => {
  const user = userEvent.setup();
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledTimes(1), { timeout: 2000 });
  expect(lastPreview().format).toBe('xlsx');
  await user.click(radio(/PDF document/));
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(lastPreview().format).toBe('pdf');
});

it('too_many for a PDF says a PDF that long is not practical; Excel keeps its own message', async () => {
  const user = userEvent.setup();
  api.getTimesheetPreview.mockImplementation((p: { format?: string }) => Promise.resolve(PREVIEW({
    entries: 0, people: 0, days: 0, approved_minutes: 0, pending_minutes: 0,
    flagged_entries: 0, too_many: p.format === 'pdf',
  })));
  render(<TimesheetOptions definition={{
    ...DEF, options: { ...DEF.options, default_format: 'pdf' },
  }} onGenerate={() => {}} />);
  await screen.findByText(
    "More than 5,000 entries match. A PDF that long isn't practical — choose Excel or narrow the range.",
    undefined, { timeout: 2000 });
  expect(screen.queryByText(/more than 20,000/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(radio(/Excel workbook/));
  await waitFor(() => expect(screen.queryByText(/A PDF that long/)).toBeNull(), { timeout: 2000 });
  await waitFor(() => expect(
    (screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled).toBe(false),
  { timeout: 2000 });
});

it('prefill: only From → To is today; only To → From is the 1st of that month', async () => {
  const { unmount } = render(<TimesheetOptions definition={DEF} onGenerate={() => {}}
                                                initial={{ from: '2026-09-15' }} />);
  expect([dateInput('From').value, dateInput('To').value]).toEqual(['2026-09-15', '2026-10-06']);
  unmount();
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} initial={{ to: '2026-08-20' }} />);
  expect([dateInput('From').value, dateInput('To').value]).toEqual(['2026-08-01', '2026-08-20']);
});

it('a 403 says the viewer needs permission to view time', async () => {
  api.getTimesheetPreview.mockRejectedValue(new ApiError(403, 'time_view_required'));
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await screen.findByText('You need permission to view time to run this report.', undefined, { timeout: 2000 });
});

it('a 422 shows nothing extra', async () => {
  api.getTimesheetPreview.mockRejectedValue(new ApiError(422, 'bad_options'));
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalled(), { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 50));
  expect(document.querySelector('.pf-error')).toBeNull();
  expect(screen.queryByText(/Couldn't load the preview/)).toBeNull();
});

it('ignores a stale preview response', async () => {
  const user = userEvent.setup();
  let resolveFirst: (v: TimesheetPreview) => void = () => {};
  api.getTimesheetPreview
    .mockReturnValueOnce(new Promise((res) => { resolveFirst = res; }))
    .mockResolvedValueOnce(PREVIEW({ entries: 99 }));
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await user.click(card(/^Rejected/));
  await screen.findByText('99', undefined, { timeout: 2000 });
  resolveFirst(PREVIEW({ entries: 11 }));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('11')).toBeNull();
  expect(screen.getByText('99')).toBeTruthy();
});

it('posts the chosen format, statuses, views and notify', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<TimesheetOptions definition={DEF} onGenerate={onGenerate} />);
  await user.click(radio(/PDF document/));
  await user.click(card(/^Rejected/));
  await user.click(card(/^Punch view/));
  await user.click(screen.getByRole('checkbox', { name: /Notify me/ }));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: null, notify: true,
    options: {
      from: '2026-10-01', to: '2026-10-06', statuses: ['approved', 'pending', 'rejected'],
      views: ['day'], format: 'pdf',
    },
  });
});

it('prefills from `initial`', async () => {
  render(<TimesheetOptions definition={DEF} onGenerate={() => {}} initial={{
    from: '2026-09-01', to: '2026-09-15', personId: 'p2', initiativeId: 'j1', siteId: 's1',
    statuses: ['rejected'],
  }} />);
  expect(dateInput('From').value).toBe('2026-09-01');
  expect(dateInput('To').value).toBe('2026-09-15');
  expect(card(/^Rejected/).getAttribute('aria-checked')).toBe('true');
  expect(card(/^Approved/).getAttribute('aria-checked')).toBe('false');
  await waitFor(() => expect(lastPreview()).toEqual({
    from: '2026-09-01', to: '2026-09-15', person_id: 'p2', initiative_id: 'j1', site_id: 's1',
    statuses: ['rejected'], format: 'xlsx',
  }), { timeout: 2000 });
  // the prefilled people/job/site read by name once the option lists load
  const person = screen.getByLabelText('Person', { selector: 'input' }) as HTMLInputElement;
  await waitFor(() => expect(person.value).toBe('Worker 2'));
});

it('shows Back only when given one', async () => {
  const onBack = vi.fn();
  const { rerender } = render(<TimesheetOptions definition={DEF} onGenerate={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  rerender(<TimesheetOptions definition={DEF} onGenerate={() => {}} onBack={onBack} />);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});
