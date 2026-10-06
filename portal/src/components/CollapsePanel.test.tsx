// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import CollapsePanel from './CollapsePanel';

afterEach(cleanup);

const body = () => screen.getByText('panel body');
const head = () => screen.getByRole('button', { name: /Things/ });

it('uncontrolled: defaultOpen false hides the body, clicking the head opens it', () => {
  render(<CollapsePanel title="Things"><p>panel body</p></CollapsePanel>);
  expect(body().parentElement?.hidden).toBe(true);
  expect(head().getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(head());
  expect(body().parentElement?.hidden).toBe(false);
  expect(head().getAttribute('aria-expanded')).toBe('true');
});

it('controlled: the click reports the next state and the body waits for the parent', () => {
  const onToggle = vi.fn();
  const { rerender } = render(
    <CollapsePanel title="Things" open={false} onToggle={onToggle}>
      <p>panel body</p>
    </CollapsePanel>,
  );
  fireEvent.click(head());
  expect(onToggle).toHaveBeenCalledWith(true);
  expect(body().parentElement?.hidden).toBe(true);
  expect(head().getAttribute('aria-expanded')).toBe('false');
  rerender(
    <CollapsePanel title="Things" open={true} onToggle={onToggle}>
      <p>panel body</p>
    </CollapsePanel>,
  );
  expect(body().parentElement?.hidden).toBe(false);
  expect(head().getAttribute('aria-expanded')).toBe('true');
});

it('controlled + lazy: mounts on first open and stays mounted after closing', () => {
  const tree = (open: boolean) => (
    <CollapsePanel title="Things" open={open} onToggle={() => {}} render="lazy">
      <p>panel body</p>
    </CollapsePanel>
  );
  const { rerender } = render(tree(false));
  expect(screen.queryByText('panel body')).toBeNull();
  rerender(tree(true));
  expect(screen.queryByText('panel body')).not.toBeNull();
  rerender(tree(false));
  expect(body().parentElement?.hidden).toBe(true);
});
