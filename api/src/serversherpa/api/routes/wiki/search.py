"""`GET /wiki/search`: full-text and fuzzy title search across the
spaces the caller can view. Ranking, permission filtering and snippet
generation all live in `wiki.search`; this module only shapes the query
params and the response (`wiki.search.search` already raises the 422s
for a bad `q`/`kind` — nothing here needs to re-check them)."""
from __future__ import annotations

from fastapi import APIRouter, Query

from serversherpa.api.routes.wiki.deps import WikiContext
from serversherpa.api.routes.wiki.schemas import SearchHit, SearchHitNode
from serversherpa.wiki.search import search as run_search

router = APIRouter()


@router.get("/search", response_model=list[SearchHit])
async def search(ctx: WikiContext, q: str = Query(""), space: str | None = None,
                 kind: str | None = None,
                 limit: int = Query(20, ge=1, le=50)) -> list[SearchHit]:
    hits = await run_search(ctx.db, ctx.ix, q, space_key=space, kind=kind, limit=limit)
    return [
        SearchHit(
            node=SearchHitNode(id=h.node_id, kind=h.kind, title=h.title,
                              space_key=h.space_key, space_name=h.space_name),
            snippet_html=h.snippet_html, breadcrumbs=h.breadcrumbs)
        for h in hits
    ]
