"""/edge/* — the laptop's own endpoints (identity now; status and admin
actions in Task 7)."""

from fastapi import APIRouter, Request

router = APIRouter(prefix="/edge")


@router.get("/identity")
async def get_identity(request: Request) -> dict:
    ident = request.app.state.identity
    return {"serial": ident.serial, "name": ident.name}
