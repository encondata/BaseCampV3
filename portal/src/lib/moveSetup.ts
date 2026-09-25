/**
 * Create a move in steps — the wizard's pure helpers: the five steps, the
 * request bodies, the error sentences, and the finish screen's per-row
 * asset summary. Kept out of the components so they unit-test without jsdom.
 */
import type { BulkSummaryResult, BulkSummaryRow } from '../components/bulk/BulkApplySummary';
import {
  ApiError, type ImportJobResults, type MoveSetupCrates, type MoveSetupTrucks, type OrgRef,
  type SiteItem, type StatusValue,
} from './api';
import type { Action } from './access';
import { TAG_ASSIGNMENT_ORDER, type TagCounts } from './bulkContainers';
import { INITIATIVE_ERRORS, initiativePayload, type InitiativeFormState } from './initiatives';
import { IMPORT_ERRORS } from './moveAssetImport';
import { defaultConvention, toWhole, type NamingValue } from './namingConvention';

export const MOVE_SETUP_STEPS = [
  { key: 'move', label: 'Move', title: 'The move',
    description: 'Name the move and pick where it starts and ends. Nothing is created until the last step.' },
  { key: 'assets', label: 'Assets', title: 'From-To assets',
    description: 'Upload the From-To file. It is checked now and imported when the move is created.' },
  { key: 'crates', label: 'Crates', title: 'Crates',
    description: "Name and count the crates for this move. The x's mark the number." },
  { key: 'trucks', label: 'Trucks', title: 'Trucks',
    description: 'Name and count the trucks. Each one runs from the origin to the destination.' },
  { key: 'review', label: 'Review', title: 'Review and create',
    description: 'Check everything, then create the move with its assets, crates, and trucks.' },
] as const;

export type SkippableSection = 'assets' | 'crates' | 'trucks';
/** Shown on a crate or truck step revisited after Skip this step. */
export const SKIPPED_NOTE = 'This step is skipped. Change any field to include it.';
export interface CratesValue extends NamingValue { container_type: string; tags: TagCounts }
export type TrucksValue = NamingValue;

export interface MoveSetupLookups {
  statuses: StatusValue[]; types: StatusValue[]; subTypes: StatusValue[];
  shippingTypes: StatusValue[]; sites: SiteItem[]; clients: OrgRef[]; partners: OrgRef[];
  containerTypes: StatusValue[];
}
export const EMPTY_LOOKUPS: MoveSetupLookups = {
  statuses: [], types: [], subTypes: [], shippingTypes: [], sites: [], clients: [],
  partners: [], containerTypes: [],
};

export function movePayload(form: InitiativeFormState): Record<string, unknown> {
  return { ...initiativePayload(form), initiative_type: 'move' };
}

export function missingMoveFields(form: InitiativeFormState): string | null {
  const missing = [
    !form.name.trim() ? 'a name' : null,
    !form.origin_site_id ? 'an origin site' : null,
    !form.destination_site_id ? 'a destination site' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length === 0) return null;
  const list = missing.length === 1 ? missing[0]
    : missing.length === 2 ? `${missing[0]} and ${missing[1]}`
    : `${missing.slice(0, -1).join(', ')}, and ${missing[missing.length - 1]}`;
  return `The move needs ${list}.`;
}

export function initialCrates(origin?: SiteItem | null, destination?: SiteItem | null): CratesValue {
  return { convention: defaultConvention('CRT', origin?.code, destination?.code),
           count: '0', start: '1', container_type: '', tags: {} };
}
export function initialTrucks(origin?: SiteItem | null, destination?: SiteItem | null): TrucksValue {
  return { convention: defaultConvention('TRK', origin?.code, destination?.code), count: '0', start: '1' };
}

export function cratesBody(value: CratesValue): MoveSetupCrates {
  return {
    convention: value.convention.trim(),
    count: toWhole(value.count) ?? 0,
    start: toWhole(value.start) ?? 0,
    container_type: value.container_type || null,
    tags: Object.fromEntries(TAG_ASSIGNMENT_ORDER.map((key) => [key, value.tags[key] ?? 0])),
  };
}
export function trucksBody(value: TrucksValue): MoveSetupTrucks {
  return { convention: value.convention.trim(), count: toWhole(value.count) ?? 0,
           start: toWhole(value.start) ?? 0 };
}

export const MOVE_SETUP_ERRORS: Record<string, string> = {
  draft_not_found: 'This move setup is gone. It may have expired after a day without changes. Start again.',
  draft_not_editable: 'This move is already being created.',
  setup_invalid: 'Some steps need attention before the move can be created.',
  name_taken: 'Some crate or truck names were taken while the move was being created. Nothing was created. Change the names and try again.',
  apply_conflict: 'Another change landed while the move was being created. Nothing was created. Try again.',
  worker_error: 'Something went wrong while creating the move. Nothing was created. Try again.',
  forbidden: 'You need permission to add moves, containers, and trucks to use this tool.',
  name_required: 'The move needs a name.',
  origin_required: 'Pick an origin site.',
  destination_required: 'Pick a destination site.',
  invalid_naming: 'Check the naming convention.',
  bad_container_type: 'Pick a crate type from the list.',
  bad_tag_key: 'Pick label tags from the list.',
  tags_exceed_count: "Label tag counts can't add up to more than the crate count.",
  no_asset_file: 'Upload a From-To file first.',
  // GET /bulk/move-setup/{id}/assets when the draft holds no check job
  no_asset_check: 'Upload a From-To file first.',
  // the type is locked to Move here, so "pick a type" (INITIATIVE_ERRORS) can't help
  unknown_initiative_type: "Moves can't be created because the Move type is missing.",
};

/** Every permission the /bulk/move-setup routes require (beside admin rank);
 *  the Bulk Actions card and the page both check all of them. */
export const MOVE_SETUP_PERMISSIONS: readonly (readonly [string, Action])[] = [
  ['initiatives', 'add'], ['containers', 'add'], ['trucks', 'add'],
];
export const MOVE_SETUP_NO_ACCESS =
  'You need permission to add initiatives, containers, and trucks to create a move here.';

export function moveSetupError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Network error. Try again.';
  if (err.code === 'invalid_naming') {
    const message = (err.detail as { message?: string } | undefined)?.message;
    if (message) return message;
  }
  return MOVE_SETUP_ERRORS[err.code] ?? INITIATIVE_ERRORS[err.code] ?? IMPORT_ERRORS[err.code]
    ?? 'Something went wrong. Try again.';
}

/** The reasons a 422 setup_invalid lists, as sentences. */
export function setupReasons(err: unknown): string[] {
  if (!(err instanceof ApiError) || err.code !== 'setup_invalid') return [];
  return (err.detail as { reasons?: string[] } | undefined)?.reasons ?? [];
}

export interface MoveAssetSummaryRow extends BulkSummaryRow { asset_id: string | null; message: string }

/** The From-To import's details as BulkApplySummary rows: created → Added,
 *  updated → Updated, review/error → Skipped (they were not imported). */
export function assetSummary(results: ImportJobResults): BulkSummaryResult<MoveAssetSummaryRow> {
  const rows = results.details.map((d): MoveAssetSummaryRow => ({
    row: d.row, name: d.serial_number || null,
    action: d.status === 'created' ? 'created' : d.status === 'updated' ? 'updated' : 'skipped',
    diff: null, asset_id: d.asset_id ?? null, message: d.message,
  }));
  const n = (action: MoveAssetSummaryRow['action']) => rows.filter((r) => r.action === action).length;
  return { created: n('created'), updated: n('updated'), skipped: n('skipped'), unchanged: 0, rows };
}

export const createdCount = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'} created`;

export function moveSummaryRows(form: InitiativeFormState, lookups: MoveSetupLookups): [string, string][] {
  const named = (list: { id: string; name: string }[], id: string) =>
    list.find((x) => x.id === id)?.name ?? '';
  const label = (list: StatusValue[], key: string) => list.find((s) => s.key === key)?.label ?? key;
  const dates = [form.scheduled_start, form.scheduled_end].filter(Boolean).join(' to ');
  return [
    ['Name', form.name.trim()],
    ['Status', label(lookups.statuses, form.status)],
    ['Client', named(lookups.clients, form.client_id) || '—'],
    ['Scheduled', dates || '—'],
    ['Origin', named(lookups.sites, form.origin_site_id) || '—'],
    ['Destination', named(lookups.sites, form.destination_site_id) || '—'],
    ['Shipping types', form.shipping_types.map((k) => label(lookups.shippingTypes, k)).join(', ') || '—'],
  ];
}
