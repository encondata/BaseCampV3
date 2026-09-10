// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES, NAV_MODES, applyPreferences, nextNavMode } from './settings';

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

describe('applyPreferences nav', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function mountShell(): HTMLElement {
    const shell = document.createElement('div');
    shell.className = 'portal-shell';
    document.body.appendChild(shell);
    return shell;
  }

  it('stamps nav mode, size, and scale', () => {
    const shell = mountShell();

    applyPreferences({ ...DEFAULT_PREFERENCES, nav_mode: 'rail', nav_size: 'large' });

    expect(shell.getAttribute('data-nav-mode')).toBe('rail');
    expect(shell.getAttribute('data-nav-size')).toBe('large');
    expect(shell.style.getPropertyValue('--nav-scale')).toBe('1.12');
  });

  it('a dark custom background gets light nav text and a matching hover tint', () => {
    const shell = mountShell();

    applyPreferences({ ...DEFAULT_PREFERENCES, nav_bg: '#0f2a4a' });

    expect(shell.getAttribute('data-nav-bg')).toBe('custom');
    expect(shell.style.getPropertyValue('--nav-bg')).toBe('#0f2a4a');
    expect(shell.style.getPropertyValue('--nav-fg')).toBe('#ffffff');
    expect(shell.style.getPropertyValue('--nav-hover')).toBe('rgba(255, 255, 255, 0.07)');
  });

  it('a light custom background (Paper) gets dark nav text', () => {
    const shell = mountShell();

    applyPreferences({ ...DEFAULT_PREFERENCES, nav_bg: '#f3f4f6' });

    expect(shell.getAttribute('data-nav-bg')).toBe('custom');
    expect(shell.style.getPropertyValue('--nav-fg')).toBe('#111827');
  });

  it('"default" removes the custom nav variables', () => {
    const shell = mountShell();
    applyPreferences({ ...DEFAULT_PREFERENCES, nav_bg: '#0f2a4a' });

    applyPreferences({ ...DEFAULT_PREFERENCES, nav_bg: 'default' });

    expect(shell.getAttribute('data-nav-bg')).toBe('default');
    expect(shell.style.getPropertyValue('--nav-bg')).toBe('');
    expect(shell.style.getPropertyValue('--nav-fg')).toBe('');
    expect(shell.style.getPropertyValue('--nav-fg-mute')).toBe('');
    expect(shell.style.getPropertyValue('--nav-line')).toBe('');
    expect(shell.style.getPropertyValue('--nav-hover')).toBe('');
  });
});

describe('nextNavMode', () => {
  it('cycles expanded -> rail -> hidden -> expanded', () => {
    expect(nextNavMode('expanded')).toBe('rail');
    expect(nextNavMode('rail')).toBe('hidden');
    expect(nextNavMode('hidden')).toBe('expanded');
  });

  it('covers every declared mode', () => {
    expect(NAV_MODES).toEqual(['expanded', 'rail', 'hidden']);
  });
});
