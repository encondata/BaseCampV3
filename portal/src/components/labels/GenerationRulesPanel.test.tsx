// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import { jsonToRuleRows, ruleRowsToJson, type GenerationRulesRows } from '../../lib/generateLabels';
import GenerationRulesPanel from './GenerationRulesPanel';

afterEach(cleanup);

function Harness({ initial }: { initial: GenerationRulesRows }) {
  const [rows, setRows] = useState(initial);
  return <GenerationRulesPanel rows={rows} onChange={setRows} />;
}

it('round-trips rules: add a destination position rule and a length limit', async () => {
  const user = userEvent.setup();
  render(<Harness initial={jsonToRuleRows(undefined)} />);

  // Two "+ Add position" buttons exist (Destination group first, Source second).
  const addPositionButtons = screen.getAllByRole('button', { name: '+ Add position' });
  await user.click(addPositionButtons[0]);
  const posInputs = screen.getAllByLabelText('Destination position');
  const tokenInputs = screen.getAllByLabelText('Destination token');
  await user.type(posInputs[0], '2');
  await user.type(tokenInputs[0], 'row');

  await user.click(screen.getByRole('button', { name: '+ Add length limit' }));
  await user.type(screen.getByLabelText('Length limit token'), 'asset_name');
  await user.type(screen.getByLabelText('Length limit'), '20');

  expect(screen.getByDisplayValue('row')).not.toBeNull();
  expect(screen.getByDisplayValue('asset_name')).not.toBeNull();
  expect(document.querySelector('.pf-error')).toBeNull();

  // The pure helpers this panel is built on round-trip the same shape.
  expect(ruleRowsToJson(jsonToRuleRows({
    destination: { '2': 'row' }, length_limits: { asset_name: 20 },
  }))).toEqual({ destination: { '2': 'row' }, length_limits: { asset_name: 20 } });
});

it('rejects a bad token with an inline error and does not crash', async () => {
  const user = userEvent.setup();
  render(<Harness initial={jsonToRuleRows(undefined)} />);
  const addPositionButtons = screen.getAllByRole('button', { name: '+ Add position' });
  await user.click(addPositionButtons[0]);
  const tokenInputs = screen.getAllByLabelText('Destination token');
  await user.type(tokenInputs[0], 'Row Name');
  const posInputs = screen.getAllByLabelText('Destination position');
  await user.type(posInputs[0], '2');
  expect(await screen.findByText(/lowercase letters, numbers, or underscores/)).not.toBeNull();
});

it('remove clears a row', async () => {
  const user = userEvent.setup();
  render(<Harness initial={jsonToRuleRows({ destination: { '1': 'nap' } })} />);
  expect(screen.getByDisplayValue('nap')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Remove destination rule' }));
  expect(screen.queryByDisplayValue('nap')).toBeNull();
});
