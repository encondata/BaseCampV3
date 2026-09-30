/** Typed client for the `/wiki` API, one function per route (named after
 *  it). Built on the portal's apiFetch, so the wiki shares the portal's
 *  in-memory access token, silent refresh and session-ended handling.
 *  Failures throw the portal's ApiError: `code` is the server's
 *  `detail.code`, `message` its `detail.message` (or the code). */
import type { JSONContent } from '@tiptap/core';

import { ApiError, apiFetch, READ_ONLY_MESSAGE, refreshSystemStatus } from '@portal/lib/api';

import type {
  AnalyticsOut,
  AnalyticsParams,
  AssetOut,
  AssetUrlsOut,
  CommentBodyIn,
  CommentIn,
  CommentOut,
  CommentThread,
  ContentVersion,
  ExportCreatedOut,
  ExportIn,
  ExportOut,
  FileUrlOut,
  FileUrlParams,
  FileVersionOut,
  GrantIn,
  GrantOut,
  GrantsOut,
  HelpLinkIn,
  HelpLinkOut,
  MeOut,
  NodeCopyIn,
  NodeCreateIn,
  NodeDeleteOut,
  NodeDetailOut,
  NodeMoveIn,
  NodeOut,
  NodePatchIn,
  NodePermissionsOut,
  NodePermissionsPutIn,
  PageContentOut,
  PersonRef,
  PrincipalOut,
  PrincipalType,
  ReviewDetail,
  ReviewListParams,
  ReviewOut,
  SearchHit,
  SearchParams,
  ShareExpiryDays,
  ShareLinkCreatedOut,
  ShareLinkOut,
  SpaceCreateIn,
  SpaceOut,
  SpacePatchIn,
  TemplateCreateIn,
  TemplateDetail,
  TemplateOut,
  TemplatePatchIn,
  TrashBatch,
  UploadStartIn,
  UploadStartOut,
  VersionDetail,
  VersionOut,
  WatchIn,
  WatchOut,
  WatchStateOut,
} from './types';

type Query = Record<string, string | number | boolean | null | undefined>;

async function errorFrom(resp: Response): Promise<ApiError> {
  let code = 'unknown_error';
  let detail: unknown;
  let message: string | undefined;
  try {
    detail = (await resp.json())?.detail;
    const d = detail as { code?: unknown; message?: unknown } | undefined;
    if (d && typeof d.code === 'string') code = d.code;
    if (d && typeof d.message === 'string' && d.message) message = d.message;
  } catch {
    /* non-JSON error body */
  }
  if (code === 'read_only_mode') {
    // the banner is the primary signal — make sure it appears at once
    refreshSystemStatus();
    message = READ_ONLY_MESSAGE;
  }
  return new ApiError(resp.status, code, detail, message);
}

/** A sentence for a toast or form error: the server's message when it
 *  sent one, else `fallback` (network failures, bare codes). */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (err instanceof ApiError && err.message && err.message !== err.code) return err.message;
  return fallback;
}

const seg = encodeURIComponent;

async function request<T>(
  method: string, path: string, opts: { query?: Query; body?: unknown } = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  const hasBody = opts.body !== undefined;
  const resp = await apiFetch(`/wiki${path}${qs ? `?${qs}` : ''}`, {
    method,
    ...(hasBody
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) }
      : {}),
  });
  if (!resp.ok) throw await errorFrom(resp);
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

// ── me / spaces ───────────────────────────────────────────────────────

export const getMe = () => request<MeOut>('GET', '/me');

export const listSpaces = (includeArchived = false) =>
  request<SpaceOut[]>('GET', '/spaces', { query: { include_archived: includeArchived || undefined } });

export const createSpace = (body: SpaceCreateIn) => request<SpaceOut>('POST', '/spaces', { body });

export const getSpace = (key: string) => request<SpaceOut>('GET', `/spaces/${seg(key)}`);

export const updateSpace = (key: string, body: SpacePatchIn) =>
  request<SpaceOut>('PATCH', `/spaces/${seg(key)}`, { body });

export const archiveSpace = (key: string) =>
  request<SpaceOut>('POST', `/spaces/${seg(key)}/archive`);

export const unarchiveSpace = (key: string) =>
  request<SpaceOut>('POST', `/spaces/${seg(key)}/unarchive`);

export const getSpaceGrants = async (key: string): Promise<GrantOut[]> =>
  (await request<GrantsOut>('GET', `/spaces/${seg(key)}/grants`)).grants;

/** Replaces the space's grants; 422 `no_manager` if no manage grant would remain. */
export const putSpaceGrants = async (key: string, grants: GrantIn[]): Promise<GrantOut[]> =>
  (await request<GrantsOut>('PUT', `/spaces/${seg(key)}/grants`, { body: { grants } })).grants;

/** Viewable children of `parentId` (the space's top level when omitted), in position order. */
export const getTree = (key: string, parentId?: string | null) =>
  request<NodeOut[]>('GET', `/spaces/${seg(key)}/tree`, { query: { parent_id: parentId } });

export const getSpaceTrash = (key: string) =>
  request<TrashBatch[]>('GET', `/spaces/${seg(key)}/trash`);

export const searchPrincipals = (type: PrincipalType, q = '') =>
  request<PrincipalOut[]>('GET', '/principals', { query: { type, q } });

// ── nodes ─────────────────────────────────────────────────────────────

export const createNode = (body: NodeCreateIn) => request<NodeOut>('POST', '/nodes', { body });

export const getNode = (id: string) => request<NodeDetailOut>('GET', `/nodes/${seg(id)}`);

export const updateNode = (id: string, body: NodePatchIn) =>
  request<NodeOut>('PATCH', `/nodes/${seg(id)}`, { body });

export const moveNode = (id: string, body: NodeMoveIn) =>
  request<NodeOut>('POST', `/nodes/${seg(id)}/move`, { body });

export const copyNode = (id: string, body: NodeCopyIn) =>
  request<NodeOut>('POST', `/nodes/${seg(id)}/copy`, { body });

/** Moves the node and its subtree to the trash. */
export const deleteNode = (id: string) =>
  request<NodeDeleteOut>('DELETE', `/nodes/${seg(id)}`);

export const getNodePermissions = (id: string) =>
  request<NodePermissionsOut>('GET', `/nodes/${seg(id)}/permissions`);

/** 422 `would_lock_out` when the change would leave the caller without manage. */
export const putNodePermissions = (id: string, body: NodePermissionsPutIn) =>
  request<NodePermissionsOut>('PUT', `/nodes/${seg(id)}/permissions`, { body });

/** 403 `forbidden` unless the caller is the author or a developer; 422
 *  `home_page` for a library's home page. */
export const setNodePrivacy = (id: string, isPrivate: boolean) =>
  request<NodeOut>('PATCH', `/nodes/${seg(id)}/privacy`, { body: { is_private: isPrivate } });

/** `null` goes back to inheriting. Manage. */
export const setNodePrinting = (id: string, allow: boolean | null) =>
  request<NodeOut>('PATCH', `/nodes/${seg(id)}/printing`, { body: { allow_printing: allow } });

export const setFavorite = (id: string, favorite: boolean) =>
  request<void>(favorite ? 'PUT' : 'DELETE', `/nodes/${seg(id)}/favorite`);

export const listFavorites = () => request<NodeOut[]>('GET', '/favorites');

export const listRecent = (opts: { space?: string; limit?: number } = {}) =>
  request<NodeOut[]>('GET', '/recent', { query: opts });

/** Pages I edited that have unpublished changes. */
export const listDrafts = () => request<NodeOut[]>('GET', '/drafts');

// ── pages / versions ────────────────────────────────────────────────

/** 404 `not_published` for a view-only reader of a never-published page;
 *  422 `bad_version` for an unknown version. */
export const getPageContent = (id: string, version: ContentVersion = 'published') =>
  request<PageContentOut>('GET', `/pages/${seg(id)}/content`, { query: { version } });

/** 409 `nothing_to_publish` when the draft equals the published version. */
export const publishPage = (id: string, note?: string) =>
  request<VersionOut>('POST', `/pages/${seg(id)}/publish`, { body: note ? { note } : {} });

export const listVersions = (id: string) =>
  request<VersionOut[]>('GET', `/pages/${seg(id)}/versions`);

export const getVersion = (id: string, versionId: string) =>
  request<VersionDetail>('GET', `/pages/${seg(id)}/versions/${seg(versionId)}`);

/** Seeds a page that was never opened live (409 `already_live` otherwise). */
export const putDraft = (id: string, contentJson: JSONContent) =>
  request<void>('PUT', `/nodes/${seg(id)}/draft`, { body: { content_json: contentJson } });

/** Records the `restored` version after the editor loaded an old one. */
export const recordRestore = (id: string, fromVersionId: string) =>
  request<VersionOut>('POST', `/pages/${seg(id)}/versions/restored`,
    { body: { from_version_id: fromVersionId } });

// ── uploads / files / assets ────────────────────────────────────────

export const startUpload = (body: UploadStartIn) =>
  request<UploadStartOut>('POST', '/uploads', { body });

/** A new file node or file version comes back as NodeOut, a page asset as AssetOut. */
export const completeUpload = (uploadId: string) =>
  request<NodeOut | AssetOut>('POST', '/uploads/complete', { body: { upload_id: uploadId } });

export const listFileVersions = (id: string) =>
  request<FileVersionOut[]>('GET', `/files/${seg(id)}/versions`);

export const getFileUrl = (id: string, params: FileUrlParams = {}) =>
  request<FileUrlOut>('GET', `/files/${seg(id)}/url`, { query: { ...params } });

export const updateFile = (id: string, description: string) =>
  request<NodeOut>('PATCH', `/files/${seg(id)}`, { body: { description } });

export const restoreFileVersion = (id: string, versionId: string) =>
  request<FileVersionOut>('POST', `/files/${seg(id)}/versions/${seg(versionId)}/restore`);

/** Presigned URLs by asset id; unknown or unviewable ids are left out. */
export const getAssetUrls = async (ids: string[]): Promise<Record<string, string>> => {
  if (ids.length === 0) return {};
  return (await request<AssetUrlsOut>('POST', '/assets/urls', { body: { ids } })).urls;
};

// ── search / trash ──────────────────────────────────────────────────

/** `log: false` leaves the search out of the analytics log (the top
 *  bar's live results); by default every search is logged. */
export const search = ({ q, space, kind, limit, log }: SearchParams) =>
  request<SearchHit[]>('GET', '/search', {
    query: { q, space, kind, limit, log: log === false ? false : undefined },
  });

export const restoreTrash = (batchId: string) =>
  request<NodeOut>('POST', `/trash/${seg(batchId)}/restore`);

/** Deletes the batch forever. */
export const purgeTrash = (batchId: string) =>
  request<void>('DELETE', `/trash/${seg(batchId)}`);

// ── watches ─────────────────────────────────────────────────────────

/** My watches, newest first — only those whose target I can still see. */
export const listWatches = () => request<WatchOut[]>('GET', '/watches');

/** Watch a node or a space (idempotent: an existing watch comes back). */
export const watch = (body: WatchIn) => request<WatchOut>('PUT', '/watches', { body });

export const unwatch = (watchId: string) =>
  request<void>('DELETE', `/watches/${seg(watchId)}`);

export const getWatchState = (nodeId: string) =>
  request<WatchStateOut>('GET', `/nodes/${seg(nodeId)}/watch`);

// ── comments & mentions ─────────────────────────────────────────────

/** The page's threads, oldest first (resolved and orphaned ones too). */
export const listComments = (nodeId: string) =>
  request<CommentThread[]>('GET', `/nodes/${seg(nodeId)}/comments`);

/** Start a thread, or reply to one (`thread_id`). */
export const postComment = (nodeId: string, body: CommentIn) =>
  request<CommentOut>('POST', `/nodes/${seg(nodeId)}/comments`, { body });

/** Edit your own comment. */
export const editComment = (commentId: string, body: CommentBodyIn) =>
  request<CommentOut>('PATCH', `/comments/${seg(commentId)}`, { body: { body } });

export const deleteComment = (commentId: string) =>
  request<void>('DELETE', `/comments/${seg(commentId)}`);

export const resolveThread = (threadId: string) =>
  request<CommentThread>('POST', `/comments/threads/${seg(threadId)}/resolve`);

export const reopenThread = (threadId: string) =>
  request<CommentThread>('POST', `/comments/threads/${seg(threadId)}/reopen`);

/** Up to 10 people who can view the page, for the @mention picker (the API
 *  answers [] for a query under 2 characters, 403 to someone who can't comment). */
export const listMentionable = (nodeId: string, q: string) =>
  request<PersonRef[]>('GET', `/nodes/${seg(nodeId)}/mentionable`, { query: { q } });

// ── templates ─────────────────────────────────────────────────────────

/** Builtins, then other global templates, then (with `space`) that
 *  space's own — each group name-ordered. */
export const listTemplates = (space?: string) =>
  request<TemplateOut[]>('GET', '/templates', { query: { space } });

export const getTemplate = (id: string) => request<TemplateDetail>('GET', `/templates/${seg(id)}`);

/** 409 `name_taken` for a duplicate name in the same scope. */
export const createTemplate = (body: TemplateCreateIn) =>
  request<TemplateOut>('POST', '/templates', { body });

/** 422 `builtin` for one of the four seeded templates. */
export const updateTemplate = (id: string, body: TemplatePatchIn) =>
  request<TemplateOut>('PATCH', `/templates/${seg(id)}`, { body });

/** 422 `builtin` for one of the four seeded templates. */
export const deleteTemplate = (id: string) =>
  request<void>('DELETE', `/templates/${seg(id)}`);

// ── reviews & periodic review ───────────────────────────────────────

/** Submit the page's stored draft for review — flush the live document
 *  first, as before a publish. Replaces the page's pending review;
 *  409 `nothing_to_review` when the draft adds nothing. (Where the space
 *  requires approval, `publishPage` answers 409 `review_required` to a
 *  non-manager.) */
export const submitReview = (pageId: string, note?: string) =>
  request<ReviewOut>('POST', `/pages/${seg(pageId)}/reviews`, { body: note ? { note } : {} });

/** The reviews queue, newest first. */
export const listReviews = ({ status, mine }: ReviewListParams = {}) =>
  request<ReviewOut[]>('GET', '/reviews', { query: { status, mine } });

export const getReview = (id: string) => request<ReviewDetail>('GET', `/reviews/${seg(id)}`);

/** Publishes exactly the submitted snapshot (manage); 409 `not_pending`
 *  once it's decided or withdrawn. */
export const approveReview = (id: string, note?: string) =>
  request<ReviewOut>('POST', `/reviews/${seg(id)}/approve`, { body: note ? { note } : {} });

/** Request changes (manage) — the note is required. */
export const rejectReview = (id: string, note: string) =>
  request<ReviewOut>('POST', `/reviews/${seg(id)}/reject`, { body: { note } });

/** The requester, or a manager, takes the request back. */
export const withdrawReview = (id: string) =>
  request<ReviewOut>('POST', `/reviews/${seg(id)}/withdraw`);

/** The page is still right: its next review is one interval from now. */
export const markReviewed = (pageId: string) =>
  request<NodeOut>('POST', `/pages/${seg(pageId)}/mark-reviewed`);

/** The space's pages due for review within two weeks (or overdue), soonest first. */
export const listDueReviews = (spaceKey: string) =>
  request<NodeOut[]>('GET', `/spaces/${seg(spaceKey)}/due-reviews`);

// ── public share links ──────────────────────────────────────────────

/** Manage on the node; 422 `bad_kind` for a folder, 422 `links_disabled`
 *  where the space doesn't allow public links. The URL (with its token) is
 *  only ever returned here. */
export const createShareLink = (nodeId: string, expiresInDays: ShareExpiryDays | null) =>
  request<ShareLinkCreatedOut>('POST', `/nodes/${seg(nodeId)}/share-links`,
    { body: { expires_in_days: expiresInDays } });

/** The node's links — active, expired and revoked — newest first (manage). */
export const listShareLinks = (nodeId: string) =>
  request<ShareLinkOut[]>('GET', `/nodes/${seg(nodeId)}/share-links`);

/** Manage on the link's node, the person who made it, or a wiki admin. */
export const revokeShareLink = (id: string) =>
  request<void>('DELETE', `/share-links/${seg(id)}`);

/** Wiki administrators: every link, newest first. */
export const listAllShareLinks = () => request<ShareLinkOut[]>('GET', '/share-links');

// ── export settings (wiki admins) ───────────────────────────────────

/** The wiki's standard confidentiality statement for an exported PDF's
 *  cover ("" for none). A library can set its own in its settings. */
export const getExportSettings = () =>
  request<{ confidentiality_statement: string }>('GET', '/admin/export-settings');

/** The server trims it; 422 `bad_setting` over 1000 characters. */
export const saveExportSettings = (statement: string) =>
  request<{ confidentiality_statement: string }>('PUT', '/admin/export-settings', {
    body: { confidentiality_statement: statement },
  });

// ── help links (wiki admins) ─────────────────────────────────────────

/** Every portal/kiosk help link, by context. */
export const listHelpLinks = () => request<HelpLinkOut[]>('GET', '/help-links');

/** The server normalizes `context`: 422 `bad_context`, 409 `context_taken`,
 *  422 `bad_kind` unless the node is a page or file. */
export const createHelpLink = (body: HelpLinkIn) =>
  request<HelpLinkOut>('POST', '/help-links', { body });

export const updateHelpLink = (id: string, body: Partial<HelpLinkIn>) =>
  request<HelpLinkOut>('PATCH', `/help-links/${seg(id)}`, { body });

export const deleteHelpLink = (id: string) => request<void>('DELETE', `/help-links/${seg(id)}`);

// ── analytics ───────────────────────────────────────────────────────

/** Count a view of a page or file (204; not counted in read-only mode). */
export const recordView = (nodeId: string) =>
  request<void>('POST', `/nodes/${seg(nodeId)}/view`);

/** Wiki admins (any space, or all of them) and space managers (a space they manage). */
export const getAnalytics = ({ space, days }: AnalyticsParams) =>
  request<AnalyticsOut>('GET', '/analytics', { query: { space, days } });

// ── exports ─────────────────────────────────────────────────────────

/** Queues an export (view on the node or space). 422 `use_download` for a
 *  file, `bad_format` for a format the node can't take, `not_published`
 *  for a single never-published page; 429 `too_many_exports` with three
 *  already in progress. */
export const createExport = (body: ExportIn) =>
  request<ExportCreatedOut>('POST', '/exports', { body });

/** The caller's own export (404 for anyone else's, or once it's purged). */
export const getExport = (jobId: string) => request<ExportOut>('GET', `/exports/${seg(jobId)}`);
