"""spec-lookup-worker: claim order, private re-check, success/record,
retry backoff, not-configured, refusal, sweep."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from serversherpa.spec_lookup import jobs, worker
from serversherpa.spec_lookup.provider import (
    Finding, LookupResult, ProviderFailed, ProviderNotConfigured, ProviderRetryable,
)

URL = "https://www.hpe.com/a"


class FakeProvider:
    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = []

    async def lookup(self, **kw):
        self.calls.append(kw)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    async def ping(self):
        return None

    async def aclose(self):
        return None


OK = LookupResult(findings=[Finding("ru_size", "1", None, "1U", URL)],
                  seen_urls={URL}, input_tokens=10, output_tokens=5, search_count=1)


async def _setup(db, **kw):
    m = AssetModel(make="HPE", model="DL320", **kw)
    db.add(m)
    await db.flush()
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.commit()
    return m, job


async def _reload(db, cls, id_):
    return await db.scalar(select(cls).where(cls.id == id_).execution_options(populate_existing=True))


async def test_claim_order_priority_then_age(db):
    a = AssetModel(make="A", model="a")
    b = AssetModel(make="B", model="b")
    c = AssetModel(make="C", model="c")
    db.add_all([a, b, c])
    await db.flush()
    db.add(SpecLookupJob(model_id=a.id, priority=0))
    db.add(SpecLookupJob(model_id=b.id, priority=20))
    db.add(SpecLookupJob(model_id=c.id, priority=20,
                         next_attempt_at=datetime.now(UTC) + timedelta(minutes=5)))
    await db.commit()
    job = await jobs.claim_next(db)
    assert job.model_id == b.id and job.status == "running"


async def test_success_records_suggestions(db):
    m, job = await _setup(db)
    p = FakeProvider(OK)
    assert await worker.run_once(get_sessionmaker(), provider_factory=lambda: p) is True
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "done" and job.finished_at is not None and job.search_count == 1
    assert p.calls[0]["make"] == "HPE" and p.calls[0]["fields"][0] == "ru_size"
    assert (await db.scalar(select(SpecSuggestion))).value == "1"


async def test_private_is_never_sent(db):
    m, job = await _setup(db, private=True)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert p.calls == [] and job.status == "done" and job.error == "private"


async def test_nothing_wanted_finishes_without_a_call(db):
    m, job = await _setup(db, ru_size=1, weight_lbs=1, weight_kg=0.45, length_in=1,
                          length_cm=2.54, width_in=1, width_cm=2.54, height_in=1, height_cm=2.54)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert p.calls == []
    assert (await _reload(db, SpecLookupJob, job.id)).error == "nothing_to_look_up"


async def test_retryable_backs_off_then_fails(db):
    m, job = await _setup(db)
    p = FakeProvider(ProviderRetryable("RateLimitError"))
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "queued" and job.attempts == 1 and job.next_attempt_at is not None
    assert (await _reload(db, AssetModel, m.id)).specs_looked_up_at is None
    job.attempts = worker.MAX_ATTEMPTS - 1
    job.next_attempt_at = None
    await db.commit()
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert (await _reload(db, SpecLookupJob, job.id)).status == "failed"


async def test_retries_exhausted_model_is_not_swept_again(db):
    from serversherpa.db.models import SystemConfig
    m, job = await _setup(db)
    p = FakeProvider(ProviderRetryable("RateLimitError"))
    job.attempts = worker.MAX_ATTEMPTS - 1
    await db.commit()
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed"
    db.add(SystemConfig(section="ai_lookup", data={"background_enabled": True}))
    await db.commit()
    assert await worker.sweep(db, provider_configured=True) == 0


async def test_skip_flag_finishes_without_a_call(db):
    m, job = await _setup(db, spec_lookup_skip=True)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert p.calls == []
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "done" and job.error == "skipped"


async def test_crash_in_record_result_finishes_failed_with_no_suggestions(db, monkeypatch):
    m, job = await _setup(db)
    p = FakeProvider(OK)

    async def _boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr("serversherpa.spec_lookup.worker.service.record_result", _boom)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed" and job.error.startswith("worker_error")
    assert (await db.scalar(select(SpecSuggestion))) is None


async def test_not_configured_and_refusal(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: None)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed" and job.error == "not_configured"
    m2 = AssetModel(make="X", model="y")
    db.add(m2)
    await db.flush()
    job2 = SpecLookupJob(model_id=m2.id)
    db.add(job2)
    await db.commit()
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderFailed("refusal")))
    job2 = await _reload(db, SpecLookupJob, job2.id)
    assert job2.status == "failed" and job2.error == "refusal"
    assert (await _reload(db, AssetModel, m2.id)).specs_looked_up_at is not None


async def test_401_mid_run_is_not_configured(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderNotConfigured("x")))
    assert (await _reload(db, SpecLookupJob, job.id)).error == "not_configured"


async def test_sweep_respects_toggle_and_configuration(db):
    from serversherpa.db.models import SystemConfig
    db.add(AssetModel(make="HPE", model="DL320"))
    await db.commit()
    assert await worker.sweep(db, provider_configured=True) == 0          # background off by default
    db.add(SystemConfig(section="ai_lookup", data={"background_enabled": True}))
    await db.commit()
    assert await worker.sweep(db, provider_configured=False) == 0
    assert await worker.sweep(db, provider_configured=True) == 1
