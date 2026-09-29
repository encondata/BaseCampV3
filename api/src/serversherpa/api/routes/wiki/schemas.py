"""Pydantic shapes for the `/wiki` API. This is the whole contract (see
docs/superpowers/plans/2026-09-25-wiki-phase1.md, "API contract"),
mirrored as TS types in wiki/web/src/lib/types.ts — later tasks add
routes that use the shapes this task doesn't (NodeDetailOut, VersionOut,
FileVersionOut, SearchHit, TrashBatch, ...), not new shape modules."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Level = Literal["view", "edit", "manage"]
PrincipalType = Literal[
    "everyone", "internal", "role", "access_group", "person", "client", "partner"]
NodeKind = Literal["folder", "page", "file"]
VersionKind = Literal["autosave", "published", "restored", "imported", "submitted"]
PreviewKind = Literal["native", "pdf", "none"]


# A node title (wiki_nodes.title is CHECKed to 1-200 characters). A space's
# name is one too: its home page is created with the space's name as title.
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                         max_length=200)]


class PersonRef(BaseModel):
    id: uuid.UUID
    name: str


# ── spaces ────────────────────────────────────────────────────────────


class SpaceOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    description: str | None
    icon: str | None
    color: str | None
    home_node_id: uuid.UUID | None
    archived_at: datetime | None
    my_level: Level | None
    settings: dict
    created_at: datetime
    updated_at: datetime


class SpaceCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    name: Title
    description: str | None = None
    icon: str | None = None
    color: str | None = None
    default_access: Literal["internal", "everyone", "private"]


class SpacePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Title | None = None
    description: str | None = None
    icon: str | None = None
    color: str | None = None
    settings: dict | None = None


# ── grants / principals ─────────────────────────────────────────────


class GrantIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    principal_type: PrincipalType
    principal_id: str | None = None
    level: Level


class GrantOut(GrantIn):
    id: uuid.UUID
    principal_label: str
    node_id: uuid.UUID | None


class GrantsPutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    grants: list[GrantIn]


class GrantsOut(BaseModel):
    grants: list[GrantOut]


class EffectiveGrantSource(BaseModel):
    kind: Literal["space", "node"]
    node_id: uuid.UUID | None
    title: str | None


class EffectiveGrant(GrantIn):
    principal_label: str
    source: EffectiveGrantSource


class PrincipalOut(BaseModel):
    type: PrincipalType
    id: str | None
    label: str


class NodePermissionsOut(BaseModel):
    inherit: bool
    grants: list[GrantOut]
    effective: list[EffectiveGrant]


class NodePermissionsPutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inherit: bool
    grants: list[GrantIn] | None = None


# ── me ────────────────────────────────────────────────────────────────


class MeOut(BaseModel):
    person: PersonRef
    is_admin: bool
    can_create_spaces: bool


# ── nodes / versions / files (built here for later tasks to reuse) ────


class NodePageOut(BaseModel):
    is_home: bool
    published_version_id: uuid.UUID | None
    published_at: datetime | None
    has_unpublished_changes: bool


class FileVersionOut(BaseModel):
    id: uuid.UUID
    version_no: int
    filename: str
    content_type: str
    size_bytes: int
    preview_kind: PreviewKind
    preview_status: str
    extract_status: str
    note: str | None
    uploaded_by: PersonRef | None
    created_at: datetime


class NodeFileOut(BaseModel):
    description: str
    current_version: FileVersionOut | None


class NodeReviewOut(BaseModel):
    """A page's review cycle. `interval_months` is the interval in effect
    — the page's own (`own_interval_months`; null = inherit), else its
    space's; `state` is `overdue` once `next_review_at` has passed,
    `due_soon` within 14 days, else `ok` — null when there's no interval
    or nothing scheduled yet. `pending_review_id` is the page's pending
    review (shown to editors only)."""
    interval_months: int | None
    own_interval_months: int | None
    next_review_at: datetime | None
    last_reviewed_at: datetime | None
    state: Literal["ok", "due_soon", "overdue"] | None
    pending_review_id: uuid.UUID | None


class NodeOut(BaseModel):
    id: uuid.UUID
    space_id: uuid.UUID
    space_key: str
    parent_id: uuid.UUID | None
    kind: NodeKind
    title: str
    position: float
    inherit_permissions: bool
    owner: PersonRef | None
    created_at: datetime
    updated_at: datetime
    updated_by: PersonRef | None
    my_level: Level | None
    has_children: bool
    is_favorite: bool
    page: NodePageOut | None
    file: NodeFileOut | None
    # pages only (null for folders and files)
    review: NodeReviewOut | None = None


class Breadcrumb(BaseModel):
    # an ancestor the caller can't view is {id: None, title: "…", kind: "folder"}
    id: uuid.UUID | None
    title: str
    kind: NodeKind


class NodeDetailOut(NodeOut):
    breadcrumbs: list[Breadcrumb]
    space: SpaceOut


class NodeCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    space_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    kind: Literal["folder", "page"]
    # required unless template_id is given, in which case an omitted or
    # blank title defaults to the template's name (see _validate below)
    title: Annotated[str, StringConstraints(strip_whitespace=True,
                                            max_length=200)] | None = None
    initial_content: dict | None = None
    template_id: uuid.UUID | None = None
    after_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _validate(self) -> NodeCreateIn:
        if self.initial_content is not None and self.template_id is not None:
            raise ValueError("Give at most one of initial_content or template_id.")
        if not self.title:
            self.title = None
            if self.template_id is None:
                raise ValueError("title is required unless template_id is given.")
        return self


class NodePatchIn(BaseModel):
    """`review_interval_months` (pages, manage): the page's own review
    interval — an explicit null clears it (back to the space's); leaving
    the key out changes nothing."""
    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    owner_id: uuid.UUID | None = None
    review_interval_months: int | None = Field(default=None, ge=1, le=60)


class NodeMoveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_id: uuid.UUID | None
    space_id: uuid.UUID | None = None
    before_id: uuid.UUID | None = None
    after_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _one_anchor(self) -> NodeMoveIn:
        if self.before_id is not None and self.after_id is not None:
            raise ValueError("Give before_id or after_id, not both.")
        return self


class NodeCopyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_id: uuid.UUID | None
    space_id: uuid.UUID | None = None


class NodeDeleteOut(BaseModel):
    batch_id: uuid.UUID
    count: int


class VersionOut(BaseModel):
    id: uuid.UUID
    version_no: int
    kind: VersionKind
    title: str
    note: str | None
    created_by: PersonRef | None
    created_at: datetime


class VersionDetail(VersionOut):
    content_json: dict


class SearchHitNode(BaseModel):
    id: uuid.UUID
    kind: NodeKind
    title: str
    space_key: str
    space_name: str


class SearchHit(BaseModel):
    node: SearchHitNode
    snippet_html: str
    breadcrumbs: list[str]


class TrashRoot(BaseModel):
    id: uuid.UUID
    title: str
    kind: NodeKind


class TrashBatch(BaseModel):
    batch_id: uuid.UUID
    root: TrashRoot
    count: int
    deleted_by: PersonRef | None
    deleted_at: datetime
    purge_at: datetime | None = Field(default=None)


# ── page content / publish / restore ─────────────────────────────────


class PageContentOut(BaseModel):
    """One readable state of a page: a version (`version_id` set), or the
    live draft (`kind` "draft", no version id/number)."""
    version_id: uuid.UUID | None
    version_no: int | None
    kind: Literal["draft", "autosave", "published", "restored", "imported", "submitted"]
    title: str
    content_json: dict
    created_at: datetime | None
    created_by: PersonRef | None


class PublishIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: Annotated[str, StringConstraints(strip_whitespace=True,
                                           max_length=1000)] | None = None


class RestoreIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_version_id: uuid.UUID


class DraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # any JSON: `pages.check_doc` answers a non-document with 422 `bad_doc`
    content_json: Any


# ── uploads / files / page assets ────────────────────────────────────


UploadTarget = Literal["node", "version", "asset"]


class UploadStartIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: UploadTarget
    space_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    node_id: uuid.UUID | None = None
    page_id: uuid.UUID | None = None
    filename: str = Field(max_length=255)
    content_type: str = Field(max_length=255)
    size: int


class UploadStartOut(BaseModel):
    upload_id: str
    url: str
    headers: dict[str, str]


class UploadCompleteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    upload_id: str


class AssetOut(BaseModel):
    id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int


class FilePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str


class FileUrlOut(BaseModel):
    url: str | None
    content_type: str
    preview_status: str


class AssetUrlsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[uuid.UUID] = Field(max_length=200)


class AssetUrlsOut(BaseModel):
    urls: dict[uuid.UUID, str]


# ── templates ────────────────────────────────────────────────────────

# a template's name (wiki_templates.name is CHECKed to 1-120 characters)
TemplateName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                                max_length=120)]
# the listing goes to every wiki viewer: keep what it carries small
TemplateDescription = Annotated[str, StringConstraints(max_length=500)]
TemplateIcon = Annotated[str, StringConstraints(max_length=16)]


class TemplateOut(BaseModel):
    id: uuid.UUID
    space_id: uuid.UUID | None
    space_key: str | None
    name: str
    description: str
    icon: str
    is_builtin: bool
    created_by: PersonRef | None
    created_at: datetime
    updated_at: datetime


class TemplateDetail(TemplateOut):
    content_json: dict


class TemplateCreateIn(BaseModel):
    """Exactly one of `content_json` (validated like a draft) or
    `from_node_id` (that page's current draft or published content,
    depending on the caller's level on it — see `templates.py`)."""
    model_config = ConfigDict(extra="forbid")

    space_id: uuid.UUID | None = None
    name: TemplateName
    description: TemplateDescription = ""
    icon: TemplateIcon = ""
    content_json: dict | None = None
    from_node_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _one_content_source(self) -> TemplateCreateIn:
        if (self.content_json is None) == (self.from_node_id is None):
            raise ValueError("Give exactly one of content_json or from_node_id.")
        return self


class TemplatePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: TemplateName | None = None
    description: TemplateDescription | None = None
    icon: TemplateIcon | None = None
    content_json: dict | None = None


# ── watches ──────────────────────────────────────────────────────────


class WatchNodeRef(BaseModel):
    id: uuid.UUID
    title: str
    kind: NodeKind


class WatchSpaceRef(BaseModel):
    key: str
    name: str


class WatchOut(BaseModel):
    """A watch: `node` is null for a space watch; `space` is the watched
    space, or the watched node's space."""
    id: uuid.UUID
    node: WatchNodeRef | None
    space: WatchSpaceRef | None
    created_at: datetime


class WatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: uuid.UUID | None = None
    space_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _one_target(self) -> WatchIn:
        if (self.node_id is None) == (self.space_id is None):
            raise ValueError("Give exactly one of node_id or space_id.")
        return self


class WatchStateOut(BaseModel):
    """Whether the caller watches a node, and through what: the node
    itself, one of its ancestors, or its space (the closest wins);
    `watch_id` is that watch, for unwatching it."""
    watching: bool
    via: Literal["node", "ancestor", "space"] | None
    watch_id: uuid.UUID | None


# ── comments ─────────────────────────────────────────────────────────


class CommentBodyIn(BaseModel):
    """Plain text (1-5000 characters once trimmed) and the ids of the
    people it @mentions."""
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                           max_length=5000)]
    mentions: list[uuid.UUID] = Field(default_factory=list, max_length=50)


class CommentIn(BaseModel):
    """A new thread (no `thread_id`; `anchor` for an inline one), or a
    reply to thread `thread_id`."""
    model_config = ConfigDict(extra="forbid")

    body: CommentBodyIn
    thread_id: uuid.UUID | None = None
    anchor: bool = False


class CommentPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: CommentBodyIn


class CommentBodyOut(BaseModel):
    text: str
    mentions: list[PersonRef]


class CommentOut(BaseModel):
    """A deleted comment keeps its place in its thread with `deleted`
    set and its body replaced by "Comment deleted"."""
    id: uuid.UUID
    thread_id: uuid.UUID
    parent_id: uuid.UUID | None
    body: CommentBodyOut
    author: PersonRef | None
    created_at: datetime
    edited_at: datetime | None
    deleted: bool


class ThreadOut(BaseModel):
    """A comment thread, its comments oldest first. `anchor` = an inline
    thread (a `commentThread` mark in the page carries `thread_id`)."""
    thread_id: uuid.UUID
    anchor: bool
    resolved_at: datetime | None
    resolved_by: PersonRef | None
    comments: list[CommentOut]


# ── reviews ──────────────────────────────────────────────────────────

ReviewStatus = Literal["pending", "approved", "rejected", "withdrawn"]
ReviewNote = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]


class ReviewIn(BaseModel):
    """Submit for review, approve, or withdraw: an optional note."""
    model_config = ConfigDict(extra="forbid")

    note: ReviewNote | None = None


class ReviewRejectIn(BaseModel):
    """Request changes: the note (what to change) is required."""
    model_config = ConfigDict(extra="forbid")

    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                           max_length=1000)]


class ReviewNodeRef(BaseModel):
    id: uuid.UUID
    title: str
    space_key: str
    space_name: str


class ReviewOut(BaseModel):
    """A review request: `version_id` is the `submitted` snapshot."""
    id: uuid.UUID
    node: ReviewNodeRef
    version_id: uuid.UUID
    status: ReviewStatus
    note: str
    requested_by: PersonRef | None
    created_at: datetime
    decided_by: PersonRef | None
    decided_at: datetime | None
    decision_note: str


class ReviewDetail(ReviewOut):
    """The review plus both sides of its diff: the submitted snapshot and
    the page's published content now (null if never published). `stale`:
    a pending review whose page was published after it was submitted, so
    approving replaces content the submitter never saw."""
    submitted_version_no: int
    submitted_content: dict
    published_version_id: uuid.UUID | None
    published_content: dict | None
    stale: bool


# ── public share links ───────────────────────────────────────────────


class ShareLinkCreateIn(BaseModel):
    """`expires_in_days`: 1, 7, 30 or 90, or null for a link that never
    expires; left out, 30."""
    model_config = ConfigDict(extra="forbid")

    expires_in_days: Literal[1, 7, 30, 90] | None = 30


class ShareLinkCreatedOut(BaseModel):
    """The one response that carries the token (inside `url`)."""
    id: uuid.UUID
    url: str
    expires_at: datetime | None


class ShareNodeRef(BaseModel):
    id: uuid.UUID
    title: str
    kind: NodeKind
    space_key: str
    space_name: str


class ShareLinkOut(BaseModel):
    """A link as its node's managers and wiki admins see it — never its
    token or token hash."""
    id: uuid.UUID
    node: ShareNodeRef
    status: Literal["active", "expired", "revoked"]
    created_by: PersonRef | None
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    view_count: int
    last_viewed_at: datetime | None


class PublicPageOut(BaseModel):
    """A shared page's published content, made safe to show anyone
    (`wiki.content.public_doc`), and presigned URLs for the page assets
    it embeds, keyed by asset id."""
    kind: Literal["page"] = "page"
    title: str
    content_json: dict
    published_at: datetime
    asset_urls: dict[str, str]
    # how long the URLs live — the SPA re-reads before they expire
    url_ttl_seconds: int


class PublicFileOut(BaseModel):
    """A shared file's current version: `url` shows it in the browser
    where the inline rules allow (`inline`; an attachment otherwise);
    `download_url` always downloads it."""
    kind: Literal["file"] = "file"
    title: str
    filename: str
    content_type: str
    size_bytes: int
    inline: bool
    url: str
    download_url: str
    url_ttl_seconds: int


# ── help links ───────────────────────────────────────────────────────

# a context as sent: `help.normalize_context` and `help.is_valid_context`
# (422 `bad_context`) decide what is stored; this only caps the raw text
HelpContextIn = Annotated[str, StringConstraints(max_length=2000)]


class HelpOut(BaseModel):
    """`GET /wiki/help`: the guide for a screen; `context` is the stored
    context that matched."""
    node_id: uuid.UUID
    title: str
    url: str
    context: str


class HelpLinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context: HelpContextIn
    node_id: uuid.UUID


class HelpLinkPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context: HelpContextIn | None = None
    node_id: uuid.UUID | None = None


class HelpLinkOut(BaseModel):
    """A help link as wiki admins see it. `trashed`: its guide is in the
    trash, so the link answers 404 to everyone until it's restored."""
    id: uuid.UUID
    context: str
    node: ShareNodeRef
    trashed: bool
    created_by: PersonRef | None
    created_at: datetime


# ── analytics ────────────────────────────────────────────────────────


class AnalyticsNodeRef(BaseModel):
    id: uuid.UUID
    title: str
    kind: NodeKind
    space_key: str


class TopPageOut(BaseModel):
    node: AnalyticsNodeRef
    views: int
    viewers: int


class DayViewsOut(BaseModel):
    day: date
    views: int


class FailedSearchOut(BaseModel):
    """A search with no results, grouped case-insensitively (`query` is
    lowercased)."""
    query: str
    count: int
    last_at: datetime


class StalePageOut(BaseModel):
    node: AnalyticsNodeRef
    updated_at: datetime


class OverdueReviewOut(BaseModel):
    node: AnalyticsNodeRef
    next_review_at: datetime


class AnalyticsOut(BaseModel):
    """`GET /wiki/analytics`: `space_key` is the space asked about (null =
    every space, wiki admins only); `days` the window the views and
    failed searches cover (`views_by_day` has one entry per day of it,
    oldest first). `failed_searches` is always empty for a space
    manager — searches aren't tied to a space. Stale pages and overdue
    reviews are as of now, whatever the window."""
    space_key: str | None
    days: int
    top_pages: list[TopPageOut]
    views_by_day: list[DayViewsOut]
    failed_searches: list[FailedSearchOut]
    stale_pages: list[StalePageOut]
    overdue_reviews: list[OverdueReviewOut]


# ── exports ──────────────────────────────────────────────────────────


class ExportIn(BaseModel):
    """Export a node (`node_id`) or a whole space (`space_key`) — exactly
    one. A page exports as `pdf`, `docx` or `md`; a folder, a page with
    subpages, or a space as a `zip` whose pages are `zip_format` (pdf when
    left out)."""
    model_config = ConfigDict(extra="forbid")

    node_id: uuid.UUID | None = None
    space_key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                                max_length=40)] | None = None
    format: Literal["pdf", "docx", "md", "zip"]
    zip_format: Literal["pdf", "docx", "md"] | None = None

    @model_validator(mode="after")
    def _validate(self) -> ExportIn:
        if (self.node_id is None) == (self.space_key is None):
            raise ValueError("Give exactly one of node_id or space_key.")
        if self.zip_format is not None and self.format != "zip":
            raise ValueError("zip_format only goes with format 'zip'.")
        return self


class ExportCreatedOut(BaseModel):
    job_id: uuid.UUID


class ExportOut(BaseModel):
    """An export as the person who asked for it sees it. `url` (a fresh
    download link, 10 minutes) once it's `done`; `error` once it's
    `failed`."""
    id: uuid.UUID
    status: Literal["queued", "running", "done", "failed"]
    filename: str
    url: str | None
    error: str | None


# ── internal (collab server) ─────────────────────────────────────────


class CollabAuthorizeOut(BaseModel):
    level: Level
    person: PersonRef
    color: str


class CollabLevelOut(BaseModel):
    level: Level


class PageStateOut(BaseModel):
    ydoc_b64: str | None
    draft_json: dict | None
    title: str


class PageStateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ydoc_b64: str
    # any JSON: `pages.check_doc` answers a non-document with 422 `bad_doc`
    content_json: Any
    editor_ids: list[uuid.UUID] = Field(default_factory=list)
