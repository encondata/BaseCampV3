"""Pydantic shapes for the `/wiki` API. This is the whole contract (see
docs/superpowers/plans/2026-09-25-wiki-phase1.md, "API contract"),
mirrored as TS types in wiki/web/src/lib/types.ts — later tasks add
routes that use the shapes this task doesn't (NodeDetailOut, VersionOut,
FileVersionOut, SearchHit, TrashBatch, ...), not new shape modules."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Level = Literal["view", "edit", "manage"]
PrincipalType = Literal[
    "everyone", "internal", "role", "access_group", "person", "client", "partner"]
NodeKind = Literal["folder", "page", "file"]
VersionKind = Literal["autosave", "published", "restored", "imported"]
PreviewKind = Literal["native", "pdf", "none"]


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
    name: str
    description: str | None = None
    icon: str | None = None
    color: str | None = None
    default_access: Literal["internal", "everyone", "private"]


class SpacePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
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


Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                         max_length=200)]


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
