"""Full-text and fuzzy title search over the wiki (spec §5 "Search"):
`search_tsv`'s upkeep (`refresh_search`, called after anything that
changes a node's title or indexed body) and the query itself
(`search`) — Postgres full-text search (`websearch_to_tsquery`/
`ts_rank_cd`) merged with trigram title similarity for typo tolerance,
filtered through the caller's `AccessIndex`, with `ts_headline`
snippets that are HTML-escaped before `<mark>` is added back in (the
only HTML that ever reaches the client).

This module is imported by `wiki.pages` and by several routes, but it
must never import from `api.routes.wiki` itself: that package's
`__init__` imports every route module eagerly (including ones that
import this module for `refresh_search`), so an import the other way
would be circular.
"""
from __future__ import annotations

import html
import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    WikiFile,
    WikiFileVersion,
    WikiGrant,
    WikiNode,
    WikiPage,
    WikiPageVersion,
    WikiSpace,
)
from serversherpa.wiki.content import CONTROL_CHARS
from serversherpa.wiki.permissions import AccessIndex, grant_matches, level_rank

KINDS = ("folder", "page", "file")

# ts_headline's StartSel/StopSel: control characters that can't collide
# with anything `html.escape` produces, so marks are added back in after
# escaping without re-opening any HTML injection the body text carried.
_MARK_START = "\x02"
_MARK_STOP = "\x03"
_HEADLINE_OPTIONS = (
    f"StartSel={_MARK_START}, StopSel={_MARK_STOP}, MaxFragments=2, "
    "MaxWords=24, MinWords=8")


_TITLE_SIMILARITY_THRESHOLD = 0.3
# candidates fetched per requested hit, before permission filtering thins
# them out — large enough that filtering rarely starves the final page
_CANDIDATE_FANOUT = 5


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


# ── indexed body text ───────────────────────────────────────────────


async def _page_body(db: AsyncSession, node_id: uuid.UUID) -> str:
    return await db.scalar(
        select(WikiPageVersion.content_text)
        .join(WikiPage, WikiPage.published_version_id == WikiPageVersion.id)
        .where(WikiPage.node_id == node_id)) or ""


async def _file_body(db: AsyncSession, node_id: uuid.UUID) -> str:
    row = (await db.execute(
        select(WikiFile.description, WikiFileVersion.text_extract)
        .outerjoin(WikiFileVersion, WikiFileVersion.id == WikiFile.current_version_id)
        .where(WikiFile.node_id == node_id))).first()
    if row is None:
        return ""
    description, text_extract = row
    return f"{description or ''}\n{text_extract or ''}"


# How much of a body is indexed (and searched for snippets). A tsvector
# holds at most 1 MB of lexemes and positions, and text of unique tokens
# (a log of ids, a CSV of hashes) costs more than its own size, so the
# 1,000,000-character extract cap is far too much to index whole. Where
# even this overflows (e.g. a text of unique single CJK characters),
# `refresh_search` falls back to the smaller caps, then to the title.
SEARCH_BODY_CHARS = 200_000
_FALLBACK_BODY_CHARS = (20_000, 0)
# Postgres's "program limit exceeded" (string is too long for tsvector)
_PROGRAM_LIMIT_EXCEEDED = "54000"


async def body_text(db: AsyncSession, node_id: uuid.UUID, kind: str) -> str:
    """The text indexed at weight 'B' — and what search snippets are
    drawn from: a page's published text (never its draft, so an edited
    but unpublished page can't be found by its draft wording), a file's
    description plus its current version's extracted text, or '' for a
    folder — the first SEARCH_BODY_CHARS of it."""
    if kind == "page":
        body = await _page_body(db, node_id)
    elif kind == "file":
        body = await _file_body(db, node_id)
    else:
        body = ""
    return body[:SEARCH_BODY_CHARS]


_REFRESH_SEARCH_SQL = text("""
    UPDATE wiki_nodes SET search_tsv =
        setweight(to_tsvector('english', title), 'A') ||
        setweight(to_tsvector('english', :body), 'B')
    WHERE id = :node_id
""")


def _too_long_for_tsvector(exc: DBAPIError) -> bool:
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    return code == _PROGRAM_LIMIT_EXCEEDED or "too long for tsvector" in str(exc)


async def refresh_search(db: AsyncSession, node_id: uuid.UUID) -> None:
    """Recompute a node's `search_tsv` from its title (weight A) and its
    indexed body (weight B, see `body_text`). Every node gets one when
    it's created (`tree.create_node`, a space's home page); call this
    again after publish, a title rename, an upload completing (the new
    node and, on a new version, the file it belongs to), a file's
    description changing, a file version restore, a copy (each new
    node), and — the worker — text extraction finishing. Pending ORM
    changes (a rename) are flushed first, so the title indexed is the
    new one. A body too rich for a tsvector is indexed shorter, and at
    worst the node is indexed by its title alone — never an error. A
    no-op for a node that's gone (a caller racing a delete, say)."""
    await db.flush()
    node = await db.get(WikiNode, node_id)
    if node is None:
        return
    body = await body_text(db, node.id, node.kind)
    for cap in (None, *_FALLBACK_BODY_CHARS):
        try:
            async with db.begin_nested():
                await db.execute(_REFRESH_SEARCH_SQL, {
                    "node_id": node_id, "body": body if cap is None else body[:cap]})
            return
        except DBAPIError as exc:
            if cap == 0 or not _too_long_for_tsvector(exc):
                raise


_BACKFILL_SQL = text("""
    UPDATE wiki_nodes SET search_tsv = setweight(to_tsvector('english', title), 'A')
    WHERE search_tsv IS NULL
""")


async def backfill_search_vectors(db: AsyncSession) -> int:
    """Index, by title, every node that has no `search_tsv` yet — nodes
    created before every node was indexed at creation (folders, pages
    never published, space home pages). Their body is empty, so the title
    is all there is to index; anything with a body got a vector when it
    gained one. The worker runs this at start-up; returns how many rows
    it touched (0 once there's nothing left)."""
    result = await db.execute(_BACKFILL_SQL)
    return result.rowcount


# ── search ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SearchHit:
    """One ranked, permission-filtered result — `routes/wiki/search.py`
    turns this into the API's `SearchHit` schema."""
    node_id: uuid.UUID
    kind: str
    title: str
    space_key: str
    space_name: str
    snippet_html: str
    breadcrumbs: list[str]


@dataclass
class _Candidate:
    """A ranked row straight from the candidate query — enough to stand
    in for a `WikiNode` when asking `AccessIndex` for its level (it only
    ever reads `.id`/`.space_id`/`.path`), and to build the eventual hit."""
    id: uuid.UUID
    kind: str
    title: str
    space_id: uuid.UUID
    path: list[uuid.UUID]
    space_key: str
    space_name: str


async def _node_grant_space_ids(db: AsyncSession, ix: AccessIndex) -> set[uuid.UUID]:
    """Space ids reachable only through a node-level grant — someone
    handed access to one page inside an otherwise-private space (no
    space-level grant at all) must still be able to find it by search,
    since they can already open it by link. One query over every
    node-level grant, filtered in Python with the same `grant_matches`
    rule `AccessIndex` itself uses. `levels_for_nodes` is still the
    authority on which *nodes* actually come back — this only decides
    which spaces are worth running the candidate query against."""
    if not ix.p.can_view_wiki or ix.p.is_admin:
        # an admin already gets every space back from `levels_for_spaces`
        # (AccessIndex short-circuits admins to "manage" everywhere), so
        # there's nothing this widens for them.
        return set()
    rows = (await db.execute(
        select(WikiGrant.space_id, WikiGrant.principal_type, WikiGrant.principal_id)
        .where(WikiGrant.node_id.is_not(None)))).all()
    return {sid for sid, ptype, pid in rows if grant_matches(ix.p, ptype, pid)}


async def _space_ids_for(db: AsyncSession, ix: AccessIndex,
                         space_key: str | None) -> list[uuid.UUID] | None:
    """The space ids to search: just the one named by `space_key` — None
    when it doesn't exist, or the caller has neither a space-level grant
    on it nor a node-level grant reaching into it, so an unknown key
    looks exactly like an unviewable one and can't be used to probe for
    a space's existence — or every space the caller can view at all,
    either at the space level or only through a node-level grant
    (archived spaces included: their read-only content still turns up
    in search). None (rather than an empty list) means "search nothing"."""
    if space_key is not None:
        space = await db.scalar(select(WikiSpace).where(WikiSpace.key == space_key.strip()))
        if space is None:
            return None
        if await ix.level_for_space(space.id) is not None:
            return [space.id]
        node_grant_spaces = await _node_grant_space_ids(db, ix)
        return [space.id] if space.id in node_grant_spaces else None

    all_ids = (await db.scalars(select(WikiSpace.id))).all()
    levels = await ix.levels_for_spaces(all_ids)
    viewable = {sid for sid, level in levels.items() if level is not None}
    viewable |= await _node_grant_space_ids(db, ix)
    return list(viewable) or None


async def _candidates(db: AsyncSession, q: str, *, space_ids: list[uuid.UUID],
                      kind: str | None, fetch_limit: int) -> list[_Candidate]:
    """Nodes matching `q` by full text or (case-insensitively) by title
    typo, title matches first, ranked, live nodes in `space_ids` only —
    permission filtering beyond the space level happens in `search`."""
    tsquery = func.websearch_to_tsquery("english", q)
    similarity = func.similarity(func.lower(WikiNode.title), func.lower(q))
    rank = func.ts_rank_cd(WikiNode.search_tsv, tsquery)
    stmt = (
        select(WikiNode.id, WikiNode.kind, WikiNode.title, WikiNode.space_id,
              WikiNode.path, WikiSpace.key, WikiSpace.name)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .where(WikiNode.deleted_at.is_(None),
              WikiNode.space_id.in_(space_ids),
              or_(WikiNode.search_tsv.op("@@")(tsquery),
                  similarity > _TITLE_SIMILARITY_THRESHOLD)))
    if kind is not None:
        stmt = stmt.where(WikiNode.kind == kind)
    stmt = (stmt.order_by(WikiNode.title.ilike(f"{q}%").desc(), (rank + similarity).desc())
           .limit(fetch_limit))
    rows = (await db.execute(stmt)).all()
    return [_Candidate(id=r.id, kind=r.kind, title=r.title, space_id=r.space_id,
                       path=list(r.path or []), space_key=str(r.key), space_name=r.name)
           for r in rows]


async def _unpublished_view_only_page_ids(
        db: AsyncSession, candidates: list[_Candidate],
        levels: dict[uuid.UUID, str | None]) -> set[uuid.UUID]:
    """Page ids to drop: a page a view-only caller can't see at all
    unless it's published (an editor sees it regardless — the never-
    published page's `search_tsv` only ever carries its title anyway,
    since `body_text` gives an unpublished page no body, so this is the
    only extra filtering "editors find it by title only" needs)."""
    view_only_pages = [c.id for c in candidates
                       if c.kind == "page"
                       and level_rank(levels.get(c.id)) < level_rank("edit")]
    if not view_only_pages:
        return set()
    published = set((await db.scalars(
        select(WikiPage.node_id).where(
            WikiPage.node_id.in_(view_only_pages),
            WikiPage.published_version_id.is_not(None)))).all())
    return {nid for nid in view_only_pages if nid not in published}


async def _breadcrumbs_for(db: AsyncSession, ix: AccessIndex,
                           hits: list[_Candidate]) -> dict[uuid.UUID, list[str]]:
    """Titles of each hit's viewable ancestors, root first — an ancestor
    the caller can't see is skipped entirely (no placeholder)."""
    ancestor_ids = {aid for c in hits for aid in c.path}
    if not ancestor_ids:
        return {c.id: [] for c in hits}
    ancestors = {n.id: n for n in (await db.scalars(
        select(WikiNode).where(WikiNode.id.in_(ancestor_ids)))).all()}
    levels = await ix.levels_for_nodes(list(ancestors.values()))
    return {
        c.id: [ancestors[aid].title for aid in c.path
              if aid in ancestors and levels.get(aid) is not None]
        for c in hits
    }


async def _snippet_for(db: AsyncSession, q: str, candidate: _Candidate) -> str:
    """An HTML-safe snippet of `candidate`'s indexed body around `q`'s
    matches: the same text `refresh_search` indexes, escaped, THEN run
    through `ts_headline` — not the other way around. Postgres's default
    text search parser recognizes a literal `<...>` as an HTML tag token
    and drops it from headline output entirely, so escaping afterward
    would be too late to make wiki text like "the <script> tag" survive
    at all, let alone survive safely; escaping first leaves no raw angle
    bracket for the parser to treat as markup. `<mark>`/`</mark>` — the
    one place any HTML reaches the client — are substituted in last, for
    the control characters `_HEADLINE_OPTIONS` asks `ts_headline` to
    wrap matches in (chosen because `html.escape` never produces them,
    so they can't collide with anything the escape step generated)."""
    # the mark sentinels (and every other C0 control but tab and
    # newline) can't be in the text, or a stray one would become a mark
    body = CONTROL_CHARS.sub("", await body_text(db, candidate.id, candidate.kind))
    raw = await db.scalar(select(func.ts_headline(
        "english", html.escape(body), func.websearch_to_tsquery("english", q),
        _HEADLINE_OPTIONS))) or ""
    return raw.replace(_MARK_START, "<mark>").replace(_MARK_STOP, "</mark>")


async def search(db: AsyncSession, ix: AccessIndex, q: str, *,
                 space_key: str | None = None, kind: str | None = None,
                 limit: int = 20) -> list[SearchHit]:
    """Ranked, permission-filtered search hits for `q` (stripped; 1-200
    chars, else 422 `bad_query`). `kind`, when given, must be one of
    `KINDS` (else 422 `bad_kind`). `space_key` restricts to one space by
    key; an unknown or unviewable key returns an empty list rather than
    a 404, so it can't be used to probe for a space's existence."""
    q = (q or "").strip()
    if not 1 <= len(q) <= 200:
        raise _err(422, "bad_query", "Search terms must be 1-200 characters.")
    if kind is not None and kind not in KINDS:
        raise _err(422, "bad_kind", "kind must be folder, page, or file.")

    space_ids = await _space_ids_for(db, ix, space_key)
    if space_ids is None:
        return []

    candidates = await _candidates(db, q, space_ids=space_ids, kind=kind,
                                   fetch_limit=limit * _CANDIDATE_FANOUT)
    if not candidates:
        return []
    levels = await ix.levels_for_nodes(candidates)
    excluded = await _unpublished_view_only_page_ids(db, candidates, levels)
    hits = [c for c in candidates
           if levels.get(c.id) is not None and c.id not in excluded][:limit]
    if not hits:
        return []

    breadcrumbs = await _breadcrumbs_for(db, ix, hits)
    return [
        SearchHit(
            node_id=c.id, kind=c.kind, title=c.title, space_key=c.space_key,
            space_name=c.space_name, snippet_html=await _snippet_for(db, q, c),
            breadcrumbs=breadcrumbs[c.id])
        for c in hits
    ]
