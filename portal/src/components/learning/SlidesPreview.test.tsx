// @vitest-environment jsdom
/**
 * The manager's preview of a Slides document: one slide at a time with
 * Back / Next, a numbered dot per slide (all enabled; a manager is not being
 * gated) and "k / n".
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';

import SlidesPreview from './SlidesPreview';

afterEach(cleanup);

const SLIDES = ['<h2>One</h2><p>first</p>', '<h2>Two</h2><p>second</p>', '<h2>Three</h2><p>third</p>'];

it('steps through slides with Back/Next and dots', async () => {
  const user = userEvent.setup();
  render(<SlidesPreview slides={SLIDES} />);
  expect(screen.getByText('first')).toBeTruthy();
  expect(screen.getByText('1 / 3')).toBeTruthy();
  const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
  const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  expect(back.disabled).toBe(true);

  await user.click(next);
  expect(screen.getByText('second')).toBeTruthy();
  expect(screen.getByText('2 / 3')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Go to slide 2' }).getAttribute('aria-current')).toBe('step');

  // every dot is enabled: jump straight to the last slide
  const dots = [1, 2, 3].map((k) => screen.getByRole('button', { name: `Go to slide ${k}` }) as HTMLButtonElement);
  expect(dots.every((d) => !d.disabled)).toBe(true);
  await user.click(dots[2]);
  expect(screen.getByText('third')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);

  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('second')).toBeTruthy();
});

it('arrow keys move like Back and Next', async () => {
  const user = userEvent.setup();
  render(<SlidesPreview slides={SLIDES} />);
  screen.getByRole('region', { name: 'Slides' }).focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByText('2 / 3')).toBeTruthy();
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByText('1 / 3')).toBeTruthy();
});

it('a single slide has both buttons disabled', () => {
  render(<SlidesPreview slides={['<p>only</p>']} />);
  expect(screen.getByText('1 / 1')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});
