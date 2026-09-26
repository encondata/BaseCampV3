/** The `/wiki` API's shapes, mirrored from
 *  api/src/serversherpa/api/routes/wiki/schemas.py. Ids are uuid strings;
 *  datetimes are ISO strings. */
import type { JSONContent } from '@tiptap/core';

export type Level = 'view' | 'edit' | 'manage';
export type PrincipalType =
  'everyone' | 'internal' | 'role' | 'access_group' | 'person' | 'client' | 'partner';
export type NodeKind = 'folder' | 'page' | 'file';
export type VersionKind = 'autosave' | 'published' | 'restored' | 'imported';
export type PreviewKind = 'native' | 'pdf' | 'none';

export interface PersonRef {
  id: string;
  name: string;
}

export interface MeOut {
  person: PersonRef;
  is_admin: boolean;
  can_create_spaces: boolean;
}

// ── spaces ────────────────────────────────────────────────────────────

export interface SpaceOut {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  home_node_id: string | null;
  archived_at: string | null;
  my_level: Level | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SpaceCreateIn {
  key: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  default_access: 'internal' | 'everyone' | 'private';
}

export interface SpacePatchIn {
  name?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  settings?: Record<string, unknown> | null;
}

// ── grants / principals ─────────────────────────────────────────────

export interface GrantIn {
  principal_type: PrincipalType;
  principal_id: string | null;
  level: Level;
}

export interface GrantOut extends GrantIn {
  id: string;
  principal_label: string;
  node_id: string | null;
}

export interface GrantsOut {
  grants: GrantOut[];
}

export interface EffectiveGrant extends GrantIn {
  principal_label: string;
  source: { kind: 'space' | 'node'; node_id: string | null; title: string | null };
}

export interface PrincipalOut {
  type: PrincipalType;
  id: string | null;
  label: string;
}

export interface NodePermissionsOut {
  inherit: boolean;
  grants: GrantOut[];
  effective: EffectiveGrant[];
}

export interface NodePermissionsPutIn {
  inherit: boolean;
  /** Omitted while turning inherit off copies the effective set. */
  grants?: GrantIn[];
}

// ── nodes ─────────────────────────────────────────────────────────────

export interface FileVersionOut {
  id: string;
  version_no: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  preview_kind: PreviewKind;
  preview_status: string;
  extract_status: string;
  note: string | null;
  uploaded_by: PersonRef | null;
  created_at: string;
}

export interface NodePageOut {
  is_home: boolean;
  published_version_id: string | null;
  published_at: string | null;
  has_unpublished_changes: boolean;
}

export interface NodeFileOut {
  description: string;
  current_version: FileVersionOut | null;
}

export interface NodeOut {
  id: string;
  space_id: string;
  space_key: string;
  parent_id: string | null;
  kind: NodeKind;
  title: string;
  position: number;
  inherit_permissions: boolean;
  owner: PersonRef | null;
  created_at: string;
  updated_at: string;
  updated_by: PersonRef | null;
  my_level: Level | null;
  has_children: boolean;
  is_favorite: boolean;
  page: NodePageOut | null;
  file: NodeFileOut | null;
}

/** An ancestor the caller can't view comes back as `{id: null, title: "…"}`. */
export interface Breadcrumb {
  id: string | null;
  title: string;
  kind: NodeKind;
}

export interface NodeDetailOut extends NodeOut {
  breadcrumbs: Breadcrumb[];
  space: SpaceOut;
}

export interface NodeCreateIn {
  space_id: string;
  parent_id: string | null;
  kind: 'folder' | 'page';
  title: string;
  initial_content?: JSONContent;
  after_id?: string;
}

export interface NodePatchIn {
  title?: string;
  owner_id?: string;
}

/** Give `before_id` or `after_id`, not both. */
export interface NodeMoveIn {
  parent_id: string | null;
  space_id?: string;
  before_id?: string;
  after_id?: string;
}

export interface NodeCopyIn {
  parent_id: string | null;
  space_id?: string;
}

export interface NodeDeleteOut {
  batch_id: string;
  count: number;
}

// ── pages / versions ────────────────────────────────────────────────

export interface VersionOut {
  id: string;
  version_no: number;
  kind: VersionKind;
  title: string;
  note: string | null;
  created_by: PersonRef | null;
  created_at: string;
}

export interface VersionDetail extends VersionOut {
  content_json: JSONContent;
}

/** `published` (default), `draft`, or a version id. */
export type ContentVersion = 'published' | 'draft' | (string & {});

/** One readable state of a page: a version, or the live draft (`kind`
 *  "draft", no version id/number). */
export interface PageContentOut {
  version_id: string | null;
  version_no: number | null;
  kind: 'draft' | VersionKind;
  title: string;
  content_json: JSONContent;
  created_at: string | null;
  created_by: PersonRef | null;
}

// ── uploads / files / assets ────────────────────────────────────────

export type UploadTarget = 'node' | 'version' | 'asset';

export interface UploadStartIn {
  target: UploadTarget;
  space_id?: string;
  parent_id?: string | null;
  node_id?: string;
  page_id?: string;
  filename: string;
  content_type: string;
  size: number;
}

/** PUT the file to `url` sending exactly `headers` (Content-Length is
 *  signed, so the body must be the file as-is). */
export interface UploadStartOut {
  upload_id: string;
  url: string;
  headers: Record<string, string>;
}

export interface AssetOut {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface FileUrlOut {
  url: string | null;
  content_type: string;
  preview_status: string;
}

export interface FileUrlParams {
  version_id?: string;
  disposition?: 'inline' | 'attachment';
  preview?: boolean;
}

export interface AssetUrlsOut {
  urls: Record<string, string>;
}

// ── search / trash ──────────────────────────────────────────────────

export interface SearchHit {
  node: { id: string; kind: NodeKind; title: string; space_key: string; space_name: string };
  snippet_html: string;
  breadcrumbs: string[];
}

export interface SearchParams {
  q: string;
  space?: string;
  kind?: NodeKind;
  limit?: number;
}

export interface TrashBatch {
  batch_id: string;
  root: { id: string; title: string; kind: NodeKind };
  count: number;
  deleted_by: PersonRef | null;
  deleted_at: string;
  purge_at: string | null;
}

// ── watches ─────────────────────────────────────────────────────────

/** A watch: `node` is null for a space watch; `space` is the watched
 *  space, or the watched node's space. */
export interface WatchOut {
  id: string;
  node: { id: string; title: string; kind: NodeKind } | null;
  space: { key: string; name: string } | null;
  created_at: string;
}

/** Exactly one of the two. */
export type WatchIn = { node_id: string; space_id?: never } | { space_id: string; node_id?: never };

export type WatchVia = 'node' | 'ancestor' | 'space';

/** How the caller watches a node — the closest watch wins; `watch_id`
 *  is that watch, for unwatching it. */
export interface WatchStateOut {
  watching: boolean;
  via: WatchVia | null;
  watch_id: string | null;
}
