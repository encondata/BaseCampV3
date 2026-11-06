// @vitest-environment jsdom
/**
 * The rules column's Reading style row (Document / Slides): the segmented
 * control saves { reading_style }, Slides swaps the scroll toggle for the
 * every-slide line and the slide count, and a view-only manager reads the
 * style in the summary.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { LearningDocument } from '../../lib/learning';
import DocumentRulesPanel from './DocumentRulesPanel';

const DOC: LearningDocument = {
  id: 'd1', title: 'Dress code', summary: null,
  validity_days: 365, resign_rule: 'expired_or_new_version', sign_style: 'typed_name',
  require_scroll: true, min_read_seconds: null, quiz_enabled: false,
  quiz_pass_percent: null, quiz_max_attempts: null, quiz_fail_action: 'retry',
  reading_style: 'document', slide_count: null,
  wiki_node_id: 'w1', wiki_page: null, has_wiki_changes: false,
  current_version_id: 'v1', current_version_no: 1, current_html: '<p>Hi</p>',
  current_slides: null, versions: [],
  archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
const SLIDES: LearningDocument = {
  ...DOC, reading_style: 'slides', slide_count: 4, current_html: null,
  current_slides: ['<p>1</p>', '<p>2</p>', '<p>3</p>', '<p>4</p>'],
};

afterEach(cleanup);

const renderPanel = (doc: LearningDocument, canChange = true, onSave = vi.fn().mockResolvedValue(true)) => {
  render(<DocumentRulesPanel doc={doc} canChange={canChange} onSave={onSave}
                             translations={[]} signoffCounts={{}} onOpenTab={vi.fn()} />);
  return onSave;
};

it('saves reading style from the segmented control', async () => {
  const onSave = renderPanel(DOC);
  const group = screen.getByRole('group', { name: 'Reading style' });
  expect(group.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Document');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Slides' }));
  expect(onSave).toHaveBeenCalledWith({ reading_style: 'slides' });
});

it('Slides replaces the scroll toggle with the every-slide line and slide count', () => {
  renderPanel(SLIDES);
  expect(screen.getByText('Readers go through every slide before they can sign.')).toBeTruthy();
  expect(screen.getByText('4 slides')).toBeTruthy();
  expect(screen.queryByText('Must scroll to the end')).toBeNull();
  expect(screen.queryByRole('switch', { name: 'Must scroll to the end' })).toBeNull();
  // the other reading rules stay
  expect(screen.getByText('Minimum reading time')).toBeTruthy();
});

it('Document style keeps the scroll toggle and shows no slide line', () => {
  renderPanel(DOC);
  expect(screen.getByText('Must scroll to the end')).toBeTruthy();
  expect(screen.queryByText(/every slide/)).toBeNull();
});

it('one-slide note when the page shows as one slide', () => {
  renderPanel({ ...SLIDES, slide_count: 1, current_slides: ['<p>1</p>'] });
  expect(screen.getByText('1 slide')).toBeTruthy();
  expect(screen.getByText(
    'This page shows as one slide. Each ## heading starts a new slide.',
  )).toBeTruthy();
});

it('no note about headings when there are several slides', () => {
  renderPanel(SLIDES);
  expect(screen.queryByText(/shows as one slide/)).toBeNull();
});

it('view-only shows Reading style in the summary', () => {
  renderPanel(SLIDES, false);
  expect(screen.queryByRole('group', { name: 'Reading style' })).toBeNull();
  const label = screen.getAllByText('Reading style');
  expect(label.length).toBeGreaterThan(0);
  expect(screen.getAllByText('Slides').length).toBeGreaterThan(0);
  expect(screen.queryByText('Scroll to the end')).toBeNull();
});

it('view-only Document style keeps the scroll row', () => {
  renderPanel(DOC, false);
  expect(screen.getByText('Scroll to the end')).toBeTruthy();
  expect(screen.getAllByText('Document').length).toBeGreaterThan(0);
});
