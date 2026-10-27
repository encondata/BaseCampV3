// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SignaturePad from './SignaturePad';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function ctxStub() {
  const ctx = { scale: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

describe('SignaturePad', () => {
  it('maps the pointer back to the drawing surface after the box is resized', () => {
    const ctx = ctxStub();
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    rect.mockReturnValue({ left: 0, top: 0, width: 600, height: 140 } as DOMRect);
    render(<SignaturePad onChange={() => {}} />);
    const pad = screen.getByLabelText('Draw your signature') as HTMLCanvasElement;
    expect(pad.width).toBe(600);

    // the phone turns: the same canvas is now half as wide on screen
    rect.mockReturnValue({ left: 100, top: 20, width: 300, height: 140 } as DOMRect);
    fireEvent.pointerDown(pad, { clientX: 250, clientY: 90, pointerId: 1 });
    // 150px across a 300px box is the middle of a 600-unit surface
    expect(ctx.moveTo).toHaveBeenCalledWith(300, 70);
    fireEvent.pointerMove(pad, { clientX: 400, clientY: 90, pointerId: 1 });
    expect(ctx.lineTo).toHaveBeenLastCalledWith(600, 70);
  });

  it('scales by the screen density too', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const ctx = ctxStub();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, top: 0, width: 300, height: 140 } as DOMRect);
    render(<SignaturePad onChange={() => {}} />);
    const pad = screen.getByLabelText('Draw your signature') as HTMLCanvasElement;
    expect(pad.width).toBe(600);
    fireEvent.pointerDown(pad, { clientX: 150, clientY: 70, pointerId: 1 });
    // the context is scaled by the density, so drawing stays in CSS pixels
    expect(ctx.moveTo).toHaveBeenCalledWith(150, 70);
    vi.unstubAllGlobals();
  });
});
