// @vitest-environment jsdom
// No jest-dom matchers in this project: assertions read DOM properties
// directly (see AiLookupControls.test.tsx).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getBranding: vi.fn(),
  updateBranding: vi.fn(),
  uploadBrandingLogo: vi.fn(),
  removeBrandingLogo: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
}));
vi.mock('../../lib/api', () => api);

const { default: BrandingControls } = await import('./BrandingControls');

const NO_LOGO = { company_name: 'Cumulus Solutions Group', has_logo: false, logo_url: null };
const WITH_LOGO = { company_name: 'Cumulus Solutions Group', has_logo: true,
                    logo_url: 'https://files.test/branding/company-logo/a.png' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getBranding.mockResolvedValue({ ...NO_LOGO });
});
afterEach(cleanup);

const nameInput = () => screen.getByLabelText('Company name') as HTMLInputElement;
const fileInput = () => screen.getByLabelText('Company logo file') as HTMLInputElement;
const png = (bytes = 10) => new File([new Uint8Array(bytes)], 'logo.png', { type: 'image/png' });

it('shows the company name and the logo', async () => {
  api.getBranding.mockResolvedValue({ ...WITH_LOGO, company_name: 'Cumulus East' });
  render(<BrandingControls canChange />);
  await waitFor(() => expect(nameInput().value).toBe('Cumulus East'));
  const img = screen.getByRole('img', { name: 'Company logo' }) as HTMLImageElement;
  expect(img.src).toBe(WITH_LOGO.logo_url);
  expect(screen.getByRole('button', { name: 'Replace logo…' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
});

it('without a logo: a placeholder, Upload, and no Remove', async () => {
  render(<BrandingControls canChange />);
  expect(await screen.findByText('No logo')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Company logo' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Upload logo…' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
});

it('saves the company name, trimmed, only when it changed', async () => {
  api.updateBranding.mockResolvedValue({ ...NO_LOGO, company_name: 'Cumulus West' });
  render(<BrandingControls canChange />);
  await waitFor(() => expect(nameInput().value).toBe('Cumulus Solutions Group'));
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await userEvent.clear(nameInput());
  await userEvent.type(nameInput(), '  Cumulus West ');
  expect(save.disabled).toBe(false);
  await userEvent.click(save);
  await waitFor(() => expect(api.updateBranding).toHaveBeenCalledWith({ company_name: 'Cumulus West' }));
  await waitFor(() => expect(nameInput().value).toBe('Cumulus West'));
  expect(save.disabled).toBe(true);
});

it('refuses a blank company name without calling the API', async () => {
  render(<BrandingControls canChange />);
  await waitFor(() => expect(nameInput().value).toBe('Cumulus Solutions Group'));
  await userEvent.clear(nameInput());
  await userEvent.type(nameInput(), '   ');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Enter a company name.');
  expect(api.updateBranding).not.toHaveBeenCalled();
});

it('uploading a picked file calls the route and shows the new logo', async () => {
  api.uploadBrandingLogo.mockResolvedValue({ ...WITH_LOGO });
  render(<BrandingControls canChange />);
  await screen.findByText('No logo');
  const file = png();
  await userEvent.upload(fileInput(), file);
  await waitFor(() => expect(api.uploadBrandingLogo).toHaveBeenCalledWith(file));
  const img = await screen.findByRole('img', { name: 'Company logo' }) as HTMLImageElement;
  expect(img.src).toBe(WITH_LOGO.logo_url);
});

it('checks the type and size before uploading, and reports a refusal', async () => {
  render(<BrandingControls canChange />);
  await screen.findByText('No logo');
  const gif = new File([new Uint8Array(4)], 'logo.gif', { type: 'image/gif' });
  await userEvent.upload(fileInput(), gif, { applyAccept: false });
  expect((await screen.findByRole('alert')).textContent).toBe('Use a PNG, JPEG, or WebP image.');
  await userEvent.upload(fileInput(), png(5 * 1024 * 1024 + 1));
  expect((await screen.findByRole('alert')).textContent).toBe('The logo is over 5 MB.');
  expect(api.uploadBrandingLogo).not.toHaveBeenCalled();
  api.uploadBrandingLogo.mockRejectedValue(new api.ApiError(422, 'unreadable_image'));
  await userEvent.upload(fileInput(), png());
  expect((await screen.findByRole('alert')).textContent).toBe('That file could not be read as an image.');
});

it('Remove asks once in the confirm dialog, then clears the logo', async () => {
  api.getBranding.mockResolvedValue({ ...WITH_LOGO });
  api.removeBrandingLogo.mockResolvedValue({ ...NO_LOGO });
  const confirm = vi.spyOn(window, 'confirm');
  render(<BrandingControls canChange />);
  await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove the company logo' });
  // the report-generate header: eyebrow, title, description
  expect(within(dialog).getByText('System settings · Branding')).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Remove the company logo?' })).toBeTruthy();
  expect(api.removeBrandingLogo).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove logo' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.removeBrandingLogo).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByText('No logo')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  confirm.mockRestore();
});

it('the Remove confirm takes the focus, on Cancel', async () => {
  api.getBranding.mockResolvedValue({ ...WITH_LOGO });
  render(<BrandingControls canChange />);
  await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove the company logo' });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
});

it('Cancel and Escape close the dialog without removing', async () => {
  api.getBranding.mockResolvedValue({ ...WITH_LOGO });
  render(<BrandingControls canChange />);
  await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.removeBrandingLogo).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: 'Company logo' })).toBeTruthy();
});

it('is read-only without settings:change', async () => {
  api.getBranding.mockResolvedValue({ ...WITH_LOGO });
  render(<BrandingControls canChange={false} />);
  await waitFor(() => expect(nameInput().value).toBe('Cumulus Solutions Group'));
  expect(nameInput().disabled).toBe(true);
  for (const name of ['Save', 'Replace logo…', 'Remove']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
});
