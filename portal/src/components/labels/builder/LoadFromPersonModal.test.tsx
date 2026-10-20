// @vitest-environment jsdom
/**
 * Load from person… (spec 2026-10-20-badge-templates §4.7, §4.11): search
 * staff and workers (GET /labels/sample-people, natural order as the
 * server returns it), pick one, and the badge's samples become theirs
 * (GET /labels/sample-person). `personSamples` replaces EVERY person key,
 * "" for the person's blanks, and names them under `person:id`;
 * `clearPersonSamples` takes every person key and `person:id` away.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SamplePerson, SamplePersonValues } from '../../../lib/api';

const api = vi.hoisted(() => ({ searchSamplePeople: vi.fn(), loadSamplePerson: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../../lib/api');
const {
  default: LoadFromPersonModal, PERSON_SEARCH_DEBOUNCE_MS, PERSON_SEARCH_LIMIT, clearPersonSamples, personSamples,
} = await import('./LoadFromPersonModal');

const ADA = '0b7f3c52-6a2e-4c41-9d1e-3f2a9b8c7d10';
const CREW2 = '1c8e4d63-7b3f-4d52-8e2f-4a3b0c9d8e21';
const CREW10 = '2d9f5e74-8c40-4e63-9f30-5b4c1d0e9f32';

const person = (person_id: string, name: string, person_type: 'Staff' | 'Worker', company: string | null,
  has_photo: boolean, has_logo: boolean): SamplePerson => ({ person_id, name, person_type, company, has_photo, has_logo });

// natural by name, as the server sorts them: Crew 2 before Crew 10
const PEOPLE: SamplePerson[] = [
  person(ADA, 'Ada Lovelace', 'Staff', 'Cumulus Solutions Group', true, true),
  person(CREW2, 'Crew 2', 'Worker', 'Rivera Electric', false, true),
  person(CREW10, 'Crew 10', 'Worker', null, false, false),
];

const LOADED: SamplePersonValues = {
  person_id: CREW2, has_photo: false, has_logo: true,
  values: { person_name: 'Crew 2', first_name: 'Crew', last_name: '2', job_title: '', company: 'Rivera Electric' },
};

beforeEach(() => {
  api.searchSamplePeople.mockResolvedValue(PEOPLE);
  api.loadSamplePerson.mockResolvedValue(LOADED);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function setup() {
  const onLoad = vi.fn<(loaded: SamplePersonValues) => void>();
  const onClose = vi.fn();
  render(<LoadFromPersonModal templateName="Crew badge" onLoad={onLoad} onClose={onClose} />);
  return { onLoad, onClose };
}

const dialog = () => screen.getByRole('dialog', { name: 'Load samples from a person' });
const rows = () => within(dialog()).getAllByRole('radio').map((r) => r.closest('label') as HTMLElement);

describe('LoadFromPersonModal', () => {
  it('has the report-generate header and lists staff and workers in the order the server sends', async () => {
    setup();
    expect(within(dialog()).getByText('Crew badge · Load from person')).toBeTruthy();
    expect(within(dialog()).getByRole('heading', { name: 'Load samples from a person' })).toBeTruthy();
    expect(within(dialog()).getByRole('searchbox', { name: 'Search people' }).closest('.dir-search')).not.toBeNull();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(api.searchSamplePeople).toHaveBeenCalledTimes(1);
    expect(api.searchSamplePeople).toHaveBeenCalledWith('', PERSON_SEARCH_LIMIT);
    // natural order as returned, never re-sorted (a plain sort puts Crew 10 first)
    expect(within(dialog()).getAllByRole('radio').map((r) => r.getAttribute('aria-label')))
      .toEqual(['Ada Lovelace', 'Crew 2', 'Crew 10']);
    // name, company, the Staff/Worker chip, what pictures the badge gets
    const [ada, crew2, crew10] = rows();
    expect(within(ada).getByText('Cumulus Solutions Group')).toBeTruthy();
    expect(within(ada).getByText('Staff').closest('.chip')!.className).toContain('c-blue');
    expect(within(ada).getByText('Photo · Logo')).toBeTruthy();
    expect(within(crew2).getByText('Worker').closest('.chip')!.className).toContain('c-green');
    expect(within(crew2).getByText('Logo')).toBeTruthy();
    expect(within(crew10).getByText('—')).toBeTruthy();
    expect(within(crew10).getByText('No photo or logo')).toBeTruthy();
  });

  it('searches the server as you type, once you pause', async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    vi.useFakeTimers();
    api.searchSamplePeople.mockResolvedValue([PEOPLE[1]]);
    const box = within(dialog()).getByRole('searchbox', { name: 'Search people' });
    fireEvent.change(box, { target: { value: 'cr' } });
    fireEvent.change(box, { target: { value: 'crew 2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(PERSON_SEARCH_DEBOUNCE_MS - 1); });
    expect(api.searchSamplePeople).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.searchSamplePeople).toHaveBeenCalledTimes(2);
    expect(api.searchSamplePeople).toHaveBeenLastCalledWith('crew 2', PERSON_SEARCH_LIMIT);
    vi.useRealTimers();
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('an older search answering late never replaces a newer one', async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    let late: (v: SamplePerson[]) => void = () => {};
    api.searchSamplePeople.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    api.searchSamplePeople.mockResolvedValueOnce([PEOPLE[2]]);
    const box = within(dialog()).getByRole('searchbox', { name: 'Search people' });
    fireEvent.change(box, { target: { value: 'ada' } });
    await waitFor(() => expect(api.searchSamplePeople).toHaveBeenCalledTimes(2));
    fireEvent.change(box, { target: { value: 'crew 10' } });
    await waitFor(() => expect(api.searchSamplePeople).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(async () => { late([PEOPLE[0]]); });
    expect(within(dialog()).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Crew 10']);
  });

  it('says when no one matches, and when the search fails', async () => {
    api.searchSamplePeople.mockResolvedValue([]);
    setup();
    expect(await within(dialog()).findByText('No staff or workers match.')).toBeTruthy();
    cleanup();
    api.searchSamplePeople.mockRejectedValue(new Error('down'));
    setup();
    expect(await within(dialog()).findByText('Couldn’t search people.')).toBeTruthy();
  });

  it('picking a person loads their values and hands them back', async () => {
    const { onLoad } = setup();
    const load = within(dialog()).getByRole('button', { name: 'Load samples' }) as HTMLButtonElement;
    expect(load.disabled).toBe(true);
    fireEvent.click(await within(dialog()).findByRole('radio', { name: 'Crew 2' }));
    expect(load.disabled).toBe(false);
    fireEvent.click(load);
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(api.loadSamplePerson).toHaveBeenCalledWith(CREW2);
    expect(onLoad).toHaveBeenCalledWith(LOADED);
  });

  it('a person gone since the search says so', async () => {
    api.loadSamplePerson.mockRejectedValue(new ApiError(404, 'person_not_found'));
    const { onLoad } = setup();
    fireEvent.click(await within(dialog()).findByRole('radio', { name: 'Ada Lovelace' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Load samples' }));
    expect(await within(dialog()).findByText('That person is no longer on file.')).toBeTruthy();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('Cancel and Escape close it', async () => {
    const { onClose } = setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('personSamples', () => {
  const KEYS = ['person_name', 'first_name', 'last_name', 'job_title', 'company', 'trade'];

  it('replaces every person key, "" for the person’s blanks, and names them under person:id', () => {
    const fromA = {
      person_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace', job_title: 'Engineer',
      company: 'Cumulus Solutions Group', trade: 'Analyst', 'person:id': ADA, logo_note: 'kept',
    };
    const out = personSamples(fromA, LOADED, KEYS);
    expect(out).toEqual({
      person_name: 'Crew 2', first_name: 'Crew', last_name: '2', company: 'Rivera Electric',
      // B's blanks, and a key the server left out: blank, never A's
      job_title: '', trade: '',
      'person:id': CREW2,
      // not a person key: left alone
      logo_note: 'kept',
    });
  });

  it('takes a person key the catalog doesn’t list yet too', () => {
    const out = personSamples({}, { ...LOADED, values: { ...LOADED.values, badge_short: '1c8e4d63' } }, []);
    expect(out.badge_short).toBe('1c8e4d63');
    expect(out['person:id']).toBe(CREW2);
  });
});

describe('clearPersonSamples', () => {
  it('takes away every person key and person:id, and nothing else', () => {
    const samples = { person_name: 'Crew 2', job_title: '', 'person:id': CREW2, logo_note: 'kept' };
    expect(clearPersonSamples(samples, ['person_name', 'job_title', 'company'])).toEqual({ logo_note: 'kept' });
  });
});
