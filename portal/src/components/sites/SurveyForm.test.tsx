// @vitest-environment jsdom
/**
 * Whole-number survey fields (Dock to DC distance, Floor) are plain text
 * boxes with a numeric keypad hint — no spinner arrows — that only accept
 * whole numbers as you type.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import type { SurveySchema } from '../../lib/api';
import SurveyForm from './SurveyForm';

const SCHEMA: SurveySchema = {
  groups: [{
    key: 'dock', label: 'Dock & access',
    fields: [{ key: 'dock_to_dc_distance_ft', label: 'Dock to DC distance (ft)', kind: 'int', options: [] }],
  }],
} as SurveySchema;

function Harness({ initial }: { initial?: unknown }) {
  const [values, setValues] = useState<Record<string, unknown>>(
    initial === undefined ? {} : { dock_to_dc_distance_ft: initial });
  return (
    <SurveyForm schema={SCHEMA} values={values}
                onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))} />
  );
}

afterEach(cleanup);

it('renders a whole-number field without spinner arrows', () => {
  render(<Harness initial={120} />);
  const input = screen.getByLabelText('Dock to DC distance (ft)') as HTMLInputElement;
  expect(input.type).toBe('text');
  expect(input.getAttribute('inputmode')).toBe('numeric');
  expect(input.value).toBe('120');
});

it('only accepts whole numbers as you type', async () => {
  render(<Harness />);
  const input = screen.getByLabelText('Dock to DC distance (ft)') as HTMLInputElement;
  await userEvent.type(input, '1a2.5 0');
  expect(input.value).toBe('1250');
  await userEvent.clear(input);
  expect(input.value).toBe('');
  await userEvent.type(input, '-3');
  expect(input.value).toBe('-3');
  await userEvent.type(input, '-');
  expect(input.value).toBe('-3');
});
