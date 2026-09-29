// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  createSpace: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { clearWikiMe } from '../lib/useWikiMe';
import { createSpace, getMe } from '../lib/wikiApi';
import { makeMe, makeSpace } from '../testing/fixtures';
import NewSpace, { slugify } from './NewSpace';

function SpaceProbe() {
  return <div>library {useParams().spaceKey}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/libraries/new']}>
      <Routes>
        <Route path="/libraries/new" element={<NewSpace />} />
        <Route path="/library/:spaceKey" element={<SpaceProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearWikiMe();
  vi.mocked(getMe).mockResolvedValue(makeMe({ can_create_spaces: true }));
  vi.mocked(createSpace).mockReset();
});
afterEach(cleanup);

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('slugify', () => {
  it('turns a name into a valid key', () => {
    expect(slugify('Ops Guides & How-To\'s!')).toBe('ops-guides-how-to-s');
    expect(slugify('  --Café Crème--  ')).toBe('cafe-creme');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });
});

describe('NewSpace', () => {
  it('fills the key from the name until the key is edited by hand', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Field Ops' } });
    expect(input('Key').value).toBe('field-ops');

    fireEvent.change(input('Key'), { target: { value: 'fops' } });
    fireEvent.change(input('Name'), { target: { value: 'Field Operations' } });
    expect(input('Key').value).toBe('fops');
  });

  it('validates the key before it can be submitted', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ops' } });
    fireEvent.change(input('Key'), { target: { value: 'Bad Key' } });
    expect(screen.getByText(/2–40 lowercase letters, digits or dashes/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Create library' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input('Key'), { target: { value: '-ops' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input('Key'), { target: { value: 'ops-2' } });
    expect(submit.disabled).toBe(false);
  });

  it('creates the space with the chosen access and opens it', async () => {
    vi.mocked(createSpace).mockResolvedValue(makeSpace({ key: 'field-ops' }));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Field Ops' } });
    fireEvent.change(input('Description'), { target: { value: 'Runbooks' } });
    fireEvent.change(input('Icon'), { target: { value: '🧭' } });
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }));
    expect(screen.getByRole('button', { name: 'All internal staff' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Only people I add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create library' }));

    expect(await screen.findByText('library field-ops')).toBeTruthy();
    expect(createSpace).toHaveBeenCalledWith({
      name: 'Field Ops',
      key: 'field-ops',
      description: 'Runbooks',
      icon: '🧭',
      color: '#6d4fc4',
      default_access: 'private',
    });
  });

  it('starts with a color picked and no icon, previewing the book in that color', async () => {
    vi.mocked(createSpace).mockResolvedValue(makeSpace({ key: 'hr' }));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'HR' } });
    expect(input('Icon').value).toBe('');
    expect(screen.getByRole('button', { name: 'Blue' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.wiki-new-space-preview svg.wiki-space-glyph')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create library' }));
    await screen.findByText('library hr');
    expect(createSpace).toHaveBeenCalledWith(expect.objectContaining({ icon: null, color: '#1668a7' }));
  });

  it('shows the server\'s refusal and stays put', async () => {
    vi.mocked(createSpace).mockRejectedValue(
      new ApiError(409, 'key_taken'));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create library' }));
    expect(await screen.findByText('That key is already in use. Pick another.')).toBeTruthy();
  });

  it('is not offered to someone who can\'t create spaces', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ can_create_spaces: false }));
    renderPage();
    expect(await screen.findByText(/can't create libraries/)).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
