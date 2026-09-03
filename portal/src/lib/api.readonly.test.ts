// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, READ_ONLY_MESSAGE, onSystemStatusRefresh, updateAdminConfig } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('read_only_mode errors', () => {
  it('carry the friendly message and trigger a status refresh', async () => {
    const seen = vi.fn();
    const off = onSystemStatusRefresh(seen);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: { code: 'read_only_mode', message: 'Cutover' } }),
      { status: 423 })));
    const err = await updateAdminConfig({ read_only: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('read_only_mode');
    expect((err as ApiError).message).toBe(READ_ONLY_MESSAGE);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});
