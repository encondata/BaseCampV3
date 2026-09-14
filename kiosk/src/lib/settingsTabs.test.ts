import { expect, it } from 'vitest';

import { SETTINGS_TABS, visibleTabs } from './settingsTabs';

it('a worker sees only the three ungated tabs', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: false, isDeveloper: false });
  expect(tabs.map((t) => t.id)).toEqual(['appearance', 'sound', 'devices']);
});

it('an admin also sees Admin, but not Developer', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: true, isDeveloper: false });
  expect(tabs.map((t) => t.id)).toEqual(['appearance', 'sound', 'devices', 'admin']);
});

it('a developer (who also clears the admin rank) sees all five tabs', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: true, isDeveloper: true });
  expect(tabs.map((t) => t.id)).toEqual(['appearance', 'sound', 'devices', 'admin', 'developer']);
});

it('gates only on the flag each tab requires — a developer below admin rank still skips Admin', () => {
  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin: false, isDeveloper: true });
  expect(tabs.map((t) => t.id)).toEqual(['appearance', 'sound', 'devices', 'developer']);
});
