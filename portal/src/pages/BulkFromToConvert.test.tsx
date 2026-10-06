// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ getMoveAssetTemplateColumns: vi.fn(), downloadMoveAssetTemplate: vi.fn() }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), ...apiMock }));

const { ApiError } = await import('../lib/api');
const { default: BulkFromToConvert } = await import('./BulkFromToConvert');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows the server template columns as the guide, then the pane', async () => {
  apiMock.getMoveAssetTemplateColumns.mockResolvedValue([
    { header: 'Serial Number', field: 'serial_number', aliases: [], required: true, accepts: 'Text', example: 'SN-1' },
  ]);
  render(<BulkFromToConvert />);
  expect(screen.getByText('Loading our template columns…')).toBeTruthy();
  expect(await screen.findByText('Drop your file here, or click to browse')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Convert a customer From-To' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Template columns' }).textContent).toContain('SN-1');
  expect(screen.getByRole('button', { name: 'Template (.xlsx)' })).toBeTruthy();
  expect(screen.getByText('The converted file is built in your browser. The From-To import accepts files up to 20 MB.')).toBeTruthy();
});

it('says so when the template columns cannot be loaded', async () => {
  apiMock.getMoveAssetTemplateColumns.mockRejectedValue(new Error('nope'));
  render(<BulkFromToConvert />);
  expect(await screen.findByText("Couldn't load our template columns. Reload the page to try again.")).toBeTruthy();
});

it('says who can use the tool when the template columns are forbidden (403)', async () => {
  apiMock.getMoveAssetTemplateColumns.mockRejectedValue(new ApiError(403, 'forbidden'));
  render(<BulkFromToConvert />);
  expect(await screen.findByText('This tool needs company-wide access to moves. Ask an administrator.')).toBeTruthy();
  expect(screen.queryByText("Couldn't load our template columns. Reload the page to try again.")).toBeNull();
});

it('keeps the reload message for other API errors', async () => {
  apiMock.getMoveAssetTemplateColumns.mockRejectedValue(new ApiError(500, 'boom'));
  render(<BulkFromToConvert />);
  expect(await screen.findByText("Couldn't load our template columns. Reload the page to try again.")).toBeTruthy();
});
