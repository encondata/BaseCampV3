// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SlideDeck from './SlideDeck';

const SLIDES = ['<p>one</p>', '<p>two</p>', '<p>three</p>'];

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The server records what it is told: `onReach(n)` answers `n`. */
const recorder = () => vi.fn(async (n: number) => n);

function deck(over: Partial<Parameters<typeof SlideDeck>[0]> = {}) {
  const onReach = over.onReach ?? recorder();
  render(<SlideDeck slides={SLIDES} reached={null} review={false} lang="en" dir="ltr" timeLeft={0}
                    {...over} onReach={onReach} />);
  return onReach;
}

const dot = (k: number) => screen.getByRole('button', { name: `Go to slide ${k}` }) as HTMLButtonElement;
const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
const back = () => screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;

describe('SlideDeck', () => {
  it('moves forward one unseen slide at a time and reports each new one', async () => {
    const onReach = deck();
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
    // opening the first slide counts as reaching it
    await act(async () => {});
    expect(onReach).toHaveBeenCalledWith(0);
    expect(screen.getByText('Go through every slide to sign. (1 of 3 seen)')).toBeTruthy();
    expect(dot(2).disabled).toBe(true);
    expect(dot(3).disabled).toBe(true);
    expect(dot(3).title).toBe('Not reached yet');
    expect(back().disabled).toBe(true);

    await userEvent.click(next());
    expect(await screen.findByText('two')).toBeTruthy();
    expect(onReach).toHaveBeenLastCalledWith(1);
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(dot(2).disabled).toBe(false);
    expect(dot(2).getAttribute('aria-current')).toBe('step');
    expect(dot(3).disabled).toBe(true);
    expect(screen.getByText('Go through every slide to sign. (2 of 3 seen)')).toBeTruthy();

    await userEvent.click(next());
    expect(await screen.findByText('three')).toBeTruthy();
    expect(onReach).toHaveBeenLastCalledWith(2);
    expect(next().disabled).toBe(true);
    // every slide seen, no reading time left
    expect(screen.queryByText(/^Go through every slide/)).toBeNull();
    expect(screen.getByText('All slides seen. You can sign now.')).toBeTruthy();
  });

  it('after the last slide, counts down the reading time left, then says it can be signed', async () => {
    const onReach = recorder();
    const { rerender } = render(
      <SlideDeck slides={SLIDES} reached={2} review={false} lang="en" dir="ltr" timeLeft={75} onReach={onReach} />);
    expect(screen.getByText('You can sign in 1:15')).toBeTruthy();
    expect(screen.queryByText(/^Go through every slide/)).toBeNull();
    expect(screen.queryByText('All slides seen. You can sign now.')).toBeNull();
    rerender(<SlideDeck slides={SLIDES} reached={2} review={false} lang="en" dir="ltr" timeLeft={9} onReach={onReach} />);
    expect(screen.getByText('You can sign in 0:09')).toBeTruthy();
    rerender(<SlideDeck slides={SLIDES} reached={2} review={false} lang="en" dir="ltr" timeLeft={0} onReach={onReach} />);
    expect(screen.getByText('All slides seen. You can sign now.')).toBeTruthy();
    expect(screen.queryByText(/^You can sign in/)).toBeNull();
  });

  it('while slides are left, the reading time is not mentioned', async () => {
    deck({ timeLeft: 75 });
    await act(async () => {});
    expect(screen.getByText('Go through every slide to sign. (1 of 3 seen)')).toBeTruthy();
    expect(screen.queryByText(/^You can sign/)).toBeNull();
  });

  it('when signing is not next (the quiz comes first), nothing after the last slide', () => {
    deck({ reached: 2, timeLeft: null });
    expect(screen.queryByText(/^You can sign/)).toBeNull();
    expect(screen.queryByText('All slides seen. You can sign now.')).toBeNull();
  });

  it('opens at the furthest slide reached and allows jumping back', async () => {
    const onReach = deck({ reached: 2 });
    expect(screen.getByText('three')).toBeTruthy();
    expect(screen.getByText('3 / 3')).toBeTruthy();
    expect(next().disabled).toBe(true);
    await userEvent.click(dot(1));
    expect(screen.getByText('one')).toBeTruthy();
    expect(dot(1).getAttribute('aria-current')).toBe('step');
    // forward again over slides already seen: nothing new to report
    await userEvent.click(next());
    expect(screen.getByText('two')).toBeTruthy();
    expect(onReach).not.toHaveBeenCalled();
  });

  it('stays put and says so when saving the place fails', async () => {
    const onReach = vi.fn(async (n: number): Promise<number | null> => (n === 0 ? 0 : null));
    deck({ onReach });
    await act(async () => {});
    await userEvent.click(next());
    expect(await screen.findByText("Couldn't save your place. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.queryByText('two')).toBeNull();
    expect(dot(2).disabled).toBe(true);

    // back online: the next try goes through and the line clears
    onReach.mockImplementation(async (n: number) => n);
    await userEvent.click(next());
    expect(await screen.findByText('two')).toBeTruthy();
    expect(screen.queryByText(/^Couldn't save your place/)).toBeNull();
  });

  it('records the first slide before the second when opening it failed', async () => {
    const onReach = vi.fn(async (_n: number): Promise<number | null> => null);
    deck({ onReach });
    await act(async () => {});
    expect(screen.getByText("Couldn't save your place. Check your connection and try again.")).toBeTruthy();
    onReach.mockImplementation(async (n: number) => n);
    await userEvent.click(next());
    expect(await screen.findByText('two')).toBeTruthy();
    expect(onReach.mock.calls.map(([n]) => n)).toEqual([0, 0, 1]);
  });

  it('a single slide: reported on opening, nothing further to go to', async () => {
    const onReach = deck({ slides: ['<p>only</p>'] });
    expect(screen.getByText('only')).toBeTruthy();
    expect(next().disabled).toBe(true);
    await act(async () => {});
    expect(onReach).toHaveBeenCalledWith(0);
    expect(screen.queryByText(/^Go through every slide/)).toBeNull();
    expect(screen.getByText('All slides seen. You can sign now.')).toBeTruthy();
  });

  it('a failed save offers Try again, which reports the slide on screen', async () => {
    const onReach = vi.fn(async (_n: number): Promise<number | null> => null);
    deck({ slides: ['<p>only</p>'], onReach });
    await act(async () => {});
    expect(screen.getByText("Couldn't save your place. Check your connection and try again.")).toBeTruthy();
    // a one-slide deck has no Next to tap: the line brings its own button
    onReach.mockImplementation(async (n: number) => n);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onReach.mock.calls.map(([n]) => n)).toEqual([0, 0]);
    expect(screen.queryByText(/^Couldn't save your place/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('review mode: every dot enabled, nothing reported', async () => {
    const onReach = deck({ review: true, reached: null });
    await act(async () => {});
    expect(screen.getByText('one')).toBeTruthy();
    expect(dot(3).disabled).toBe(false);
    await userEvent.click(dot(3));
    expect(screen.getByText('three')).toBeTruthy();
    await userEvent.click(back());
    expect(screen.getByText('two')).toBeTruthy();
    expect(onReach).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Go through every slide/)).toBeNull();
    expect(screen.queryByText(/^All slides seen/)).toBeNull();
  });

  it('review mode opens at the first slide, wherever the reading stopped', () => {
    deck({ review: true, reached: 2 });
    expect(screen.getByText('one')).toBeTruthy();
  });

  it('arrow keys move like Back and Next', async () => {
    const onReach = deck();
    await act(async () => {});
    const region = screen.getByRole('region', { name: 'Slides' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(await screen.findByText('two')).toBeTruthy();
    expect(onReach).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(screen.getByText('one')).toBeTruthy();
  });

  it('right to left, the arrow keys follow the reading direction', async () => {
    deck({ dir: 'rtl', lang: 'he' });
    await act(async () => {});
    const region = screen.getByRole('region', { name: 'Slides' });
    expect(region.getAttribute('dir')).toBe('rtl');
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(await screen.findByText('two')).toBeTruthy();
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(screen.getByText('one')).toBeTruthy();
  });

  it('marks the slide text with its language', () => {
    deck({ lang: 'ja' });
    expect(screen.getByText('one').closest('[lang]')?.getAttribute('lang')).toBe('ja');
  });
});
