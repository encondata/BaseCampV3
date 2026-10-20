// @vitest-environment jsdom
/**
 * The font dropdown: the eight families, each name and the sample
 * `0O 1Il 7` drawn in that family's own face (the resident Swiss cut in its
 * Roboto Condensed Bold stand-in), keyboard and pointer picks.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FONT_FAMILIES } from '../../../labels/builder/fonts';
import { fakeMetricsFor } from './builderTestKit';
import FontSelect from './FontSelect';
import { useBuilderShortcuts } from './useBuilderShortcuts';

afterEach(cleanup);

function setup(value = 'swiss721-cond-bold', weight: 'regular' | 'bold' = 'regular') {
  const onChange = vi.fn<(family: string) => void>();
  const metricsFor = vi.fn(fakeMetricsFor);
  render(<FontSelect value={value} weight={weight} onChange={onChange} metricsFor={metricsFor} />);
  const trigger = screen.getByRole('button', { name: /^Font/ });
  return { onChange, metricsFor, trigger };
}

const faceOf = (el: Element) => (el.querySelector('.lbp-face') as HTMLElement).style.getPropertyValue('--lbp-face');

describe('FontSelect', () => {
  it('shows the chosen family in its own face', () => {
    const { trigger } = setup('oswald');
    expect(trigger.textContent).toContain('Oswald');
    expect(faceOf(trigger)).toContain('label-builder-oswald-regular');
  });

  it('lists the eight families, each in its own face with 0O 1Il 7', () => {
    const { trigger, metricsFor } = setup();
    fireEvent.click(trigger);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.querySelector('.lbp-font-name')?.textContent)).toEqual(FONT_FAMILIES.map((f) => f.label));
    expect(options).toHaveLength(8);
    for (const o of options) expect(o.querySelector('.lbp-font-sample')?.textContent).toBe('0O 1Il 7');
    // the resident Swiss cut is drawn with its stand-in
    expect(options[0].querySelector('.lbp-font-name')?.textContent).toBe('Swiss 721 Condensed Bold');
    expect(faceOf(options[0])).toContain('label-builder-roboto-condensed-bold');
    expect(options[0].textContent).toContain('default');
    expect(faceOf(options[4])).toContain('label-builder-roboto-mono-regular');
    expect(options[4].textContent).toContain('mono');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    // opening asks for every face, so the page loads them
    expect(new Set(metricsFor.mock.calls.map(([family]) => family))).toEqual(new Set(FONT_FAMILIES.map((f) => f.slug)));
  });

  it('draws each family at the weight in use', () => {
    const { trigger } = setup('roboto', 'bold');
    fireEvent.click(trigger);
    expect(faceOf(screen.getByRole('option', { name: 'Roboto' }))).toContain('label-builder-roboto-bold');
  });

  it('a click picks a family and closes the list', () => {
    const { trigger, onChange } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'IBM Plex Mono' }));
    expect(onChange).toHaveBeenCalledWith('ibm-plex-mono');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('↓ opens, arrows move, Enter picks, Escape closes without a change', () => {
    const { trigger, onChange } = setup('roboto');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Roboto' }).id);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('oswald');
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('Tab closes the list and moves on from the trigger; the trigger names the list it opens', () => {
    const { trigger, onChange } = setup('roboto');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox');
    expect(trigger.getAttribute('aria-controls')).toBe(list.id);
    // not prevented: the browser's Tab goes on from the trigger
    expect(fireEvent.keyDown(list, { key: 'Tab' })).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('`/` on the trigger is the field search, and never reaches the Topbar', () => {
    const search = vi.fn();
    function Page() {
      useBuilderShortcuts({ 'workflow.fieldSearch': search }, { platform: 'mac' });
      return <FontSelect value="roboto" onChange={vi.fn()} />;
    }
    render(<Page />);
    const topbar = vi.fn();
    document.addEventListener('keydown', topbar);
    const ok = fireEvent.keyDown(screen.getByRole('button', { name: /^Font/ }), { key: '/', code: 'Slash' });
    document.removeEventListener('keydown', topbar);
    expect(ok).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
    expect(topbar).not.toHaveBeenCalled();
  });
});
