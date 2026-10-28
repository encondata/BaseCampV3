"""The languages the learn site offers (public: the sign-in page shows the
picker): the ones switched on in learning settings, English first."""
from fastapi import APIRouter
from pydantic import BaseModel

from serversherpa.api.deps import DbSession
from serversherpa.learning import languages
from serversherpa.learning.settings import load_settings

router = APIRouter()


class LearnLanguageOut(BaseModel):
    code: str
    rtl: bool


@router.get("/languages", response_model=list[LearnLanguageOut])
async def offered_languages(db: DbSession) -> list[LearnLanguageOut]:
    enabled = (await load_settings(db)).languages
    return [LearnLanguageOut(code=code, rtl=languages.CATALOG[code])
            for code in languages.offered(enabled)]
