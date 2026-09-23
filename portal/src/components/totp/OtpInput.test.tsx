// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import OtpInput from './OtpInput';

afterEach(cleanup);

function Harness({ onComplete }: { onComplete: (v: string) => void }) {
  const [v, setV] = useState('');
  return <OtpInput value={v} onChange={setV} onComplete={onComplete} autoFocus />;
}

it('typing advances box to box and fires onComplete on the sixth digit', async () => {
  const done = vi.fn();
  const user = userEvent.setup();
  render(<Harness onComplete={done} />);
  const boxes = screen.getAllByRole('textbox');
  expect(boxes).toHaveLength(6);
  await user.type(boxes[0], '123456');
  expect(done).toHaveBeenCalledWith('123456');
  expect((boxes[5] as HTMLInputElement).value).toBe('6');
});

it('pasting six digits fills every box', () => {
  const done = vi.fn();
  render(<Harness onComplete={done} />);
  const boxes = screen.getAllByRole('textbox');
  fireEvent.paste(boxes[0], { clipboardData: { getData: () => '98 76 54' } });
  expect(done).toHaveBeenCalledWith('987654');
});

it('Backspace on an empty box moves back', async () => {
  const user = userEvent.setup();
  render(<Harness onComplete={() => {}} />);
  const boxes = screen.getAllByRole('textbox');
  await user.type(boxes[0], '12');
  await user.keyboard('{Backspace}{Backspace}');
  expect(document.activeElement).toBe(boxes[0]);
});

it('the six boxes are grouped with an accessible label', () => {
  render(<Harness onComplete={() => {}} />);
  const group = screen.getByRole('group', { name: 'Verification code' });
  expect(screen.getAllByLabelText(/^Digit \d$/)).toHaveLength(6);
  expect(group.querySelectorAll('input')).toHaveLength(6);
});

it('a whole code landing in one box (autofill or a fast burst) fills every box', () => {
  const done = vi.fn();
  render(<Harness onComplete={done} />);
  const boxes = screen.getAllByLabelText(/^Digit \d$/);
  fireEvent.change(boxes[0], { target: { value: '499622' } });
  expect(done).toHaveBeenCalledWith('499622');
  expect((boxes[5] as HTMLInputElement).value).toBe('2');
});
