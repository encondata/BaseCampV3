/** Seed Data endpoints (/api/seed): browsing a snapshot in the scratch
 *  database, resolving the rows a selection needs, and recipes. */
import { ApiError } from '@portal/lib/api';

import { errorText, getJson, sendJson } from '../../lib/sirdarApi';

import type { PkObject, SelectionBody } from './selection';

export type ScratchStatus = 'absent' | 'restoring' | 'ready' | 'failed';
export interface SeedTable { table: string; rows: number; pk: string[] | null; file_columns: string[] }
export interface SeedRow { pk: PkObject | null; values: Record<string, string | number | null> }
export interface RowsPage { columns: { name: string; type: string }[]; rows: SeedRow[]; total: number }
export interface RowsQuery {
  page: number; size: number; sort?: string; dir?: 'asc' | 'desc'; filter_col?: string; filter?: string;
}
export interface KeyFilter { filter_col: string; filter: string }
export interface Reason {
  table: string; pk: PkObject; label: string;
  needed_by_table: string; needed_by_pk: PkObject | null; needed_by_label: string | null;
}
export interface Resolved {
  added: Record<string, PkObject[]>;
  reasons: Reason[];
  missing: Record<string, PkObject[]>;
  added_tables: { table: string; needed_by_table: string; via_columns: string[] }[];
  missing_tables: string[];
}
export interface RecipeSummary {
  id: string; name: string; notes: string; tables: number; rows: number; files: number; updated_at: string;
}
export interface Recipe { id: string; name: string; notes: string; tables: SelectionBody; files: Record<string, boolean> }
export interface RecipeBody { name?: string; notes?: string; tables: SelectionBody; files: Record<string, boolean> }

const snap = (id: string) => `/seed/snapshots/${encodeURIComponent(id)}`;
const tbl = (id: string, table: string) => `${snap(id)}/tables/${encodeURIComponent(table)}`;

export const openSnapshot = (id: string) => sendJson<{ status: ScratchStatus }>('POST', `${snap(id)}/open`);
export const snapshotStatus = (id: string) => getJson<{ status: ScratchStatus }>(snap(id));
export const listTables = (id: string) => getJson<SeedTable[]>(`${snap(id)}/tables`);

export function getRows(id: string, table: string, q: RowsQuery) {
  const p = new URLSearchParams({ page: String(q.page), size: String(q.size) });
  if (q.sort) { p.set('sort', q.sort); p.set('dir', q.dir ?? 'asc'); }
  if (q.filter_col && q.filter) { p.set('filter_col', q.filter_col); p.set('filter', q.filter); }
  return getJson<RowsPage>(`${tbl(id, table)}/rows?${p.toString()}`);
}

export function getKeys(id: string, table: string, f: KeyFilter) {
  const p = new URLSearchParams();
  if (f.filter_col && f.filter) { p.set('filter_col', f.filter_col); p.set('filter', f.filter); }
  const qs = p.toString();
  return getJson<{ pks: PkObject[]; total: number }>(`${tbl(id, table)}/keys${qs ? `?${qs}` : ''}`);
}

export const resolveSelection = (id: string, tables: SelectionBody) =>
  sendJson<Resolved>('POST', `${snap(id)}/resolve`, { tables });

/** `reference`: the phrase for the kept row that references the file
 *  ("Avatar of Person A (people)"), even when it's unticked by hand; null
 *  when no kept row does. */
export interface SeedFile { key: string; size: number; kept: boolean; because: string; reference: string | null }
export interface FilesPage { files: SeedFile[]; total: number }
export interface FilesQuery { page: number; size: number; filter?: string }

/** The snapshot's files, a page at a time, kept or not under the saved
 *  recipe `recipeId`, with why ("Kept because"). */
export function listFiles(id: string, recipeId: string, q: FilesQuery) {
  const p = new URLSearchParams({ recipe_id: recipeId, page: String(q.page), size: String(q.size) });
  if (q.filter) p.set('filter', q.filter);
  return getJson<FilesPage>(`${snap(id)}/files?${p.toString()}`);
}

export const listRecipes = () => getJson<RecipeSummary[]>('/seed/recipes');
export const getRecipe = (id: string) => getJson<Recipe>(`/seed/recipes/${encodeURIComponent(id)}`);
export const createRecipe = (name: string) => sendJson<Recipe>('POST', '/seed/recipes', { name });
/** PUT replaces the recipe: send its files too, or they're cleared. */
export const putRecipe = (id: string, body: RecipeBody) =>
  sendJson<Recipe>('PUT', `/seed/recipes/${encodeURIComponent(id)}`, body);

const SEED_MESSAGES: Record<string, string> = {
  scratch_not_configured: "Seed Data needs its scratch database, and SIRDAR_SCRATCH_URL isn't set.",
  scratch_unavailable: "Sirdar can't reach its scratch database right now.",
  restore_failed: "This snapshot's database couldn't be opened for browsing.",
  no_primary_key: 'That table has no primary key, so its rows can only be kept all together.',
  table_not_found: "That table isn't in this snapshot.",
  column_not_found: "That column isn't in this table.",
  column_not_sortable: "That column can't be sorted.",
  filter_col_required: 'Pick a column to filter on.',
  bad_filter: "That filter can't be used.",
  bad_pk: "A ticked row's key doesn't match this table's primary key.",
  recipe_name_required: 'Enter a recipe name.',
  recipe_name_invalid: 'Use printable characters only in the recipe name.',
  recipe_name_taken: 'Another recipe already has that name.',
  recipe_not_found: 'That recipe no longer exists.',
  forbidden: "You don't have access to do that.",
};

export function seedErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && SEED_MESSAGES[err.code]) return SEED_MESSAGES[err.code];
  return errorText(err, fallback);
}

/** A browse call answered 409 snapshot_not_open (the scratch copy was
 *  dropped or is still restoring): open it again and wait. */
export const notOpen = (err: unknown) => err instanceof ApiError && err.code === 'snapshot_not_open';
