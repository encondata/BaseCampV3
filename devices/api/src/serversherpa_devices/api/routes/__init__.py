"""JSON routes, mounted under /api by api.app."""

from fastapi import HTTPException


def api_error(status: int, code: str, message: str, **extra) -> HTTPException:
    """An error in the shape the auth deps use: detail = {code, message, ...}."""
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})
