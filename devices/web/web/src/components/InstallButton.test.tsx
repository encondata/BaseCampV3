// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({
  platform: 'desktop' as 'android' | 'ios' | 'desktop',
  device: 'iPhone' as 'iPad' | 'iPhone',
}));
vi.mock('../lib/platform', () => ({ viewerPlatform: () => viewer.platform, viewerDevice: () => viewer.device }));
vi.mock('../lib/goTo', () => ({ goTo: vi.fn() }));
vi.mock('@portal/lib/qr', () => ({ qrDataUrl: vi.fn((text: string) => `data:image/png;qr,${text}`) }));
vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import { qrDataUrl } from '@portal/lib/qr';

import type { AppOut } from '../lib/appsApi';
import { goTo } from '../lib/goTo';
import { androidApp, iosApp, json, stubApi } from '../testing/fakeApi';
import InstallButton from './InstallButton';

const asApp = (a: unknown) => a as AppOut;

beforeEach(() => {
  vi.mocked(goTo).mockClear();
  viewer.device = 'iPhone';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InstallButton', () => {
  it('Android card on Android shows Install + Play hint', async () => {
    viewer.platform = 'android';
    const calls = stubApi({
      'POST /api/apps/app-a/install': { url: 'https://devices.test/dl/tok/kiosk.apk' },
    });
    render(<InstallButton app={asApp(androidApp())} deviceRef={null} onChanged={() => {}} />);
    expect(screen.getByText('Got it from Google Play? Uninstall it first.')).toBeTruthy();
    expect(screen.queryByText('Open this page on the phone to install.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('https://devices.test/dl/tok/kiosk.apk'));
    expect(calls).toEqual([expect.objectContaining({ method: 'POST', path: '/api/apps/app-a/install' })]);
  });

  it('iOS register_first opens Add this iPhone modal and requires a name', async () => {
    viewer.platform = 'ios';
    const calls = stubApi({ 'POST /api/enroll': { url: '/enroll/abc.mobileconfig' } });
    render(<InstallButton app={asApp(iosApp())} deviceRef={null} onChanged={() => {}} />);
    expect(screen.getByText("This iPhone isn't registered.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Add this iPhone' }));
    const dialog = screen.getByRole('dialog', { name: 'Add this iPhone' });
    expect(within(dialog).getByText('Devices')).toBeTruthy();
    expect(within(dialog).getByText('Tap Continue, then Allow.')).toBeTruthy();
    expect(within(dialog).getByText('Open Settings, tap Profile Downloaded, then Install.')).toBeTruthy();
    expect(within(dialog).getByText("You'll come back here automatically.")).toBeTruthy();
    expect(within(dialog).getByText("iOS shows the profile as Not Signed; that's expected.")).toBeTruthy();

    const cont = within(dialog).getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    const name = within(dialog).getByLabelText('Name this iPhone');
    await userEvent.type(name, '   ');
    expect(cont.disabled).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, "Jimmy's iPhone");
    expect(cont.disabled).toBe(false);
    await userEvent.click(cont);
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/enroll/abc.mobileconfig'));
    expect(calls).toEqual([
      expect.objectContaining({ method: 'POST', path: '/api/enroll', body: { device_name: "Jimmy's iPhone", device: 'iphone' } }),
    ]);
  });

  it('on an iPad it says iPad and tells the API so', async () => {
    viewer.platform = 'ios';
    viewer.device = 'iPad';
    const calls = stubApi({
      'POST /api/enroll': { url: '/enroll/abc.mobileconfig?device=ipad' },
      'POST /api/apps/app-i/install': () => json(202, { state: 'preparing', message: 'Preparing the app for this iPad…' }),
    });
    const { rerender } = render(<InstallButton app={asApp(iosApp({ ios_state: { state: 'register_first', message: "This iPad isn't registered." } }))}
                                               deviceRef={null} onChanged={() => {}} />);
    expect(screen.getByText("This iPad isn't registered.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add this iPhone' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add this iPad' }));
    const dialog = screen.getByRole('dialog', { name: 'Add this iPad' });
    expect(within(dialog).getByText("iOS shows the profile as Not Signed; that's expected.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Name this iPad'), "Jimmy's iPad");
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/enroll/abc.mobileconfig?device=ipad'));
    expect(calls[0]).toEqual(expect.objectContaining({
      method: 'POST', path: '/api/enroll', body: { device_name: "Jimmy's iPad", device: 'ipad' },
    }));

    rerender(<InstallButton app={asApp(iosApp({ ios_state: { state: 'ready', message: '', install_url: 'x' } }))}
                            deviceRef="dev-1" onChanged={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ device_ref: 'dev-1', device: 'ipad' });
  });

  it('desktop shows QR and no install button', () => {
    viewer.platform = 'desktop';
    stubApi({});
    render(<InstallButton app={asApp(androidApp())} deviceRef={null} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.queryByText('Got it from Google Play? Uninstall it first.')).toBeNull();
    expect(screen.getByText('Open this page on the phone to install.')).toBeTruthy();
    const img = screen.getByRole('img', { name: 'QR code for this page' }) as HTMLImageElement;
    expect(img.src).toBe(`data:image/png;qr,${location.href}`);
    expect(qrDataUrl).toHaveBeenCalledWith(location.href);
  });

  it('a card for the other platform gets the QR, not an install button', () => {
    viewer.platform = 'android';
    stubApi({});
    render(<InstallButton app={asApp(iosApp())} deviceRef={null} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Add this iPhone' })).toBeNull();
    expect(screen.getByText('Open this page on the phone to install.')).toBeTruthy();
  });

  it('iOS ready installs with the device ref; preparing is a disabled Preparing…', async () => {
    viewer.platform = 'ios';
    const calls = stubApi({
      'POST /api/apps/app-i/install': { url: 'itms-services://?action=download-manifest&url=x' },
    });
    const ready = asApp(iosApp({ ios_state: { state: 'ready', message: '', install_url: 'itms-services://old' } }));
    const { rerender } = render(<InstallButton app={ready} deviceRef="dev-1" onChanged={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('itms-services://?action=download-manifest&url=x'));
    expect(calls[0].body).toEqual({ device_ref: 'dev-1', device: 'iphone' });

    const preparing = asApp(iosApp({ ios_state: { state: 'preparing', message: 'Preparing the app for this iPhone…' } }));
    rerender(<InstallButton app={preparing} deviceRef="dev-1" onChanged={() => {}} />);
    expect(screen.getByText('Preparing the app for this iPhone…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Preparing…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['failed', "Registering with Apple didn't finish. Add this device again to retry."],
    ['disabled', 'This iPhone was removed from Devices.'],
  ])('an iPhone in %s gets Add this iPhone again', async (state, message) => {
    viewer.platform = 'ios';
    const calls = stubApi({ 'POST /api/enroll': { url: '/enroll/again.mobileconfig' } });
    render(<InstallButton app={asApp(iosApp({ ios_state: { state, message, retrying: false } }))}
                          deviceRef="dev-1" onChanged={() => {}} />);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add this iPhone' }));
    const dialog = screen.getByRole('dialog', { name: 'Add this iPhone' });
    await userEvent.type(within(dialog).getByLabelText('Name this iPhone'), "Jimmy's iPhone");
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/enroll/again.mobileconfig'));
    expect(calls).toEqual([expect.objectContaining({ method: 'POST', path: '/api/enroll' })]);
  });

  it('a build that failed shows why, with nothing to tap', () => {
    viewer.platform = 'ios';
    stubApi({});
    const why = "This app needs aps-environment, which its App ID doesn't have in Apple's developer site. "
      + 'Turn it on there, then upload the app again.';
    render(<InstallButton app={asApp(iosApp({ ios_state: { state: 'build_failed', message: why, retrying: false } }))}
                          deviceRef="dev-1" onChanged={() => {}} />);
    expect(screen.getByText(why)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an install that comes back preparing refreshes the card', async () => {
    viewer.platform = 'ios';
    stubApi({
      'POST /api/apps/app-i/install': () => json(202, { state: 'preparing', message: 'Preparing the app for this iPhone…' }),
    });
    const onChanged = vi.fn();
    const ready = asApp(iosApp({ ios_state: { state: 'ready', message: '', install_url: 'x' } }));
    render(<InstallButton app={ready} deviceRef="dev-1" onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(goTo).not.toHaveBeenCalled();
  });
});
