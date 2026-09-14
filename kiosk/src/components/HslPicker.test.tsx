// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import HslPicker from './HslPicker';

/** hsl(150 60% 45%) as jsdom reports it back. */
const GOOD_RGB = 'rgb(46, 184, 115)';

afterEach(() => cleanup());

it('renders a swatch, three labeled sliders, and the mono readout', () => {
  render(<HslPicker name="Good scan flash" value={{ h: 150, s: 60, l: 45 }} onChange={() => {}} />);
  expect(screen.getByLabelText('Good scan flash hue')).toBeTruthy();
  expect(screen.getByLabelText('Good scan flash saturation')).toBeTruthy();
  expect(screen.getByLabelText('Good scan flash lightness')).toBeTruthy();
  expect(screen.getByText('hsl(150 60% 45%)')).toBeTruthy();
  const swatch = document.querySelector('.hsl-swatch') as HTMLElement;
  // jsdom normalizes an hsl() background to its rgb() equivalent.
  expect(swatch.style.background).toBe(GOOD_RGB);
});

it('each slider reports the whole color back with only its channel changed', () => {
  const onChange = vi.fn();
  render(<HslPicker name="Good scan flash" value={{ h: 150, s: 60, l: 45 }} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Good scan flash hue'), { target: { value: '210' } });
  expect(onChange).toHaveBeenCalledWith({ h: 210, s: 60, l: 45 });
  fireEvent.change(screen.getByLabelText('Good scan flash saturation'), { target: { value: '20' } });
  expect(onChange).toHaveBeenCalledWith({ h: 150, s: 20, l: 45 });
  fireEvent.change(screen.getByLabelText('Good scan flash lightness'), { target: { value: '80' } });
  expect(onChange).toHaveBeenCalledWith({ h: 150, s: 60, l: 80 });
});

it('the readout follows the value it is given', () => {
  const { rerender } = render(
    <HslPicker name="Not-found scan flash" value={{ h: 0, s: 70, l: 50 }} onChange={() => {}} />,
  );
  expect(screen.getByText('hsl(0 70% 50%)')).toBeTruthy();
  rerender(<HslPicker name="Not-found scan flash" value={{ h: 12, s: 71, l: 51 }} onChange={() => {}} />);
  expect(screen.getByText('hsl(12 71% 51%)')).toBeTruthy();
});

it('Preview flash triggers a flash in this color', async () => {
  const flash = await import('../lib/flash');
  render(<HslPicker name="Good scan flash" value={{ h: 150, s: 60, l: 45 }} onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview flash' }));
  expect(flash.readFlash()?.color).toBe('hsl(150 60% 45%)');
});
