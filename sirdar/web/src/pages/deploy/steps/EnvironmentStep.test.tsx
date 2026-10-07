// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import { flowCtx } from '../flowFixtures';
import { initialState, withRules, type Errors, type FlowState } from '../flowState';

import EnvironmentStep from './EnvironmentStep';

afterEach(cleanup);
const ctx = flowCtx();

function Harness({ errors = {} }: { errors?: Errors }) {
  const [state, setState] = useState<FlowState>(initialState(ctx));
  return (
    <>
      <EnvironmentStep state={state} set={(p) => setState((s) => withRules({ ...s, ...p }, ctx))} errors={errors} ctx={ctx} />
      <output data-testid="state">{JSON.stringify({ type: state.type, name: state.name, servers: state.servers })}</output>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);

it('offers the four types and a name, focused', async () => {
  render(<Harness />);
  for (const label of ['Production', 'Development', 'UAT', 'Custom']) expect(screen.getByRole('radio', { name: label })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await userEvent.click(screen.getByRole('radio', { name: 'UAT' }));
  expect(state()).toEqual({ type: 'beta', name: 'qa', servers: 'single' });
});

it('production switches to Blue/Green', async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole('radio', { name: 'Production' }));
  expect(state().servers).toBe('bluegreen');
});

it('shows each field error under its field', () => {
  render(<Harness errors={{ name: 'Enter a name.', type: 'Production runs on DigitalOcean: …' }} />);
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(screen.getByText('Production runs on DigitalOcean: …')).toBeTruthy();
});

it('keeps the ref and base domain under Advanced', () => {
  render(<Harness />);
  expect(screen.getByText('Advanced').closest('details')).toBeTruthy();
  expect((screen.getByLabelText('Git ref') as HTMLInputElement).value).toBe('main');
  expect((screen.getByLabelText('Base domain') as HTMLInputElement).placeholder).toBe('<name>.serversherpa.com');
});
