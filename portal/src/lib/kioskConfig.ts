/** The kiosk settings document as the portal's kiosk details page sees it
 *  (spec docs/superpowers/specs/2026-10-17-kiosk-config-in-portal-design.md
 *  §3). DEFAULT_CONFIG mirrors api/src/serversherpa/services/kiosk_config.py
 *  exactly; the server validates every edit, so these helpers only shape
 *  what the page shows and sends. */

import type { DeviceConfigHistoryItem, DeviceDetail, KioskConfigDoc } from './api';
import { ageText } from './format';

export interface Hsl { h: number; s: number; l: number }

export type SoundRef =
  | { kind: 'none' }
  | { kind: 'builtin'; id: string }
  | { kind: 'upload'; id: string }
  | { kind: 'siren' };

export interface AppearanceSection {
  good_scan: Hsl; not_found_scan: Hsl; duplicate_scan: Hsl; flash_ms: number;
  [extra: string]: unknown;
}
export interface SoundSection {
  good: SoundRef; not_found: SoundRef; duplicate: SoundRef; alarm: SoundRef; volume: number;
  [extra: string]: unknown;
}
export interface CheckpointsSection {
  enroll: string; container_pack: string; container_unpack: string;
  truck_load: string; truck_unload: string;
  [extra: string]: unknown;
}
export interface DeveloperSection { dev_mode: boolean; [extra: string]: unknown }
export interface AlarmSection {
  mode: 'until_dismissed' | 'timed'; timed_seconds: number;
  [extra: string]: unknown;
}

export interface KioskConfig {
  schema: number;
  appearance: AppearanceSection;
  sound: SoundSection;
  checkpoints: CheckpointsSection;
  developer: DeveloperSection;
  alarm: AlarmSection;
  [section: string]: unknown;
}

/** The Label Station's settings, reported by the laptop's edge. Read-only on
 *  the portal: it isn't in SectionKey, so no editor exists for it, and
 *  withSection carries it through every other edit untouched. The edge sends
 *  an explicit null when it has none. */
export interface LabelStationSection {
  label_kind: 'top' | 'front';
  printer: { type: 'usb' | 'network'; ip: string | null; model: string | null; serial: string | null };
  dpi: number;
  offset_x: number;
  offset_y: number;
  /** Prints peel-off (the station found a peeler). Absent from laptops
   *  that predate the peeler check: tear off. */
  peel?: boolean;
}

/** config.label_station when the kiosk reported one; null (card hidden) for
 *  an absent, null or malformed section. */
export function labelStationOf(config: { [section: string]: unknown }): LabelStationSection | null {
  const v = config.label_station;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = (v as { printer?: unknown }).printer;
  if (!p || typeof p !== 'object') return null;
  return v as LabelStationSection;
}

export const DEFAULT_CONFIG: KioskConfig = {
  schema: 1,
  appearance: {
    good_scan: { h: 150, s: 60, l: 45 },
    not_found_scan: { h: 0, s: 70, l: 50 },
    duplicate_scan: { h: 38, s: 92, l: 50 },
    flash_ms: 350,
  },
  sound: {
    good: { kind: 'builtin', id: 'chime' },
    not_found: { kind: 'builtin', id: 'buzz' },
    duplicate: { kind: 'builtin', id: 'double_beep' },
    alarm: { kind: 'siren' },
    volume: 0.8,
  },
  checkpoints: {
    enroll: 'pre_stage',
    container_pack: 'in_container',
    container_unpack: 'un_pack',
    truck_load: 'on_truck',
    truck_unload: 'received',
  },
  developer: { dev_mode: false },
  alarm: { mode: 'until_dismissed', timed_seconds: 10 },
};

export const FLASH_MS_MIN = 100;
export const FLASH_MS_MAX = 2000;
export const ALARM_SECONDS_MIN = 3;
export const ALARM_SECONDS_MAX = 600;

/** The kiosk's own built-in sounds (kiosk/src/lib/sound.ts), in its order. */
export const BUILTIN_SOUNDS: { id: string; label: string }[] = [
  { id: 'chime', label: 'Chime' },
  { id: 'beep', label: 'Beep' },
  { id: 'double_beep', label: 'Double beep' },
  { id: 'buzz', label: 'Buzz' },
  { id: 'bonk', label: 'Bonk' },
];

export type SectionKey =
  'appearance' | 'sound' | 'checkpoints' | 'developer' | 'alarm' | 'android_rfid' | 'ios';

export const SECTION_TITLES: Record<SectionKey, string> = {
  appearance: 'Appearance',
  sound: 'Sound',
  checkpoints: 'Checkpoints',
  developer: 'Developer',
  alarm: 'Off-move alarm',
  android_rfid: 'RFID sled',
  ios: 'iOS camera',
};

/** The five checkpoints, labeled as the kiosk's Settings › Admin rows. */
export type CheckpointKey =
  'enroll' | 'container_pack' | 'container_unpack' | 'truck_load' | 'truck_unload';

export const CHECKPOINTS: { key: CheckpointKey; label: string }[] = [
  { key: 'enroll', label: 'RFID Enroll' },
  { key: 'container_pack', label: 'Container pack' },
  { key: 'container_unpack', label: 'Container unpack' },
  { key: 'truck_load', label: 'Truck load' },
  { key: 'truck_unload', label: 'Truck unload' },
];

/** Field labels for the History list (`section.field` keys). */
const FIELD_LABELS: Record<string, string> = {
  'appearance.good_scan': 'Good scan flash',
  'appearance.not_found_scan': 'Not-found flash',
  'appearance.duplicate_scan': 'Duplicate flash',
  'appearance.flash_ms': 'Flash length',
  'sound.good': 'Good scan sound',
  'sound.not_found': 'Not-found sound',
  'sound.duplicate': 'Duplicate sound',
  'sound.alarm': 'Alarm sound',
  'sound.volume': 'Volume',
  'developer.dev_mode': 'Developer mode',
  'alarm.mode': 'Mode',
  'alarm.timed_seconds': 'Alarm length',
  ...Object.fromEntries(CHECKPOINTS.map((c) => [`checkpoints.${c.key}`, c.label])),
};

/** "Appearance › Flash length" for a known key; the raw key otherwise. */
export function fieldLabel(key: string): string {
  const [section] = key.split('.', 1);
  const title = SECTION_TITLES[section as SectionKey];
  const field = FIELD_LABELS[key];
  if (title && field) return `${title} › ${field}`;
  return key;
}

const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** What the page edits from: the stored document, or the defaults when the
 *  kiosk hasn't reported yet (the portal starts from the defaults, spec §4). */
export function configFor(stored: KioskConfigDoc | null): KioskConfig {
  return deepClone((stored ?? DEFAULT_CONFIG) as KioskConfig);
}

/** One section to show: the stored one, else its default. */
export function sectionOf<K extends keyof KioskConfig & string>(
  config: KioskConfig, key: K,
): KioskConfig[K] {
  const v = config[key];
  return (v && typeof v === 'object' ? v : DEFAULT_CONFIG[key]) as KioskConfig[K];
}

/** The whole document with only `section` replaced — everything else,
 *  unknown and other-platform sections included, goes back untouched. */
export function withSection(
  base: KioskConfigDoc, section: string, value: unknown,
): KioskConfigDoc {
  return { ...deepClone(base), [section]: deepClone(value) };
}

type PlatformBits = Pick<DeviceDetail, 'sub_type' | 'station_type'>;

export const isRfidStation = (d: PlatformBits) => d.sub_type === 'laptop' && d.station_type === 'rfid';
export const isAndroid = (d: PlatformBits) => d.sub_type === 'android' || d.sub_type === 'zebra';
export const isIos = (d: PlatformBits) => d.sub_type === 'ios';

/** The settings sections that apply to this kiosk (spec §3's last column). */
export function applicableSections(d: PlatformBits): SectionKey[] {
  const out: SectionKey[] = ['appearance', 'sound', 'checkpoints', 'developer'];
  if (isRfidStation(d)) out.push('alarm');
  if (isAndroid(d)) out.push('android_rfid');
  if (isIos(d)) out.push('ios');
  return out;
}

/** Android and iOS sync in later phases (spec §7): until one of their kiosks
 *  has reported a config, the page can't edit it. Web, laptop and Pi kiosks
 *  can be edited before their first report; the portal starts from the
 *  defaults and the kiosk takes the edit at its first check-in. */
export function platformCanSync(d: Pick<DeviceDetail, 'sub_type' | 'station_type' | 'config_reported_at'>): boolean {
  if (isAndroid(d) || isIos(d)) return d.config_reported_at != null;
  return true;
}

/** "5 minutes ago", or "just now". */
export function agoText(iso: string | null, nowMs: number = Date.now()): string {
  const age = ageText(iso, nowMs);
  return age === 'just now' || age === 'never' ? age : `${age} ago`;
}

export function syncLine(
  d: Pick<DeviceDetail, 'sync_state' | 'config_changed_at'>, nowMs: number = Date.now(),
): string {
  if (d.sync_state === 'in_sync') return 'In sync';
  if (d.sync_state === 'pending') {
    return d.config_changed_at
      ? `Pending on kiosk · ${ageText(d.config_changed_at, nowMs)}` : 'Pending on kiosk';
  }
  if (d.sync_state === 'waiting_first_report') return 'Waiting for first report';
  return '—';
}

/** GET /devices/{id}/config/history's default page size. */
export const HISTORY_LIMIT = 200;

/** The newest recorded change that touched `section`. */
export function lastSectionChange(
  section: string, history: DeviceConfigHistoryItem[],
): DeviceConfigHistoryItem | null {
  const prefix = `${section}.`;
  return history.find((h) => Object.keys(h.changes ?? {}).some(
    (k) => k === section || k.startsWith(prefix))) ?? null;
}

/** "changed on the portal by Jimmy · 2 hours ago" / "changed on the kiosk · 1 day ago". */
export function sectionSource(
  section: string, history: DeviceConfigHistoryItem[], nowMs: number = Date.now(),
): string {
  const h = lastSectionChange(section, history);
  if (!h) {
    // the history route returns at most HISTORY_LIMIT rows: a full page that
    // never touches this section says nothing about older changes
    return history.length >= HISTORY_LIMIT
      ? `Unchanged in the last ${HISTORY_LIMIT} changes` : 'No changes recorded';
  }
  const where = h.source === 'portal' ? 'on the portal' : h.source === 'kiosk' ? 'on the kiosk' : '';
  const by = h.by_name ? ` by ${h.by_name}` : '';
  return `changed${where ? ` ${where}` : ''}${by} · ${agoText(h.at, nowMs)}`;
}

export function soundLabel(ref: SoundRef | null | undefined, sounds: { id: string; name: string }[]): string {
  if (!ref || typeof ref !== 'object') return '—';
  switch (ref.kind) {
    case 'none': return 'None';
    case 'siren': return 'Siren';
    case 'builtin': return BUILTIN_SOUNDS.find((s) => s.id === ref.id)?.label ?? ref.id;
    case 'upload': return sounds.find((s) => s.id === ref.id)?.name ?? 'Uploaded sound (missing)';
    default: return '—';
  }
}

/** ComboBox value <-> SoundRef. */
export function soundValue(ref: SoundRef): string {
  if (ref.kind === 'builtin' || ref.kind === 'upload') return `${ref.kind}:${ref.id}`;
  return ref.kind;
}

export function soundFromValue(v: string): SoundRef {
  if (v === 'none') return { kind: 'none' };
  if (v === 'siren') return { kind: 'siren' };
  const i = v.indexOf(':');
  const kind = v.slice(0, i);
  const id = v.slice(i + 1);
  return kind === 'upload' ? { kind: 'upload', id } : { kind: 'builtin', id };
}

export const hslCss = (c: Hsl) => `hsl(${c.h} ${c.s}% ${c.l}%)`;

const isHsl = (v: unknown): v is Hsl => !!v && typeof v === 'object'
  && ['h', 's', 'l'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number');

/** A History value as text: colors as hsl(), sound refs by name. */
export function valueText(v: unknown, sounds: { id: string; name: string }[] = []): string {
  if (v === null || v === undefined) return '—';
  if (isHsl(v)) return hslCss(v);
  if (typeof v === 'object' && 'kind' in (v as object)) return soundLabel(v as SoundRef, sounds);
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Kiosks check in every minute; three missed beats reads as offline. */
export const KIOSK_ONLINE_MS = 3 * 60 * 1000;

export function kioskOnline(lastSeen: string | null, nowMs: number = Date.now()): boolean {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  return !Number.isNaN(t) && nowMs - t <= KIOSK_ONLINE_MS;
}
