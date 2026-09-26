// @vitest-environment jsdom
import '../testing/pmDom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
}));

import { getTemplate, listTemplates } from '../lib/wikiApi';
import TemplatePicker from './TemplatePicker';

const RUNBOOK = {
  id: 't-1', space_id: null, space_key: null, name: 'Runbook', description: 'A standard runbook',
  icon: '📋', is_builtin: true, created_by: null, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
};
const SPACE_TEMPLATE = {
  id: 't-2', space_id: 'space-1', space_key: 'ops', name: 'Move plan', description: '', icon: '',
  is_builtin: false, created_by: null, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
};

function renderPicker(props: Partial<Parameters<typeof TemplatePicker>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <MemoryRouter><TemplatePicker spaceKey="ops" value={null} onChange={onChange} {...props} /></MemoryRouter>,
  );
  return { onChange, ...utils };
}

beforeEach(() => {
  vi.mocked(listTemplates).mockReset().mockResolvedValue([RUNBOOK, SPACE_TEMPLATE]);
  vi.mocked(getTemplate).mockReset().mockResolvedValue({
    ...RUNBOOK, content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Runbook body' }] }] },
  });
});
afterEach(cleanup);

describe('TemplatePicker', () => {
  it('lists Blank first, then the templates from the API in order', async () => {
    renderPicker();
    await screen.findByRole('radio', { name: /Runbook/ });
    const options = screen.getAllByRole('radio');
    expect(options.map((o) => o.textContent)).toEqual([
      'Blank pageStart with nothing', '📋 RunbookA standard runbook', 'Move planThis space',
    ]);
    expect(listTemplates).toHaveBeenCalledWith('ops');
  });

  it('shows a glyph, never the word, for a builtin still seeded with an icon name', async () => {
    vi.mocked(listTemplates).mockResolvedValue([
      { ...RUNBOOK, name: 'How-to guide', icon: 'compass' },
      { ...SPACE_TEMPLATE, icon: 'star' },
    ]);
    renderPicker();
    await screen.findByRole('radio', { name: /How-to guide/ });
    expect(screen.getAllByRole('radio').map((o) => o.textContent)).toEqual([
      'Blank pageStart with nothing', '🧭 How-to guideA standard runbook', 'Move planThis space',
    ]);
  });

  it('starts with Blank selected and no preview', () => {
    renderPicker();
    const blank = screen.getByRole('radio', { name: /Blank page/ });
    expect(blank.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('A blank page — nothing to preview.')).toBeTruthy();
  });

  it('previews a template on hover, cached across repeated hovers', async () => {
    renderPicker();
    const card = await screen.findByRole('radio', { name: /Runbook/ });
    fireEvent.mouseEnter(card);
    expect(await screen.findByText('Runbook body')).toBeTruthy();
    expect(getTemplate).toHaveBeenCalledWith('t-1');

    fireEvent.mouseEnter(screen.getByRole('radio', { name: /Blank page/ }));
    expect(screen.getByText('A blank page — nothing to preview.')).toBeTruthy();

    fireEvent.mouseEnter(card);
    expect(await screen.findByText('Runbook body')).toBeTruthy();
    expect(getTemplate).toHaveBeenCalledTimes(1);
  });

  it('selects a template by clicking its card', async () => {
    const { onChange } = renderPicker();
    const card = await screen.findByRole('radio', { name: /Move plan/ });
    fireEvent.click(card);
    expect(onChange).toHaveBeenCalledWith('t-2');
  });

  it('shows an error if templates fail to load', async () => {
    vi.mocked(listTemplates).mockRejectedValue(new Error('nope'));
    renderPicker();
    expect(await screen.findByText('Couldn\'t load templates.')).toBeTruthy();
  });
});
