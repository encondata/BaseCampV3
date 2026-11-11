// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { installEscapeToPin } from './escapeToPin';
import { openTakeovers } from './takeover';

const press = (key = 'Escape') => document.body.dispatchEvent(
  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

afterEach(() => { document.body.innerHTML = ''; openTakeovers.length = 0; });

it('opens only when no dialog is open and nothing took the Escape', () => {
  const onEscape = vi.fn();
  const stop = installEscapeToPin(onEscape);
  press();
  expect(onEscape).toHaveBeenCalledTimes(1);

  // a modal that closes itself on this very keydown still counts as open
  const dlg = document.createElement('div');
  dlg.className = 'modal-scrim';
  document.body.append(dlg);
  const closer = (e: KeyboardEvent) => { if (e.key === 'Escape') dlg.remove(); };
  document.addEventListener('keydown', closer);
  press();
  document.removeEventListener('keydown', closer);
  expect(onEscape).toHaveBeenCalledTimes(1);

  // something marked it handled (an open ComboBox list)
  const taker = (e: KeyboardEvent) => e.preventDefault();
  document.addEventListener('keydown', taker);
  press();
  document.removeEventListener('keydown', taker);
  expect(onEscape).toHaveBeenCalledTimes(1);

  // a takeover (the off-move alarm) is up
  openTakeovers.push(document.createElement('div'));
  press();
  openTakeovers.length = 0;
  expect(onEscape).toHaveBeenCalledTimes(1);

  press('Enter');
  expect(onEscape).toHaveBeenCalledTimes(1);
  stop();
  press();
  expect(onEscape).toHaveBeenCalledTimes(1);
});
