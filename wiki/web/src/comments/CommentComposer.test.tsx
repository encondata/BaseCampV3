// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listMentionable: vi.fn(),
}));

import { listMentionable } from '../lib/wikiApi';
import CommentComposer from './CommentComposer';

const onSubmit = vi.fn<(body: { text: string; mentions: string[] }) => Promise<void>>();
const onCancel = vi.fn();

beforeEach(() => {
  onSubmit.mockReset().mockResolvedValue(undefined);
  onCancel.mockReset();
  vi.mocked(listMentionable).mockReset().mockResolvedValue([
    { id: 'p-2', name: 'Ada Lovelace' }, { id: 'p-3', name: 'Alan Turing' },
  ]);
});
afterEach(cleanup);

function setup(props: Partial<Parameters<typeof CommentComposer>[0]> = {}) {
  render(<CommentComposer pageId="page-1" label="Comment" submitLabel="Comment" onSubmit={onSubmit}
                          onCancel={onCancel} {...props} />);
  return screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement;
}

/** Types `text` at the end, the caret after it. */
function typeInto(box: HTMLTextAreaElement, text: string) {
  const value = box.value + text;
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

describe('CommentComposer', () => {
  it('picks a person after "@" and posts their id with Ctrl+Enter', async () => {
    const box = setup();
    typeInto(box, 'Can you check this, @Ad');
    await waitFor(() => expect(listMentionable).toHaveBeenCalledWith('page-1', 'Ad'));
    const option = await screen.findByRole('option', { name: /Ada Lovelace/ });
    fireEvent.mouseDown(option);
    expect(box.value).toBe('Can you check this, @Ada Lovelace ');
    expect(screen.queryByRole('listbox')).toBeNull();

    typeInto(box, 'please?');
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }); });
    expect(onSubmit).toHaveBeenCalledWith({ text: 'Can you check this, @Ada Lovelace please?', mentions: ['p-2'] });
    expect(box.value).toBe('');
  });

  it('picks with the keyboard, and Escape closes only the picker', async () => {
    const box = setup();
    typeInto(box, '@A');
    await screen.findByRole('option', { name: /Ada Lovelace/ });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('@Alan Turing ');

    typeInto(box, '@A');
    await screen.findByRole('option', { name: /Ada Lovelace/ });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('drops a mention whose name was edited out, and posts nothing blank', async () => {
    const box = setup({ submitLabel: 'Reply' });
    const post = screen.getByRole('button', { name: 'Reply' }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    typeInto(box, '@Ad');
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Ada Lovelace/ }));
    fireEvent.change(box, { target: { value: 'never mind' } });
    await act(async () => { fireEvent.click(post); });
    expect(onSubmit).toHaveBeenCalledWith({ text: 'never mind', mentions: [] });
  });

  it('shows a counter near the limit and disables Post past it', async () => {
    const box = setup({ maxLength: 150 });
    const post = screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement;
    typeInto(box, 'short');
    expect(screen.queryByText(/\/150/)).toBeNull();

    fireEvent.change(box, { target: { value: 'a'.repeat(60) } });
    expect(screen.getByText('60/150')).toBeTruthy();
    expect(post.disabled).toBe(false);

    fireEvent.change(box, { target: { value: 'a'.repeat(151) } });
    expect(screen.getByText('151/150')).toBeTruthy();
    expect(post.disabled).toBe(true);
    await act(async () => { fireEvent.click(post); });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('starts from an existing comment and keeps the text when posting fails', async () => {
    onSubmit.mockRejectedValueOnce(new Error('nope'));
    const box = setup({
      initialText: 'Ask @Ada Lovelace', initialMentions: [{ id: 'p-2', name: 'Ada Lovelace' }], submitLabel: 'Save',
    });
    expect(box.value).toBe('Ask @Ada Lovelace');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(onSubmit).toHaveBeenCalledWith({ text: 'Ask @Ada Lovelace', mentions: ['p-2'] });
    expect(box.value).toBe('Ask @Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
