// @vitest-environment jsdom
/**
 * components/plans/PlanFilterBar.tsx: the filter bar. The Filter and Group
 * by lists are ComboBoxes (`.org-select`), the search a `.dir-search` box;
 * each control's hover tip comes from lib/plans/commandTips; Group by only
 * in the Gantt view; the count while a filter is on; Enter and Escape in
 * the search box.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_TIPS } from '../../lib/plans/commandTips';
import { DEFAULT_VIEW, PLAN_FILTERS, type PlanViewState } from '../../lib/plans/filters';
import { TIP_DELAY_MS } from '../Tip';
import PlanFilterBar, { countText } from './PlanFilterBar';

function setup(over: Partial<PlanViewState> = {}, props: Partial<Parameters<typeof PlanFilterBar>[0]> = {}) {
  const onChange = vi.fn();
  const onSearchEnter = vi.fn();
  const onLeave = vi.fn();
  const searchRef = createRef<HTMLInputElement>();
  render(<PlanFilterBar view={{ ...DEFAULT_VIEW, ...over }} onChange={onChange} groupable searchRef={searchRef}
                        counts={null} onSearchEnter={onSearchEnter} onLeave={onLeave} platform="mac" {...props} />);
  return { onChange, onSearchEnter, onLeave, searchRef };
}

beforeEach(() => vi.useRealTimers());
afterEach(() => cleanup());

describe('PlanFilterBar', () => {
  it('Filter is an .org-select ComboBox of the eight filters; picking one changes the view', () => {
    const { onChange } = setup();
    const box = screen.getByRole('combobox', { name: 'Filter' });
    expect(box.classList.contains('org-select')).toBe(true);
    expect((box as HTMLInputElement).value).toBe('All Tasks');
    fireEvent.focus(box);
    // open, the box is for typing: it still names the filter on now, not "Select…"
    expect((box as HTMLInputElement).placeholder).toBe('All Tasks');
    const items = document.querySelectorAll('.combo-menu .kbar-item');
    expect([...items].map((i) => i.textContent)).toEqual(PLAN_FILTERS.map((f) => f.label));
    fireEvent.mouseDown([...items].find((i) => i.textContent === 'Late Tasks')!);
    expect(onChange).toHaveBeenCalledWith({ filter: 'late' });
  });

  it('Group by: No Group, Resource, Status — in the Gantt view only', () => {
    const { onChange } = setup({ group: 'status' });
    const box = screen.getByRole('combobox', { name: 'Group by' }) as HTMLInputElement;
    expect(box.value).toBe('Status');
    fireEvent.focus(box);
    expect(box.placeholder).toBe('Status');
    const items = [...document.querySelectorAll('.combo-menu .kbar-item')];
    expect(items.map((i) => i.textContent)).toEqual(['No Group', 'Resource', 'Status']);
    fireEvent.mouseDown(items[1]);
    expect(onChange).toHaveBeenCalledWith({ group: 'assignee' });
    cleanup();
    setup({}, { groupable: false });
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull();
  });

  it('the search is a .dir-search box: typing changes the view, Enter goes to the first match', () => {
    const { onChange, onSearchEnter, searchRef } = setup({ search: 'cra' });
    const input = screen.getByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement;
    expect(input.closest('.dir-search')).not.toBeNull();
    expect(searchRef.current).toBe(input);
    expect(input.value).toBe('cra');
    fireEvent.change(input, { target: { value: 'crate' } });
    expect(onChange).toHaveBeenCalledWith({ search: 'crate' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearchEnter).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('search', { name: 'Filter tasks' })).toBeTruthy();
  });

  it('Escape clears the search; in a clear box it goes back to the sheet', () => {
    const { onChange, onLeave } = setup({ search: 'crate' });
    const input = screen.getByRole('textbox', { name: 'Search tasks' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith({ search: '' });
    expect(onLeave).not.toHaveBeenCalled();
    cleanup();
    const again = setup();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search tasks' }), { key: 'Escape' });
    expect(again.onLeave).toHaveBeenCalledTimes(1);
    expect(again.onChange).not.toHaveBeenCalled();
  });

  it('shows how many tasks match while a filter is on', () => {
    setup({ filter: 'late' }, { counts: { shown: 7, total: 25 } });
    expect(screen.getByText('7 of 25 tasks')).toBeTruthy();
    expect(countText({ shown: 0, total: 25 })).toBe('No tasks match');
    expect(countText({ shown: 1, total: 1 })).toBe('1 of 1 task');
    cleanup();
    setup();
    expect(document.querySelector('.pln-fcount')).toBeNull();
  });

  it('each control has its hover tip from the command tips, the search’s with ⌘F', () => {
    vi.useFakeTimers();
    setup();
    const tipOf = (el: Element) => {
      fireEvent.pointerEnter(el.closest('.tip-trigger')!);
      act(() => { vi.advanceTimersByTime(TIP_DELAY_MS + 1); });
      const tip = screen.getByRole('tooltip');
      const text = tip.textContent;
      fireEvent.pointerLeave(el.closest('.tip-trigger')!);
      return { tip, text };
    };
    const filter = tipOf(screen.getByRole('combobox', { name: 'Filter' }));
    expect(filter.text).toContain(COMMAND_TIPS.filter.desc);
    const group = tipOf(screen.getByRole('combobox', { name: 'Group by' }));
    expect(group.text).toContain(COMMAND_TIPS.groupBy.desc);
    const search = tipOf(screen.getByRole('textbox', { name: 'Search tasks' }));
    expect(within(search.tip).getByText('⌘F')).toBeTruthy();
    expect(search.text).toContain(COMMAND_TIPS.search.desc);
    vi.useRealTimers();
  });
});
