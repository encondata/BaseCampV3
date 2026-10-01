/** The `/wiki` API's shapes, mirrored from
 *  api/src/serversherpa/api/routes/wiki/schemas.py. Ids are uuid strings;
 *  datetimes are ISO strings. */
import type { JSONContent } from '@tiptap/core';

export type Level = 'view' | 'edit' | 'manage';
export type PrincipalType =
  'everyone' | 'internal' | 'role' | 'access_group' | 'person' | 'client' | 'partner';
export type NodeKind = 'folder' | 'page' | 'file';
export type VersionKind = 'autosave' | 'published' | 'restored' | 'imported' | 'submitted';
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

// ── spaces (people see them as "libraries" — see lib/paths) ─────────

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
  /** One of the five document types (shown on an exported PDF's cover), or null. */
  doc_type: string | null;
}

/** Where a page stands in its review cycle: `overdue` once
 *  `next_review_at` has passed, `due_soon` within 14 days, else `ok`. */
export type ReviewState = 'ok' | 'due_soon' | 'overdue';

/** A page's review cycle. `interval_months` is the interval in effect:
 *  `own_interval_months` (the page's own; null = inherit), else its
 *  space's. `state` is null when there's no interval or nothing is
 *  scheduled yet. `pending_review_id` is shown to editors only. */
export interface NodeReviewOut {
  interval_months: number | null;
  own_interval_months: number | null;
  next_review_at: string | null;
  last_reviewed_at: string | null;
  state: ReviewState | null;
  pending_review_id: string | null;
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
  /** Pages only (null for folders and files). */
  review: NodeReviewOut | null;
  /** Only its author and developers can see a private item (and only they
   *  can change this: `can_set_private`). */
  is_private: boolean;
  /** The item or a folder above it is private — what the lock, the chip and
   *  the hidden Share/template/help items go by (`is_private` is only the
   *  item's own switch). */
  in_private: boolean;
  /** The node's own printing setting; null = it inherits. `can_print` is
   *  what applies to the caller; `printing_from` says where an inherited
   *  value comes from (`node_id` null = the library's setting, or a source
   *  the caller can't see). */
  allow_printing: boolean | null;
  can_print: boolean;
  printing_from: PrintingSource | null;
  can_set_private: boolean;
}

export interface PrintingSource {
  node_id: string | null;
  title: string;
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

/** `title` is required unless `template_id` is given, in which case an
 *  omitted or blank title defaults to the template's name. */
export interface NodeCreateIn {
  space_id: string;
  parent_id: string | null;
  kind: 'folder' | 'page';
  title?: string;
  initial_content?: JSONContent;
  template_id?: string;
  after_id?: string;
}

/** `review_interval_months` (pages, manage): 1-60, or null to clear the
 *  page's own interval (back to the space's); omit it to leave it alone. */
export interface NodePatchIn {
  title?: string;
  owner_id?: string;
  review_interval_months?: number | null;
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
  /** false: don't record this search in the analytics log (live results
   *  while typing). */
  log?: boolean;
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

// ── comments ────────────────────────────────────────────────────────

/** A comment body: plain text (1-5000 characters) plus the people it
 *  @mentions — never HTML. Sent as ids, returned as current names. */
export interface CommentBodyIn {
  text: string;
  mentions: string[];
}

/** A new thread (no `thread_id`; `anchor` for an inline one), or a reply
 *  to thread `thread_id`. */
export interface CommentIn {
  body: CommentBodyIn;
  thread_id?: string;
  anchor?: boolean;
}

/** A deleted comment keeps its place with `deleted` set and its text
 *  replaced by "Comment deleted". */
export interface CommentOut {
  id: string;
  thread_id: string;
  parent_id: string | null;
  body: { text: string; mentions: PersonRef[] };
  author: PersonRef | null;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
}

/** A comment thread, oldest comment first. `anchor` = inline: a
 *  `commentThread` mark in the page carries `thread_id` (the mark may
 *  be gone — an orphaned thread). */
export interface CommentThread {
  thread_id: string;
  anchor: boolean;
  resolved_at: string | null;
  resolved_by: PersonRef | null;
  comments: CommentOut[];
}

// ── templates ────────────────────────────────────────────────────────

/** A page starting point: `space_id` null is global (a builtin, or one a
 *  wiki admin added); otherwise scoped to that space. */
export interface TemplateOut {
  id: string;
  space_id: string | null;
  space_key: string | null;
  name: string;
  description: string;
  icon: string;
  is_builtin: boolean;
  created_by: PersonRef | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateDetail extends TemplateOut {
  content_json: JSONContent;
}

/** Give exactly one of `content_json` or `from_node_id` (that page's
 *  current draft, or its published content for a view-only caller). */
export type TemplateCreateIn =
  { space_id?: string | null; name: string; description?: string; icon?: string }
  & ({ content_json: JSONContent; from_node_id?: never }
    | { from_node_id: string; content_json?: never });

export interface TemplatePatchIn {
  name?: string;
  description?: string;
  icon?: string;
  content_json?: JSONContent;
}

// ── reviews ─────────────────────────────────────────────────────────

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** A review request; `version_id` is the submitted snapshot. */
export interface ReviewOut {
  id: string;
  node: { id: string; title: string; space_key: string; space_name: string };
  version_id: string;
  status: ReviewStatus;
  note: string;
  requested_by: PersonRef | null;
  created_at: string;
  decided_by: PersonRef | null;
  decided_at: string | null;
  decision_note: string;
}

/** A review with both sides of its diff: the submitted snapshot and the
 *  page's published content now (null if never published). */
export interface ReviewDetail extends ReviewOut {
  submitted_version_no: number;
  submitted_content: JSONContent;
  published_version_id: string | null;
  published_content: JSONContent | null;
  /** The page was published after this was submitted: approving would
   *  replace content the submitter never saw. */
  stale: boolean;
}

/** `approver`: reviews of pages I manage; `requester`: my own requests;
 *  neither: reviews of pages I can edit. `status` defaults to pending. */
export interface ReviewListParams {
  status?: ReviewStatus;
  mine?: 'approver' | 'requester';
}

// ── public share links ──────────────────────────────────────────────

/** How long a new link lives; null = until it's revoked. */
export type ShareExpiryDays = 1 | 7 | 30 | 90;

/** The one response that carries the token (inside `url`). */
export interface ShareLinkCreatedOut {
  id: string;
  url: string;
  expires_at: string | null;
}

export type ShareLinkStatus = 'active' | 'expired' | 'revoked';

/** A link as managers and wiki admins see it — never its token. */
export interface ShareLinkOut {
  id: string;
  node: { id: string; title: string; kind: NodeKind; space_key: string; space_name: string };
  status: ShareLinkStatus;
  created_by: PersonRef | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
}

/** GET /wiki/public/{token} for a page: the published content, already
 *  made safe to show anyone (no comment anchors, links into the wiki as
 *  plain text), and presigned URLs for the images/files it embeds. */
export interface PublicPageOut {
  kind: 'page';
  title: string;
  content_json: JSONContent;
  published_at: string;
  asset_urls: Record<string, string>;
  /** How long the URLs live. */
  url_ttl_seconds: number;
}

/** …and for a file: `url` renders in the browser when `inline`, else it
 *  downloads; `download_url` always downloads. */
export interface PublicFileOut {
  kind: 'file';
  title: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  inline: boolean;
  url: string;
  download_url: string;
  /** How long the URLs live. */
  url_ttl_seconds: number;
}

export type PublicShareOut = PublicPageOut | PublicFileOut;

// ── help links ────────────────────────────────────────────────────────

/** A portal or kiosk screen's guide, as wiki admins see it. `context` is
 *  stored normalized (`portal:/sites/:id`); `trashed`: the guide is in the
 *  trash, so the link finds nothing until it's restored. */
export interface HelpLinkOut {
  id: string;
  context: string;
  node: { id: string; title: string; kind: NodeKind; space_key: string; space_name: string };
  trashed: boolean;
  created_by: PersonRef | null;
  created_at: string;
}

export interface HelpLinkIn {
  context: string;
  node_id: string;
}

// ── analytics ─────────────────────────────────────────────────────────

/** The windows GET /wiki/analytics offers, in days. */
export type AnalyticsDays = 7 | 30 | 90 | 365;

export interface AnalyticsParams {
  /** A space key; left out = every space (wiki admins only). */
  space?: string;
  days: AnalyticsDays;
}

export interface AnalyticsNodeRef {
  id: string;
  title: string;
  kind: NodeKind;
  space_key: string;
}

/** GET /wiki/analytics. `views_by_day` has one entry per day of the
 *  window, oldest first (`day` is YYYY-MM-DD, UTC); `failed_searches` is
 *  always empty for a space manager (searches aren't tied to a space). */
export interface AnalyticsOut {
  space_key: string | null;
  days: AnalyticsDays;
  top_pages: { node: AnalyticsNodeRef; views: number; viewers: number }[];
  views_by_day: { day: string; views: number }[];
  failed_searches: { query: string; count: number; last_at: string }[];
  stale_pages: { node: AnalyticsNodeRef; updated_at: string }[];
  overdue_reviews: { node: AnalyticsNodeRef; next_review_at: string }[];
}

// ── exports ─────────────────────────────────────────────────────────

/** What a page exports as — and, in a .zip, what its pages are. */
export type ExportPageFormat = 'pdf' | 'md';

/** POST /wiki/exports: a node (`node_id`) or a whole space (`space_key`).
 *  A page is pdf/md, or a zip when it has subpages; a folder or a
 *  space is a zip whose pages are `zip_format` (pdf by default). */
export interface ExportIn {
  node_id?: string;
  space_key?: string;
  format: ExportPageFormat | 'zip';
  zip_format?: ExportPageFormat;
}

export interface ExportCreatedOut {
  job_id: string;
}

export type ExportStatus = 'queued' | 'running' | 'done' | 'failed';

/** GET /wiki/exports/{id} (the requester only): `url` is a fresh download
 *  link (10 minutes) once `done`; `error` says why once `failed`. */
export interface ExportOut {
  id: string;
  status: ExportStatus;
  filename: string;
  url: string | null;
  error: string | null;
}
