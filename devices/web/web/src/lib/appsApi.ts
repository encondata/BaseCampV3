/** The devices API calls behind the Apps pages: the catalog, installing,
 *  adding an iPhone, the version actions and uploading. Shapes follow
 *  devices/api routes apps.py, install.py, enroll.py, uploads.py, apple.py. */
import { ApiError } from '@portal/lib/api';

import { devicesFetch } from './devicesApi';

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

export type IosStateName =
  'not_set_up' | 'register_first' | 'registering' | 'failed' | 'disabled' | 'preparing' | 'ready';

export interface IosState {
  state: IosStateName;
  message: string;
  install_url?: string;
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

export interface AppleOut {
  configured: boolean;
  cert_name: string | null;
  cert_expires_at: string | null;
  profiles: { app_name: string; expires_at: string }[];
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

/** An install link to open, or (iOS) the iPhone or the build isn't ready yet. */
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

export function listApps(deviceRef: string | null): Promise<AppOut[]> {
  const query = deviceRef ? `?device_ref=${encodeURIComponent(deviceRef)}` : '';
  return getJson(`/api/apps${query}`);
}

export function getApp(id: string): Promise<AppDetail> {
  return getJson(`/api/apps/${encodeURIComponent(id)}`);
}

export function getApple(): Promise<AppleOut> {
  return getJson('/api/apple');
}

export function installApp(appId: string, opts: { versionId?: string; deviceRef?: string | null }): Promise<InstallResult> {
  const body: Record<string, string> = {};
  if (opts.versionId) body.version_id = opts.versionId;
  if (opts.deviceRef) body.device_ref = opts.deviceRef;
  return postJson(`/api/apps/${encodeURIComponent(appId)}/install`, body);
}

export function enrollIphone(deviceName: string): Promise<{ url: string }> {
  return postJson('/api/enroll', { device_name: deviceName });
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
