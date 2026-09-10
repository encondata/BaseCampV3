// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES, applyPreferences } from './settings';

describe('applyPreferences list size', () => {
  beforeEach(() => {
    // jsdom implements no matchMedia; applyPreferences reads it on every call.
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('stamps data-list-size on the shell', () => {
    const shell = document.createElement('div');
    shell.className = 'portal-shell';
    document.body.appendChild(shell);

    applyPreferences({ ...DEFAULT_PREFERENCES, list_size: 'large' });

    expect(shell.getAttribute('data-list-size')).toBe('large');
    expect(DEFAULT_PREFERENCES.list_size).toBe('default');
  });
});
