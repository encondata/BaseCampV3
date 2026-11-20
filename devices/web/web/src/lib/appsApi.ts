/** The devices API calls behind the pages: the catalog, installing,
 *  adding an iPhone or iPad, the version actions, uploading, the device list and
 *  the Apple settings. Shapes follow devices/api routes apps.py,
 *  install.py, enroll.py, uploads.py, devices.py, apple.py. */
import { ApiError } from '@portal/lib/api';

import { devicesFetch } from './devicesApi';
import type { ViewerDevice } from './platform';

export type Platform = 'android' | 'ios';

export interface VersionOut {
  id: string;
  version_name: string;
  build: string;
  notes: string;
  size: number;
  uploaded_at: string;
  uploaded_by_name: string;
  is_current: boolean;
}

/** `failed` is registering the device; `build_failed` is preparing the app. */
export type IosStateName =
  'not_set_up' | 'register_first' | 'registering' | 'failed' | 'disabled' | 'preparing'
  | 'build_failed' | 'ready';

export interface IosState {
  state: IosStateName;
  message: string;
  install_url?: string;
  /** failed and build_failed: another try is coming by itself. */
  retrying?: boolean;
}

export interface AppOut {
  id: string;
  platform: Platform;
  identifier: string;
  name: string;
  icon_url: string | null;
  current: VersionOut | null;
  ios_state: IosState | null;
}

export interface AppDetail extends AppOut {
  versions: VersionOut[];
}

/** The saved Apple settings, minus every secret (the API never returns the
 *  .p8 key, the .p12 or its password). */
export interface AppleOut {
  configured: boolean;
  team_id: string | null;
  key_id: string | null;
  issuer_id: string | null;
  cert_name: string | null;
  cert_expires_at: string | null;
  profiles: { app_name: string; expires_at: string }[];
  ios_owner_url: string | null;
}

export type DeviceStatus = 'pending' | 'registered' | 'failed' | 'disabled';

/** An added iPhone (never its UDID). */
export interface DeviceOut {
  id: string;
  name: string;
  product: string;
  os_version: string;
  added_by_name: string;
  added_at: string;
  status: DeviceStatus;
  error: string | null;
}

/** How many devices of one class (IPHONE, IPAD, …) the Apple team holds. */
export interface DeviceCount {
  device_class: string;
  count: number;
  synced_at: string;
}

export interface DevicesOut {
  devices: DeviceOut[];
  counts: DeviceCount[];
}

/** Apple settings to save. Team, issuer and key IDs are always sent; a file
 *  or the password left out keeps the saved one. */
export interface AppleSave {
  team_id: string;
  issuer_id: string;
  key_id: string;
  p8: File | null;
  p12: File | null;
  p12_password: string;
}

export interface UploadOut {
  upload_id: string;
  put_url: string;
  headers: Record<string, string>;
}

export interface InspectOut {
  app: { exists: boolean; id?: string; name: string; platform: Platform; identifier: string };
  version_name: string;
  build: string;
  signing_digest?: string | null;
  min_os?: string | null;
  problems: string[];
}

/** An install link to open, or (iOS) the device or the build isn't ready yet. */
export type InstallResult = { url: string } | { state: string; message: string };

export const PLATFORM_LABEL: Record<Platform, string> = { android: 'Android', ios: 'iOS' };

/** "0.1.0 (1)": how a version is named everywhere on the pages. */
export function versionLabel(v: Pick<VersionOut, 'version_name' | 'build'>): string {
  return `${v.version_name} (${v.build})`;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function getJson<T>(path: string): Promise<T> {
  return (await devicesFetch(path)).json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const resp = await devicesFetch(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
  return resp.json() as Promise<T>;
}

/** `device` (an iOS viewer's iPad or iPhone) only words ios_state's messages. */
export function listApps(deviceRef: string | null, device: ViewerDevice | null = null): Promise<AppOut[]> {
  const params = new URLSearchParams();
  if (deviceRef) params.set('device_ref', deviceRef);
  if (device) params.set('device', device.toLowerCase());
  const query = params.toString();
  return getJson(`/api/apps${query ? `?${query}` : ''}`);
}

export function getApp(id: string): Promise<AppDetail> {
  return getJson(`/api/apps/${encodeURIComponent(id)}`);
}

export function getApple(): Promise<AppleOut> {
  return getJson('/api/apple');
}

export async function saveApple(save: AppleSave): Promise<AppleOut> {
  const form = new FormData();
  form.append('team_id', save.team_id);
  form.append('issuer_id', save.issuer_id);
  form.append('key_id', save.key_id);
  if (save.p8) form.append('p8', save.p8);
  if (save.p12) form.append('p12', save.p12);
  if (save.p12_password) form.append('p12_password', save.p12_password);
  // no Content-Type: the browser sets multipart/form-data with its boundary
  return (await devicesFetch('/api/apple', { method: 'PUT', body: form })).json() as Promise<AppleOut>;
}

export async function clearApple(): Promise<void> {
  await devicesFetch('/api/apple', { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ confirm: 'clear' }) });
}

export function listDevices(): Promise<DevicesOut> {
  return getJson('/api/devices');
}

export function disableDevice(deviceId: string): Promise<DeviceOut> {
  return postJson(`/api/devices/${encodeURIComponent(deviceId)}/disable`, {});
}

export function installApp(appId: string, opts: {
  versionId?: string; deviceRef?: string | null; device?: ViewerDevice | null;
}): Promise<InstallResult> {
  const body: Record<string, string> = {};
  if (opts.versionId) body.version_id = opts.versionId;
  if (opts.deviceRef) body.device_ref = opts.deviceRef;
  if (opts.device) body.device = opts.device.toLowerCase();
  return postJson(`/api/apps/${encodeURIComponent(appId)}/install`, body);
}

/** The add-this-device profile link; `device` words the profile. */
export function enrollDevice(deviceName: string, device: ViewerDevice): Promise<{ url: string }> {
  return postJson('/api/enroll', { device_name: deviceName, device: device.toLowerCase() });
}

export function makeCurrent(versionId: string): Promise<VersionOut> {
  return postJson(`/api/versions/${encodeURIComponent(versionId)}/make-current`, {});
}

export function editNotes(versionId: string, notes: string): Promise<VersionOut> {
  return postJson(`/api/versions/${encodeURIComponent(versionId)}`, { notes }, 'PATCH');
}

export async function deleteVersion(versionId: string): Promise<void> {
  await devicesFetch(`/api/versions/${encodeURIComponent(versionId)}`, { method: 'DELETE' });
}

export function createUpload(file: File): Promise<UploadOut> {
  return postJson('/api/uploads', { filename: file.name, size: file.size, content_type: file.type });
}

export function inspectUpload(uploadId: string): Promise<InspectOut> {
  return postJson(`/api/uploads/${encodeURIComponent(uploadId)}/inspect`, {});
}

export async function commitUpload(uploadId: string, notes: string): Promise<void> {
  await postJson(`/api/uploads/${encodeURIComponent(uploadId)}/commit`, { notes });
}

/** The file straight to the bucket through the presigned URL (XHR, for its
 *  upload progress). No bearer: the URL's signature is the credential. */
export function putFile(upload: UploadOut, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', upload.put_url);
    for (const [name, value] of Object.entries(upload.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("The file didn't finish uploading. Try again."));
    };
    xhr.onerror = () => reject(new Error("The file didn't finish uploading. Check the connection and try again."));
    xhr.send(file);
  });
}

/** An error's message for the page: the API's own sentence when it sent one. */
export function errorText(err: unknown): string {
  // an ApiError without the API's sentence carries only its code
  const bare = err instanceof ApiError && err.message === err.code;
  return err instanceof Error && err.message && !bare ? err.message : 'Something went wrong. Try again.';
}
