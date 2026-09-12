// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { LabelGeneratePreviewType, LabelVocab } from '../../lib/api';
import LabelTypeCards from './LabelTypeCards';

afterEach(cleanup);

const vocabRow = (key: string, label: string): LabelVocab => ({
  kind: 'type', key, label, description: `${label} description`,
  meta: {}, sort_order: 0, is_active: true, usage_count: null,
});
const VOCAB = [vocabRow('top', 'Top'), vocabRow('front', 'Front')];

const previewType = (
  key: string, over: Partial<LabelGeneratePreviewType> = {},
): LabelGeneratePreviewType => ({
  key, label: key, template: null, candidates: [], current: 3, stale: 1, ...over,
});

const AUTO_TEMPLATE = { id: 't1', name: 'Top asset tag', version: 5, scope: 'site' as const, site_names: [] as string[] };

// jsdom doesn't implement Element.scrollIntoView — ComboBox calls it when
// the active option changes (e.g. hovering a non-first item), which
// would otherwise throw.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

function noop() { /* no-op */ }

it('renders one card per active vocab type with its description', () => {
  render(<LabelTypeCards vocab={VOCAB} types={null} selected={[]} onToggle={noop}
                          overrides={{}} onOverride={noop} />);
  expect(screen.getByRole('checkbox', { name: /Top/ })).not.toBeNull();
  expect(screen.getByRole('checkbox', { name: /Front/ })).not.toBeNull();
  expect(screen.getByText('Top description')).not.toBeNull();
});

it('with no preview loaded yet, every card is enabled and no template line shows', () => {
  render(<LabelTypeCards vocab={VOCAB} types={null} selected={[]} onToggle={noop}
                          overrides={{}} onOverride={noop} />);
  expect((screen.getByRole('checkbox', { name: /Top/ }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('checkbox', { name: /Front/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/v\d/)).toBeNull();
});

it('a type with no candidates at all is disabled with the no-template hint', () => {
  render(<LabelTypeCards
    vocab={VOCAB}
    types={[previewType('top', { template: AUTO_TEMPLATE, candidates: [AUTO_TEMPLATE] }), previewType('front')]}
    selected={[]} onToggle={noop} overrides={{}} onOverride={noop}
  />);
  expect((screen.getByRole('checkbox', { name: /Top/ }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('checkbox', { name: /Front/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('No active template of this type.')).not.toBeNull();
});

it('an auto-matched type shows a tag chip and a Change button, no combo', () => {
  render(<LabelTypeCards
    vocab={VOCAB}
    types={[previewType('top', { template: AUTO_TEMPLATE, candidates: [AUTO_TEMPLATE] }), previewType('front')]}
    selected={[]} onToggle={noop} overrides={{}} onOverride={noop}
  />);
  expect(screen.getByText('Top asset tag v5 · site')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Change Top template' })).not.toBeNull();
});

it('a type with candidates but no auto-match shows a chooser combo and is disabled until one is chosen', async () => {
  const user = userEvent.setup();
  const candidate = { id: 'c1', name: 'Front label', version: 2, scope: 'global' as const, site_names: [] };
  const onOverride = vi.fn();
  render(<LabelTypeCards
    vocab={VOCAB}
    types={[previewType('top', { template: AUTO_TEMPLATE, candidates: [AUTO_TEMPLATE] }),
            previewType('front', { candidates: [candidate] })]}
    selected={[]} onToggle={noop} overrides={{}} onOverride={onOverride}
  />);
  expect((screen.getByRole('checkbox', { name: /Front/ }) as HTMLButtonElement).disabled).toBe(true);
  const combo = screen.getByPlaceholderText('Choose a template…');
  expect(combo).not.toBeNull();

  await user.click(combo);
  await user.click(await screen.findByText('Front label v2'));
  expect(onOverride).toHaveBeenCalledWith('front', 'c1');
});

it('once overridden, a type shows the manual chip and enables its checkbox', () => {
  const candidate = { id: 'c1', name: 'Front label', version: 2, scope: 'global' as const, site_names: [] };
  render(<LabelTypeCards
    vocab={VOCAB}
    types={[previewType('top'), previewType('front', { candidates: [candidate] })]}
    selected={[]} onToggle={noop} overrides={{ front: 'c1' }} onOverride={noop}
  />);
  expect((screen.getByRole('checkbox', { name: /Front/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('manual')).not.toBeNull();
  expect(screen.getByText('Front label v2')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Reset Front template' })).not.toBeNull();
});

it('Reset clears the override', async () => {
  const user = userEvent.setup();
  const onOverride = vi.fn();
  const candidate = { id: 'c1', name: 'Front label', version: 2, scope: 'global' as const, site_names: [] };
  render(<LabelTypeCards
    vocab={VOCAB}
    types={[previewType('top'), previewType('front', { candidates: [candidate] })]}
    selected={[]} onToggle={noop} overrides={{ front: 'c1' }} onOverride={onOverride}
  />);
  await user.click(screen.getByRole('button', { name: 'Reset Front template' }));
  expect(onOverride).toHaveBeenCalledWith('front', null);
});

it('clicking Change on an auto-matched type swaps the chip for a chooser combo', async () => {
  const user = userEvent.setup();
  render(<LabelTypeCards
    vocab={VOCAB}
    types={[previewType('top', { template: AUTO_TEMPLATE, candidates: [AUTO_TEMPLATE] }), previewType('front')]}
    selected={[]} onToggle={noop} overrides={{}} onOverride={noop}
  />);
  await user.click(screen.getByRole('button', { name: 'Change Top template' }));
  expect(screen.queryByText('Top asset tag v5 · site')).toBeNull();
  expect(screen.getByPlaceholderText('Choose a template…')).not.toBeNull();
});

it('aria-checked tracks the selected list, and clicking calls onToggle with the key', async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<LabelTypeCards
    vocab={VOCAB}
    types={[previewType('top', { template: AUTO_TEMPLATE, candidates: [AUTO_TEMPLATE] }),
            previewType('front', { template: AUTO_TEMPLATE, candidates: [AUTO_TEMPLATE] })]}
    selected={['top']} onToggle={onToggle} overrides={{}} onOverride={noop}
  />);
  expect(screen.getByRole('checkbox', { name: /Top/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('checkbox', { name: /Front/ }).getAttribute('aria-checked')).toBe('false');
  await user.click(screen.getByRole('checkbox', { name: /Front/ }));
  expect(onToggle).toHaveBeenCalledWith('front');
});

it('renders a fallback message when no active types exist', () => {
  render(<LabelTypeCards vocab={[]} types={null} selected={[]} onToggle={noop}
                          overrides={{}} onOverride={noop} />);
  expect(screen.getByText(/No active label types/)).not.toBeNull();
});
