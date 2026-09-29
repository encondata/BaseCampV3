// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ImageLightbox from './ImageLightbox';

afterEach(cleanup);

function open(onClose = vi.fn()) {
  render(<ImageLightbox src="https://s3/rack.png" alt="Rack front" caption="Rack 12, front" onClose={onClose} />);
  return onClose;
}

const scaleOf = () => screen.getByRole('img', { name: 'Rack front' }).style.transform;

describe('ImageLightbox', () => {
  it('shows the image full screen in a dialog with its caption', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Rack 12, front' });
    expect(dialog.parentElement).toBe(document.body); // portaled above the page
    expect(screen.getByRole('img', { name: 'Rack front' }).getAttribute('src')).toBe('https://s3/rack.png');
    expect(screen.getByText('Rack 12, front')).toBeTruthy();
  });

  it('links to the original in a new tab', () => {
    open();
    const link = screen.getByRole('link', { name: 'Open original' });
    expect(link.getAttribute('href')).toBe('https://s3/rack.png');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('zooms in and out with the buttons, and Fit resets', () => {
    open();
    expect(scaleOf()).toContain('scale(1)');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf()).toContain('scale(1.5)');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf()).toContain('scale(2.25)');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(scaleOf()).toContain('scale(1.5)');
    fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(scaleOf()).toContain('scale(1)');
  });

  it('zooms with the keyboard and closes on Escape', () => {
    const onClose = open();
    fireEvent.keyDown(document, { key: '+' });
    expect(scaleOf()).toContain('scale(1.5)');
    fireEvent.keyDown(document, { key: '0' });
    expect(scaleOf()).toContain('scale(1)');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('zooms with the wheel', () => {
    open();
    fireEvent.wheel(screen.getByTestId('lightbox-stage'), { deltaY: -100 });
    expect(scaleOf()).not.toContain('scale(1)');
  });

  it('closes from the Close button and from a click beside the image, not on it', () => {
    const onClose = open();
    fireEvent.click(screen.getByRole('img', { name: 'Rack front' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('lightbox-stage'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus to Close and stops the page behind from scrolling', () => {
    open();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(document.body.style.overflow).toBe('hidden');
    cleanup();
    expect(document.body.style.overflow).toBe('');
  });
});
