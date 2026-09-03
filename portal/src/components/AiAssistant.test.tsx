// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AiAssistant from './AiAssistant';
import { ApiError } from '../lib/api';

const aiChatRequest = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (orig) => ({
  ...(await orig() as object), aiChatRequest,
}));

afterEach(cleanup);

function mount() {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<AiAssistant onClose={onClose} />} />
        <Route path="/initiatives/:id/import-assets"
               element={<div>LOAD ASSETS PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
}

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/ask about/i),
                   { target: { value: text } });
  fireEvent.submit(screen.getByRole('form', { name: /ai assistant/i }));
}

describe('AiAssistant', () => {
  it('sends a message and renders the reply', async () => {
    aiChatRequest.mockResolvedValueOnce({
      reply: 'Broadcom has 37 assets in storage.', navigate: null });
    mount();
    await send('how many assets does broadcom have in storage');
    await waitFor(() => expect(
      screen.getByText(/37 assets in storage/)).toBeDefined());
    expect(aiChatRequest).toHaveBeenCalledWith([
      { role: 'user',
        content: 'how many assets does broadcom have in storage' }]);
  });

  it('navigates and closes when the reply carries navigate', async () => {
    const { onClose } = mount();
    aiChatRequest.mockResolvedValueOnce({
      reply: 'Opening it.',
      navigate: { page: 'move_load_assets', id: 'abc-123' } });
    await send('load assets for nap11');
    await waitFor(() =>
      expect(screen.getByText('LOAD ASSETS PAGE')).toBeDefined());
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the offline note on 503', async () => {
    aiChatRequest.mockRejectedValueOnce(new Error('ai_offline'));
    mount();
    await send('hello');
    await waitFor(() => expect(
      screen.getByText('AI assistant is offline.')).toBeDefined());
  });

  it('shows the read-only banner message when the portal is read-only', async () => {
    // Shape matches errorFrom's read_only_mode branch in lib/api.ts:
    // ApiError(status, code, detail, READ_ONLY_MESSAGE).
    const READ_ONLY_MESSAGE =
      "The portal is in read-only maintenance mode — changes are disabled until it's lifted.";
    aiChatRequest.mockRejectedValueOnce(
      new ApiError(403, 'read_only_mode', undefined, READ_ONLY_MESSAGE));
    mount();
    await send('hello');
    await waitFor(() => expect(
      screen.getByText(READ_ONLY_MESSAGE)).toBeDefined());
  });

  it('shows the generic error for any other failure', async () => {
    aiChatRequest.mockRejectedValueOnce(new ApiError(500, 'unknown_error'));
    mount();
    await send('hello');
    await waitFor(() => expect(
      screen.getByText('Something went wrong — try again.')).toBeDefined());
  });
});
