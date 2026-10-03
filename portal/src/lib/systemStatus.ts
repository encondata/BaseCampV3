/** Public portal status (no auth): read-only maintenance mode + broadcast
 *  banner. Fetched with plain fetch — the login page shows banners before
 *  anyone has a token. */
import { apiUrl } from './api';

export interface SystemStatus {
  read_only: boolean;
  read_only_message: string;
  workers_paused: boolean;
  banner: string | null;
  totp_trust_days: number;
  email_enabled: boolean;
  password_reset_ttl_minutes: number;
  password_min_length: number;
}

export const DEFAULT_SYSTEM_STATUS: SystemStatus = {
  read_only: false, read_only_message: '', workers_paused: false, banner: null, totp_trust_days: 7,
  email_enabled: false, password_reset_ttl_minutes: 15, password_min_length: 8,
};

export async function getSystemStatus(): Promise<SystemStatus> {
  const resp = await fetch(`${apiUrl()}/system/status`);
  if (!resp.ok) throw new Error(`system status ${resp.status}`);
  return resp.json();
}
