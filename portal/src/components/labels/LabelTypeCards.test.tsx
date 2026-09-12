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

const previewType = (key: string, hasTemplate: boolean): LabelGeneratePreviewType => ({
  key, label: key, template: hasTemplate
    ? { id: 't1', name: 'Top asset tag', version: 5, scope: 'site' } : null,
  current: 3, stale: 1,
});

it('renders one card per active vocab type with its description', () => {
  render(<LabelTypeCards vocab={VOCAB} types={null} selected={[]} onToggle={() => {}} />);
  expect(screen.getByRole('checkbox', { name: /Top/ })).not.toBeNull();
  expect(screen.getByRole('checkbox', { name: /Front/ })).not.toBeNull();
  expect(screen.getByText('Top description')).not.toBeNull();
});

it('a type with no resolved template is disabled with a hint', () => {
  render(<LabelTypeCards vocab={VOCAB}
                          types={[previewType('top', true), previewType('front', false)]}
                          selected={[]} onToggle={() => {}} />);
  expect((screen.getByRole('checkbox', { name: /Top/ }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('checkbox', { name: /Front/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('No active template for this type.')).not.toBeNull();
});

it('with no preview loaded yet, every card is enabled', () => {
  render(<LabelTypeCards vocab={VOCAB} types={null} selected={[]} onToggle={() => {}} />);
  expect((screen.getByRole('checkbox', { name: /Top/ }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('checkbox', { name: /Front/ }) as HTMLButtonElement).disabled).toBe(false);
});

it('aria-checked tracks the selected list, and clicking calls onToggle with the key', async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<LabelTypeCards vocab={VOCAB} types={[previewType('top', true), previewType('front', true)]}
                          selected={['top']} onToggle={onToggle} />);
  expect(screen.getByRole('checkbox', { name: /Top/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('checkbox', { name: /Front/ }).getAttribute('aria-checked')).toBe('false');
  await user.click(screen.getByRole('checkbox', { name: /Front/ }));
  expect(onToggle).toHaveBeenCalledWith('front');
});

it('renders a fallback message when no active types exist', () => {
  render(<LabelTypeCards vocab={[]} types={null} selected={[]} onToggle={() => {}} />);
  expect(screen.getByText(/No active label types/)).not.toBeNull();
});
