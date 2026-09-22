// @vitest-environment jsdom
/**
 * StockLineModal — client-side validation (blank description never
 * calls the API), the model→description fill-in, and the STOCK_ERRORS
 * mapping on a server rejection.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type AssetModelItem, type WarehouseContainer } from '../../lib/api';

const api = vi.hoisted(() => ({
  createStockLine: vi.fn(),
  updateStockLine: vi.fn(),
  listAssetModels: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const MODEL: AssetModelItem = {
  id: 'm1', make: 'APC', model: 'AP8941',
  category: 'pdu', category_label: 'PDU', category_color: '#a36207', ru_size: null,
  weight_lbs: null, weight_kg: null, length_in: null, width_in: null, height_in: null,
  length_cm: null, width_cm: null, height_cm: null, mount_type: null, rail_type: null,
  form_factor: null,
  knowledge: '', aliases: [], review_dismissed_at: null,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

const CONTAINERS: WarehouseContainer[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  api.listAssetModels.mockResolvedValue([MODEL]);
});
afterEach(cleanup);

const { default: StockLineModal } = await import('./StockLineModal');

function renderModal() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <StockLineModal siteId="s1" siteName="ACC4 Storage" containers={CONTAINERS}
                     line={null} onClose={onClose} onSaved={onSaved} />,
  );
  return { onSaved, onClose };
}

it('shows the required-description copy and never calls the API', async () => {
  const user = userEvent.setup();
  renderModal();

  await user.click(screen.getByRole('button', { name: /^add stock$/i }));

  expect(await screen.findByText('Describe the stock line.')).not.toBeNull();
  expect(api.createStockLine).not.toHaveBeenCalled();
});

it('picking a model fills a blank description', async () => {
  const user = userEvent.setup();
  renderModal();

  await user.click(screen.getByPlaceholderText('Type to search models…'));
  await user.click(await screen.findByRole('button', { name: /APC AP8941/ }));

  const inputs = document.querySelectorAll<HTMLInputElement>('.pf-form input');
  expect(inputs[0].value).toBe('APC AP8941');
});

it('maps a container_not_at_site rejection onto the STOCK_ERRORS copy', async () => {
  const user = userEvent.setup();
  api.createStockLine.mockRejectedValue(new ApiError(422, 'container_not_at_site'));
  renderModal();

  const inputs = document.querySelectorAll<HTMLInputElement>('.pf-form input');
  await user.type(inputs[0], 'Cage nuts');
  await user.type(inputs[1], '10');
  await user.click(screen.getByRole('button', { name: /^add stock$/i }));

  expect(await screen.findByText('That container is at a different site.')).not.toBeNull();
});
