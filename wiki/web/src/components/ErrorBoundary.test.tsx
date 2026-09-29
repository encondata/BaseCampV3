// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ErrorBoundary from './ErrorBoundary';

function Boom({ error }: { error: Error | null }): JSX.Element {
  if (error) throw error;
  return <p>page content</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors; keep the test output readable
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders its children when nothing throws', () => {
    render(<ErrorBoundary><Boom error={null} /></ErrorBoundary>);
    expect(screen.getByText('page content')).toBeTruthy();
  });

  it('shows the error instead of a blank screen when a child throws', () => {
    render(<ErrorBoundary><Boom error={new Error('node.attrs is undefined')} /></ErrorBoundary>);
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(screen.getByText('node.attrs is undefined')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('says a failed download is fixed by reloading', () => {
    render(
      <ErrorBoundary>
        <Boom error={new TypeError('Failed to fetch dynamically imported module: https://wiki/src/pages/PageView.tsx')} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/couldn't be downloaded/)).toBeTruthy();
  });

  it('logs the error with the component stack', () => {
    render(<ErrorBoundary><Boom error={new Error('kaboom')} /></ErrorBoundary>);
    const logged = vi.mocked(console.error).mock.calls.find((c) => c[0] === '[wiki] render error');
    expect(logged?.[1]).toBeInstanceOf(Error);
  });

  it('keeps the page scope inside the wiki shell (no second full-height shell)', () => {
    const { container } = render(
      <ErrorBoundary scope="page"><Boom error={new Error('kaboom')} /></ErrorBoundary>,
    );
    expect(container.querySelector('.portal-shell')).toBeNull();
    expect(container.querySelector('.wiki-page')).toBeTruthy();
  });

  it('recovers when the reset key changes (navigating to another page)', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/n/a"><Boom error={new Error('kaboom')} /></ErrorBoundary>,
    );
    expect(screen.getByText('kaboom')).toBeTruthy();
    rerender(<ErrorBoundary resetKey="/n/b"><Boom error={null} /></ErrorBoundary>);
    expect(screen.getByText('page content')).toBeTruthy();
  });

  it('reloads the page from the Reload button', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    render(<ErrorBoundary><Boom error={new Error('kaboom')} /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
  });
});
