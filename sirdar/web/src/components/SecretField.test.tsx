// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import SecretField from './SecretField';

afterEach(cleanup);

const base = { id: 's', label: 'API key', value: '', onValue: vi.fn() };

it('a set secret offers Replace and Clear; Replace asks for the new value', async () => {
  const onAction = vi.fn();
  render(<SecretField {...base} isSet adding={false} action="keep" onAction={onAction} />);
  expect(screen.getByText('API key: set')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
  expect(onAction).toHaveBeenCalledWith('set');
  await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(onAction).toHaveBeenCalledWith('clear');
});

it('disabled shows the state with no buttons and no input', () => {
  render(<SecretField {...base} isSet adding={false} action="set" disabled onAction={vi.fn()} />);
  expect(screen.getByText('API key: set')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByLabelText('API key')).toBeNull();
});
