// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  setNodeDocType: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { resetTreeStore } from '../lib/treeStore';
import { setNodeDocType } from '../lib/wikiApi';
import { makeNode } from '../testing/fixtures';
import DocTypeDialog from './DocTypeDialog';

const withType = (docType: string | null) => makeNode('n1', {
  title: 'Rack power',
  page: { is_home: false, published_version_id: null, published_at: null, has_unpublished_changes: false, doc_type: docType },
});

beforeEach(() => {
  resetTreeStore();
  vi.mocked(setNodeDocType).mockImplementation(async (_id, docType) => withType(docType));
});
afterEach(() => { cleanup(); toast.mockReset(); vi.mocked(setNodeDocType).mockReset(); });

const radio = (name: string) => screen.getByRole('radio', { name });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('DocTypeDialog', () => {
  it('uses the modal header pattern', () => {
    render(<DocTypeDialog node={withType(null)} onClose={() => {}} />);
    expect(screen.getByText('Export', { selector: '.eyebrow' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Document type' })).toBeTruthy();
    expect(screen.getByText('Shown on the cover of an exported PDF.')).toBeTruthy();
  });

  it('offers the five types and None', () => {
    render(<DocTypeDialog node={withType(null)} onClose={() => {}} />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Operating Procedure', 'Work Instruction', 'Guide', 'Policy', 'Reference', 'None',
    ]);
  });

  it('preselects the current type', () => {
    render(<DocTypeDialog node={withType('Guide')} onClose={() => {}} />);
    expect(radio('Guide').getAttribute('aria-checked')).toBe('true');
    expect(radio('Policy').getAttribute('aria-checked')).toBe('false');
    expect(radio('None').getAttribute('aria-checked')).toBe('false');
  });

  it('preselects None when the page has no type, and Save waits for a change', () => {
    render(<DocTypeDialog node={withType(null)} onClose={() => {}} />);
    expect(radio('None').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('saves the picked type, toasts and closes', async () => {
    const onClose = vi.fn();
    render(<DocTypeDialog node={withType(null)} onClose={onClose} />);
    fireEvent.click(radio('Policy'));
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setNodeDocType).toHaveBeenCalledWith('n1', 'Policy');
    expect(toast).toHaveBeenCalledWith('Saved.');
  });

  it('sends null for None', async () => {
    const onClose = vi.fn();
    render(<DocTypeDialog node={withType('Policy')} onClose={onClose} />);
    fireEvent.click(radio('None'));
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setNodeDocType).toHaveBeenCalledWith('n1', null);
  });

  it('shows an error in the dialog and stays open', async () => {
    vi.mocked(setNodeDocType).mockRejectedValue(new ApiError(422, 'bad_doc_type', undefined, 'You can\'t edit this page.'));
    const onClose = vi.fn();
    render(<DocTypeDialog node={withType(null)} onClose={onClose} />);
    fireEvent.click(radio('Guide'));
    save();
    expect(await screen.findByText('You can\'t edit this page.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    // and the choice can be retried
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  });

  it('finishes saving under StrictMode, which mounts the dialog twice in development', async () => {
    const onClose = vi.fn();
    render(<StrictMode><DocTypeDialog node={withType(null)} onClose={onClose} /></StrictMode>);
    fireEvent.click(radio('Reference'));
    save();
    await waitFor(() => expect(setNodeDocType).toHaveBeenCalledWith('n1', 'Reference'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Saved.');
  });
});
