// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ getMoveAssetTemplateColumns: vi.fn(), downloadMoveAssetTemplate: vi.fn() }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), ...apiMock }));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ maxRank: 60, can: () => true }) }));

const { ApiError } = await import('../lib/api');
const { default: BulkConvertRawFt } = await import('./BulkConvertRawFt');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const COLUMNS = [
  { header: 'Serial Number', field: 'serial_number', aliases: [], required: true, accepts: 'Text', example: 'SN-1' },
];

it('shows the loading line, then step 1 of 3 with the step row and the collapsed template columns', async () => {
  apiMock.getMoveAssetTemplateColumns.mockResolvedValue(COLUMNS);
  render(<MemoryRouter><BulkConvertRawFt /></MemoryRouter>);
  expect(screen.getByText('Loading our template columns…')).toBeTruthy();
  expect(await screen.findByText('Drop your file here, or click to browse')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Step 1 of 3 · Upload the raw F-T' })).toBeTruthy();
  for (const label of ['Upload', 'Match', 'Download']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText('Loading our template columns…')).toBeNull();

  const panel = screen.getByRole('button', { name: /Our template columns/ });
  expect(panel.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('table', { name: 'Template columns' })).toBeNull();
  expect(panel.textContent).toContain('1');
  fireEvent.click(panel);
  expect(panel.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('table', { name: 'Template columns' }).textContent).toContain('SN-1');
  expect(screen.getByText('The converted file is built in your browser. The From-To import accepts files up to 20 MB.')).toBeTruthy();
});

it('disables Next until a file is read', async () => {
  apiMock.getMoveAssetTemplateColumns.mockResolvedValue(COLUMNS);
  render(<MemoryRouter><BulkConvertRawFt /></MemoryRouter>);
  await screen.findByText('Drop your file here, or click to browse');
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
});

it('downloads the template as .xlsx or .csv', async () => {
  apiMock.getMoveAssetTemplateColumns.mockResolvedValue(COLUMNS);
  apiMock.downloadMoveAssetTemplate.mockResolvedValue(undefined);
  render(<MemoryRouter><BulkConvertRawFt /></MemoryRouter>);
  await screen.findByText('Drop your file here, or click to browse');
  fireEvent.click(screen.getByRole('button', { name: 'Template (.xlsx)' }));
  expect(apiMock.downloadMoveAssetTemplate).toHaveBeenLastCalledWith('xlsx');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Template (.csv)' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  expect(apiMock.downloadMoveAssetTemplate).toHaveBeenLastCalledWith('csv');
});

it('says so when the template columns cannot be loaded', async () => {
  apiMock.getMoveAssetTemplateColumns.mockRejectedValue(new Error('nope'));
  render(<MemoryRouter><BulkConvertRawFt /></MemoryRouter>);
  expect(await screen.findByText("Couldn't load our template columns. Reload the page to try again.")).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
});

it('says who can use the tool when the template columns are forbidden (403)', async () => {
  apiMock.getMoveAssetTemplateColumns.mockRejectedValue(new ApiError(403, 'forbidden'));
  render(<MemoryRouter><BulkConvertRawFt /></MemoryRouter>);
  expect(await screen.findByText('This tool needs company-wide access to moves. Ask an administrator.')).toBeTruthy();
  expect(screen.queryByText("Couldn't load our template columns. Reload the page to try again.")).toBeNull();
});

it('keeps the reload message for other API errors', async () => {
  apiMock.getMoveAssetTemplateColumns.mockRejectedValue(new ApiError(500, 'boom'));
  render(<MemoryRouter><BulkConvertRawFt /></MemoryRouter>);
  expect(await screen.findByText("Couldn't load our template columns. Reload the page to try again.")).toBeTruthy();
});
