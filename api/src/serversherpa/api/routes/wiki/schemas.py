"""Pydantic shapes for the `/wiki` API. This is the whole contract (see
docs/superpowers/plans/2026-09-25-wiki-phase1.md, "API contract"),
mirrored as TS types in wiki/web/src/lib/types.ts — later tasks add
routes that use the shapes this task doesn't (NodeDetailOut, VersionOut,
FileVersionOut, SearchHit, TrashBatch, ...), not new shape modules."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Level = Literal["view", "edit", "manage"]
PrincipalType = Literal[
    "everyone", "internal", "role", "access_group", "person", "client", "partner"]
NodeKind = Literal["folder", "page", "file"]
VersionKind = Literal["autosave", "published", "restored", "imported"]
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
    title: Title
    initial_content: dict | None = None
    after_id: uuid.UUID | None = None


class NodePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    owner_id: uuid.UUID | None = None


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
    kind: Literal["draft", "autosave", "published", "restored", "imported"]
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
