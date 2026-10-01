import { describe, expect, it } from 'vitest';

import { SETTINGS_TABS, visibleTabs } from './settingsTabs';

it('tab order includes This Kiosk right after Devices', () => {
  expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
    'appearance', 'sound', 'devices', 'this-kiosk', 'edge', 'admin', 'developer',
  ]);
});

it('signed out, only This Kiosk is visible', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: false, isDeveloper: false, signedIn: false });
  expect(tabs.map((t) => t.id)).toEqual(['this-kiosk']);
});

it('signed out, an admin/developer still sees only This Kiosk', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: true, isDeveloper: true, signedIn: false });
  expect(tabs.map((t) => t.id)).toEqual(['this-kiosk']);
});

it('a worker signed in sees Appearance, Sound, Devices, and This Kiosk', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: false, isDeveloper: false, signedIn: true });
  expect(tabs.map((t) => t.id)).toEqual(['appearance', 'sound', 'devices', 'this-kiosk']);
});

it('an admin also sees Admin, but not Developer', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: true, isDeveloper: false, signedIn: true });
  expect(tabs.map((t) => t.id)).toEqual(['appearance', 'sound', 'devices', 'this-kiosk', 'admin']);
});

it('a developer (who also clears the admin rank) sees all six tabs', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: true, isDeveloper: true, signedIn: true });
  expect(tabs.map((t) => t.id)).toEqual([
    'appearance', 'sound', 'devices', 'this-kiosk', 'admin', 'developer',
  ]);
});

it('gates only on the flag each tab requires — a developer below admin rank still skips Admin', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: false, isDeveloper: true, signedIn: true });
  expect(tabs.map((t) => t.id)).toEqual(['appearance', 'sound', 'devices', 'this-kiosk', 'developer']);
});

describe('edge tab', () => {
  it('appears only in laptop mode', () => {
    const base = { isAdmin: false, isDeveloper: false, signedIn: true };
    expect(visibleTabs(SETTINGS_TABS, base).map((t) => t.id)).not.toContain('edge');
    expect(visibleTabs(SETTINGS_TABS, { ...base, laptop: true }).map((t) => t.id)).toContain('edge');
  });
});
