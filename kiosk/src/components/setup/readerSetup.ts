/**
 * Shared wording and checks for Kiosk Setup's RFID steps (Select reader,
 * Connect, Pair). The edge answers with stable `detail.code`s; these map
 * them to what the setup screen says.
 */

import { ApiError } from '../../lib/api';

export const BAD_IP_TEXT = 'Enter a valid IPv4 address, like 192.168.1.20.';

export const HOST_UNKNOWN_TEXT = "This laptop's network address isn't known yet. Re-run the install"
  + ' command, or enter the IPs below.';

/** The laptop has fresh addresses, but none on the reader's subnet. */
export const NOT_ON_SUBNET_TEXT = 'Enter the IP address of this laptop that the reader should send to.';

/** Connect and pair change a reader for a setup only the cloud can finish. */
export const EDGE_OFFLINE_TEXT = 'Kiosk Setup needs the cloud — try again when online.';

/** The pair errors that ask for the laptop IP by hand. */
export const LAPTOP_IP_CODES = ['host_network_unknown', 'reader_not_on_subnet'];

const EDGE_UNREACHABLE_TEXT = "Can't reach this laptop's edge service. Try again.";

/** Dotted-quad IPv4, each octet 0–255, no leading zeros. */
export function isIPv4(value: string): boolean {
  const parts = value.trim().split('.');
  return parts.length === 4
    && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : 'network';
}

function readerMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const detail = err.detail as { message?: unknown } | undefined;
  return typeof detail?.message === 'string' && detail.message ? detail.message : null;
}

/** The messages Connect and Pair share. */
function readerErrorText(err: unknown, ip: string): string | null {
  const code = codeOf(err);
  if (code === 'reader_auth_failed') return "Couldn't sign in to this reader.";
  if (code === 'reader_not_iotc') {
    return "This reader isn't in IoT Connector (Local REST) mode — set it in the reader's web console.";
  }
  if (code === 'reader_unreachable') return `Can't reach ${ip}.`;
  if (code === 'reader_error') return readerMessage(err) ?? 'The reader reported an error.';
  if (code === 'bad_ip') return BAD_IP_TEXT;
  if (code === 'edge_offline') return EDGE_OFFLINE_TEXT;
  if (code === 'network') return EDGE_UNREACHABLE_TEXT;
  return null;
}

export function connectErrorText(err: unknown, ip: string): string {
  return readerErrorText(err, ip) ?? `Couldn't connect to this reader (${codeOf(err)}).`;
}

export function pairErrorText(err: unknown, ip: string): string {
  const code = codeOf(err);
  if (code === 'host_network_unknown') return HOST_UNKNOWN_TEXT;
  if (code === 'reader_not_on_subnet') return NOT_ON_SUBNET_TEXT;
  if (code === 'reader_verify_failed') {
    return "The reader didn't keep the new data endpoint. Try again.";
  }
  return readerErrorText(err, ip) ?? `Couldn't pair this reader (${code}).`;
}

export function scanErrorText(err: unknown): string {
  const code = codeOf(err);
  return code === 'network' ? EDGE_UNREACHABLE_TEXT : `Couldn't scan for readers (${code}).`;
}

/** "Radio connected · 2 of 4 antennas connected · up 26 days 01:11:17"
 *  from the reader's /cloud/status body; whatever fields it has. */
export function statusSummary(status: Record<string, unknown> | null | undefined): string {
  if (!status) return '—';
  const parts: string[] = [];
  if (typeof status.radioConnection === 'string') parts.push(`Radio ${status.radioConnection}`);
  const antennas = status.antennas;
  if (antennas && typeof antennas === 'object') {
    const states = Object.values(antennas as Record<string, unknown>);
    if (states.length) {
      const up = states.filter((s) => s === 'connected').length;
      parts.push(`${up} of ${states.length} antennas connected`);
    }
  }
  if (typeof status.uptime === 'string') parts.push(`up ${status.uptime}`);
  return parts.length ? parts.join(' · ') : '—';
}

/** The edge names another kiosk's hold on a reader by its full ZIOTC
 *  connection name, "ServerSherpa Kiosk ABCD (Front desk)"; people read
 *  it as "Kiosk ABCD (Front desk)". */
export function pairedWithName(connectionName: string): string {
  return connectionName.replace(/^ServerSherpa\s+/, '');
}
